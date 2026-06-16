/**
 * Главный движок синхронизации.
 *
 * Координирует все модули: шифрование, Google Drive, отслеживание состояния,
 * разрешение конфликтов. Управляет полным циклом синхронизации.
 */

import { App, Notice, TFile } from 'obsidian';
import {
	SyncAction,
	SyncResult,
	SyncError,
	SyncStatus,
	SyncManifest,
	ManifestEntry,
	ConflictStrategy,
	PluginSettings,
	MANIFEST_FILE_NAME,
} from './types';
import { CryptoService } from './crypto';
import { GoogleDriveClient } from './google-drive';
import { OAuthManager } from './oauth';
import { StateTracker, LocalFileInfo } from './state-tracker';
import { DiffResolver, RemoteFileInfo } from './diff-resolver';
import { logger } from './logger';
import { Mutex, normalizePath, nowISO, generateConflictFileName } from './utils';

export class SyncEngine {
	private app: App;
	private crypto: CryptoService;
	private drive: GoogleDriveClient;
	private oauth: OAuthManager;
	private stateTracker: StateTracker;
	private diffResolver: DiffResolver;
	private settings: PluginSettings;

	private syncMutex = new Mutex();
	private _status: SyncStatus = SyncStatus.Idle;
	private _lastSyncTime: string = '';
	private _progress: { current: number; total: number; file: string } = {
		current: 0,
		total: 0,
		file: '',
	};

	// Колбэк для обновления UI
	onStatusChange?: (status: SyncStatus) => void;
	onProgressChange?: (current: number, total: number, file: string) => void;

	constructor(
		app: App,
		crypto: CryptoService,
		drive: GoogleDriveClient,
		oauth: OAuthManager,
		stateTracker: StateTracker,
		settings: PluginSettings,
	) {
		this.app = app;
		this.crypto = crypto;
		this.drive = drive;
		this.oauth = oauth;
		this.stateTracker = stateTracker;
		this.settings = settings;
		this.diffResolver = new DiffResolver(settings.conflictResolution);
	}

	get status(): SyncStatus {
		return this._status;
	}

	get lastSyncTime(): string {
		return this._lastSyncTime;
	}

	get progress(): { current: number; total: number; file: string } {
		return this._progress;
	}

	/**
	 * Обновить настройки (вызывается при изменении настроек).
	 */
	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
		this.diffResolver.setStrategy(settings.conflictResolution);
		this.stateTracker.setExcludePatterns(settings.excludePatterns);
	}

	/**
	 * Главный метод синхронизации.
	 */
	async sync(): Promise<SyncResult> {
		// Предотвращаем параллельные синхронизации
		if (this.syncMutex.isLocked) {
			logger.warn('Синхронизация уже выполняется, пропуск');
			return this.emptyResult();
		}

		const release = await this.syncMutex.acquire();
		const startTime = Date.now();

		try {
			this.setStatus(SyncStatus.Syncing);

			// Проверяем авторизацию
			if (!this.oauth.isAuthenticated) {
				this.setStatus(SyncStatus.NotConfigured);
				throw new Error('Google Drive не подключён');
			}

			if (!this.crypto.isInitialized) {
				this.setStatus(SyncStatus.NotConfigured);
				throw new Error('Шифрование не настроено');
			}

			// Убеждаемся, что папка синхронизации существует
			if (!this.settings.driveSyncFolderId) {
				this.settings.driveSyncFolderId = await this.drive.ensureSyncFolder();
			}

			logger.info('=== Начало синхронизации ===');

			// 1. Получаем локальные изменения
			logger.info('Шаг 1: Сканирование локальных файлов...');
			const localChanges = await this.stateTracker.getLocalChanges();

			// 2. Получаем удалённые файлы
			logger.info('Шаг 2: Получение списка файлов с Google Drive...');
			const remoteFiles = await this.getRemoteFiles();

			// 3. Строим план синхронизации
			logger.info('Шаг 3: Построение плана синхронизации...');
			const plan = this.diffResolver.buildSyncPlan(
				localChanges.modified,
				localChanges.deleted,
				remoteFiles,
				this.stateTracker.getState().files,
			);

			// ---- ЗАЩИТА ОТ МАССОВОГО УДАЛЕНИЯ (обе стороны) ----
			// Если план содержит удаление > 50% файлов (И > 5 штук) в любом направлении,
			// это, скорее всего, ошибка (пустой vault, повреждённый state, случайная очистка Drive).
			const totalSyncedFiles = Object.keys(this.stateTracker.getState().files).length;

			const deleteRemoteCount = plan.actions.filter(
				(a) => a.action === SyncAction.DeleteRemote,
			).length;
			const deleteLocalCount = plan.actions.filter(
				(a) => a.action === SyncAction.DeleteLocal,
			).length;

			const checkMassDeletion = (count: number, direction: string) => {
				if (count > 5 && totalSyncedFiles > 0 && count / totalSyncedFiles > 0.5) {
					const msg =
						`⛔ Синхронизация остановлена: план предполагает удаление ${count} из ${totalSyncedFiles} ` +
						`файлов ${direction} (>50%). Это может быть ошибкой. ` +
						`Если вы действительно удалили эти файлы, выполните «Полная пересинхронизация» в настройках плагина.`;
					logger.error(msg);
					throw new Error(msg);
				}
			};

			checkMassDeletion(deleteRemoteCount, 'на Google Drive');
			checkMassDeletion(deleteLocalCount, 'локально');

			// 4. Выполняем план
			logger.info('Шаг 4: Выполнение плана синхронизации...');
			const result = await this.executePlan(plan.actions, localChanges.currentFiles);

			// 5. Обновляем и сохраняем состояние
			this.stateTracker.updateLastFullSync();
			await this.stateTracker.saveState();

			// 6. Обновляем манифест на Drive
			logger.info('Шаг 5: Обновление манифеста на Drive...');
			await this.uploadManifest();

			this._lastSyncTime = nowISO();
			this.setStatus(SyncStatus.Idle);

			result.duration = Date.now() - startTime;

			logger.info(
				`=== Синхронизация завершена за ${result.duration}мс ===\n` +
				`  Загружено: ${result.uploaded}, Скачано: ${result.downloaded}, ` +
				`Удалено на Drive: ${result.deletedRemote}, Ошибок: ${result.errors.length}`,
			);

			if (this.settings.showNotifications) {
				if (result.errors.length > 0) {
					new Notice(
						`Синхронизация завершена с ошибками (${result.errors.length}). ` +
						`↑${result.uploaded} ↓${result.downloaded}`,
					);
				} else if (result.uploaded > 0 || result.downloaded > 0 || result.deletedRemote > 0) {
					new Notice(
						`Синхронизация: ↑${result.uploaded} ↓${result.downloaded} 🗑${result.deletedRemote}`,
					);
				}
			}

			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error('Ошибка синхронизации:', message);
			this.setStatus(SyncStatus.Error);

			if (this.settings.showNotifications) {
				new Notice(`Ошибка синхронизации: ${message}`);
			}

			return {
				...this.emptyResult(),
				success: false,
				errors: [{ vaultPath: '', action: SyncAction.Skip, message }],
				duration: Date.now() - startTime,
			};
		} finally {
			release();
		}
	}

	// ============================================================
	// Получение удалённых файлов
	// ============================================================

	/**
	 * Получает список всех файлов на Drive и расшифровывает их пути.
	 */
	private async getRemoteFiles(): Promise<RemoteFileInfo[]> {
		const driveFiles = await this.drive.listAllFiles(this.settings.driveSyncFolderId);
		const remoteFiles: RemoteFileInfo[] = [];

		for (const driveFile of driveFiles) {
			// Пропускаем манифест
			if (driveFile.name === MANIFEST_FILE_NAME) {
				this.settings.driveManifestFileId = driveFile.id;
				continue;
			}

			// Пропускаем папки
			if (driveFile.mimeType === 'application/vnd.google-apps.folder') {
				continue;
			}

			try {
				// Расшифровываем имя файла → путь в хранилище
				const encryptedName = driveFile.name.replace(/\.enc$/, '');
				const vaultPath = await this.crypto.decryptFileName(encryptedName);

				remoteFiles.push({
					vaultPath,
					driveFileId: driveFile.id,
					encryptedName: driveFile.name,
					modifiedTime: driveFile.modifiedTime,
					contentHash: driveFile.appProperties?.['contentHash'],
				});
			} catch (err) {
				logger.warn(`Не удалось расшифровать имя файла ${driveFile.name}:`, err);
			}
		}

		logger.info(`Найдено ${remoteFiles.length} файлов на Google Drive`);
		return remoteFiles;
	}

	// ============================================================
	// Выполнение плана синхронизации
	// ============================================================

	/**
	 * Выполняет план синхронизации действие за действием.
	 */
	private async executePlan(
		actions: { action: SyncAction; vaultPath: string; driveFileId?: string; reason: string }[],
		currentFiles: Map<string, LocalFileInfo>,
	): Promise<SyncResult> {
		const result: SyncResult = this.emptyResult();
		const actionableItems = actions.filter(
			(a) => a.action !== SyncAction.Skip,
		);

		this._progress = { current: 0, total: actionableItems.length, file: '' };
		this.onProgressChange?.(0, actionableItems.length, '');

		let index = 0;
		for (const action of actionableItems) {
			index++;
			this._progress = { current: index, total: actionableItems.length, file: action.vaultPath };
			this.onProgressChange?.(index, actionableItems.length, action.vaultPath);

			try {
				switch (action.action) {
					case SyncAction.Upload:
						await this.executeUpload(action.vaultPath, action.driveFileId, currentFiles);
						result.uploaded++;
						break;

					case SyncAction.Download:
						await this.executeDownload(action.vaultPath, action.driveFileId!);
						result.downloaded++;
						break;

					case SyncAction.DeleteRemote:
						await this.executeDeleteRemote(action.vaultPath, action.driveFileId!);
						result.deletedRemote++;
						break;

					case SyncAction.DeleteLocal:
						await this.executeDeleteLocal(action.vaultPath);
						result.deletedLocal++;
						break;

					case SyncAction.Conflict:
						await this.executeConflict(action.vaultPath, action.driveFileId!, currentFiles);
						result.conflicts++;
						break;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error(`Ошибка при ${action.action} ${action.vaultPath}: ${message}`);
				result.errors.push({
					vaultPath: action.vaultPath,
					action: action.action,
					message,
				});
			}
		}

		result.success = result.errors.length === 0;
		return result;
	}

	/**
	 * Загрузка файла на Google Drive.
	 */
	private async executeUpload(
		vaultPath: string,
		driveFileId: string | undefined,
		currentFiles: Map<string, LocalFileInfo>,
	): Promise<void> {
		const fileInfo = currentFiles.get(vaultPath);
		if (!fileInfo) {
			throw new Error(`Файл не найден: ${vaultPath}`);
		}

		logger.debug(`Загрузка: ${vaultPath}`);

		// Шифруем содержимое
		const encryptedContent = await this.crypto.encrypt(fileInfo.content);

		// Шифруем имя файла
		const encryptedName = await this.crypto.encryptFileName(vaultPath);
		const fileName = encryptedName + '.enc';

		const appProperties = { contentHash: fileInfo.contentHash };

		let driveFile;
		if (driveFileId) {
			try {
				// Обновляем существующий файл
				driveFile = await this.drive.updateFile(driveFileId, encryptedContent, appProperties);
			} catch (err) {
				// Если файл не найден на Drive (удалён) — создаём заново
				logger.warn(`Файл ${vaultPath} не найден на Drive (${driveFileId}), создаём заново`);
				driveFile = await this.drive.uploadFile(
					fileName,
					encryptedContent,
					this.settings.driveSyncFolderId,
					appProperties,
				);
			}
		} else {
			// Загружаем новый файл
			driveFile = await this.drive.uploadFile(
				fileName,
				encryptedContent,
				this.settings.driveSyncFolderId,
				appProperties,
			);
		}

		// Обновляем состояние
		this.stateTracker.updateFileState(
			vaultPath,
			fileInfo.contentHash,
			driveFile.id,
			fileName,
			driveFile.modifiedTime,
			fileInfo.size,
		);
	}

	/**
	 * Скачивание файла с Google Drive.
	 */
	private async executeDownload(vaultPath: string, driveFileId: string): Promise<void> {
		logger.debug(`Скачивание: ${vaultPath}`);

		// Скачиваем зашифрованные данные
		const encryptedContent = await this.drive.downloadFile(driveFileId);

		// Расшифровываем
		const content = await this.crypto.decrypt(encryptedContent);

		// Убеждаемся, что папка существует
		await this.ensureDirectoryExists(vaultPath);

		// Записываем файл
		const existingFile = this.app.vault.getAbstractFileByPath(vaultPath);
		if (existingFile instanceof TFile) {
			await this.app.vault.modifyBinary(existingFile, content);
		} else {
			await this.app.vault.createBinary(vaultPath, content);
		}

		// Обновляем состояние
		const contentHash = await this.crypto.hash(content);
		const driveMetadata = await this.drive.getFileMetadata(driveFileId);
		const encryptedName = await this.crypto.encryptFileName(vaultPath) + '.enc';

		this.stateTracker.updateFileState(
			vaultPath,
			contentHash,
			driveFileId,
			encryptedName,
			driveMetadata.modifiedTime,
			content.byteLength,
		);
	}

	/**
	 * Удаление файла на Google Drive.
	 */
	private async executeDeleteRemote(vaultPath: string, driveFileId: string): Promise<void> {
		logger.debug(`Удаление на Drive: ${vaultPath}`);
		await this.drive.deleteFile(driveFileId);
		this.stateTracker.removeFileState(vaultPath);
	}

	/**
	 * Удаление локального файла.
	 */
	private async executeDeleteLocal(vaultPath: string): Promise<void> {
		logger.debug(`Удаление локально: ${vaultPath}`);
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (file) {
			await this.app.vault.trash(file, false);
		}
		this.stateTracker.removeFileState(vaultPath);
	}

	/**
	 * Обработка конфликта (стратегия CreateCopy — скачивает удалённую версию как копию).
	 */
	private async executeConflict(
		vaultPath: string,
		driveFileId: string,
		currentFiles: Map<string, LocalFileInfo>,
	): Promise<void> {
		logger.info(`Конфликт: ${vaultPath}`);

		// Скачиваем удалённую версию
		const encryptedContent = await this.drive.downloadFile(driveFileId);
		const remoteContent = await this.crypto.decrypt(encryptedContent);

		// Сохраняем как конфликтную копию
		const conflictPath = generateConflictFileName(vaultPath);
		await this.ensureDirectoryExists(conflictPath);
		await this.app.vault.createBinary(conflictPath, remoteContent);

		// Локальную версию загружаем на Drive (она остаётся основной)
		const localFile = currentFiles.get(vaultPath);
		if (localFile) {
			await this.executeUpload(vaultPath, driveFileId, currentFiles);
		}

		logger.info(`Конфликтная копия создана: ${conflictPath}`);
		if (this.settings.showNotifications) {
			new Notice(`Конфликт: создана копия ${conflictPath}`);
		}
	}

	// ============================================================
	// Манифест
	// ============================================================

	/**
	 * Загружает зашифрованный манифест на Google Drive.
	 * Манифест содержит маппинг зашифрованных имён к путям.
	 */
	private async uploadManifest(): Promise<void> {
		const state = this.stateTracker.getState();
		const entries: ManifestEntry[] = [];

		for (const [vaultPath, fileState] of Object.entries(state.files)) {
			const encryptedVaultPath = await this.crypto.encryptToBase64(vaultPath);
			entries.push({
				encryptedName: fileState.encryptedName,
				encryptedVaultPath,
				driveFileId: fileState.driveFileId,
				contentHash: fileState.contentHash,
			});
		}

		const manifest: SyncManifest = {
			version: 1,
			entries,
			updatedAt: nowISO(),
		};

		const manifestJson = JSON.stringify(manifest);
		const encryptedManifest = await this.crypto.encrypt(manifestJson);

		if (this.settings.driveManifestFileId) {
			await this.drive.updateFile(this.settings.driveManifestFileId, encryptedManifest);
		} else {
			const file = await this.drive.uploadFile(
				MANIFEST_FILE_NAME,
				encryptedManifest,
				this.settings.driveSyncFolderId,
			);
			this.settings.driveManifestFileId = file.id;
		}

		logger.debug('Манифест обновлён на Drive');
	}

	// ============================================================
	// Вспомогательные
	// ============================================================

	private async ensureDirectoryExists(filePath: string): Promise<void> {
		const parts = filePath.split('/');
		parts.pop(); // Убираем имя файла

		if (parts.length === 0) return;

		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existing) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	private setStatus(status: SyncStatus): void {
		this._status = status;
		this.onStatusChange?.(status);
	}

	private emptyResult(): SyncResult {
		return {
			success: true,
			uploaded: 0,
			downloaded: 0,
			deletedLocal: 0,
			deletedRemote: 0,
			conflicts: 0,
			errors: [],
			duration: 0,
		};
	}
}
