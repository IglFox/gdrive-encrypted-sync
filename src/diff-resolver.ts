/**
 * Разрешение конфликтов синхронизации.
 *
 * Сравнивает локальные и удалённые изменения, формирует план действий.
 * Стратегия по умолчанию: побеждает более новая версия (KeepNewer).
 */

import {
	SyncAction,
	SyncPlanAction,
	SyncConflict,
	SyncPlan,
	ConflictStrategy,
	FileState,
	DriveFileMetadata,
} from './types';
import { LocalFileInfo } from './state-tracker';
import { logger } from './logger';

export interface RemoteFileInfo {
	/** Путь в хранилище (расшифрованный) */
	vaultPath: string;
	/** ID файла на Google Drive */
	driveFileId: string;
	/** Зашифрованное имя файла */
	encryptedName: string;
	/** Время последнего изменения на Drive */
	modifiedTime: string;
	/** Хеш содержимого (из appProperties) */
	contentHash?: string;
}

export class DiffResolver {
	private strategy: ConflictStrategy;

	constructor(strategy: ConflictStrategy = ConflictStrategy.KeepNewer) {
		this.strategy = strategy;
	}

	setStrategy(strategy: ConflictStrategy): void {
		this.strategy = strategy;
	}

	/**
	 * Формирует план синхронизации на основе локальных и удалённых изменений.
	 *
	 * @param localModified Локально изменённые/новые файлы
	 * @param localDeleted Локально удалённые файлы
	 * @param remoteFiles Все файлы на Google Drive (расшифрованные пути)
	 * @param syncState Текущее состояние синхронизации
	 */
	buildSyncPlan(
		localModified: LocalFileInfo[],
		localDeleted: string[],
		remoteFiles: RemoteFileInfo[],
		syncState: Record<string, FileState>,
	): SyncPlan {
		const actions: SyncPlanAction[] = [];
		const conflicts: SyncConflict[] = [];

		// Индексы для быстрого поиска
		const remoteByPath = new Map<string, RemoteFileInfo>();
		for (const remote of remoteFiles) {
			remoteByPath.set(remote.vaultPath, remote);
		}

		const localModifiedPaths = new Set(localModified.map((f) => f.path));
		const localDeletedPaths = new Set(localDeleted);

		// ---- 1. Обработка локально изменённых файлов ----
		for (const localFile of localModified) {
			const remote = remoteByPath.get(localFile.path);
			const savedState = syncState[localFile.path];

			if (!remote) {
				// Новый файл — нет на Drive → загрузить
				actions.push({
					action: SyncAction.Upload,
					vaultPath: localFile.path,
					reason: 'Новый локальный файл',
				});
			} else if (!savedState) {
				// Файл есть и локально, и на Drive, но нет в sync state → конфликт
				this.handleConflict(
					actions,
					conflicts,
					localFile.path,
					localFile.modifiedTime,
					new Date(remote.modifiedTime).getTime(),
					remote.driveFileId,
				);
			} else if (remote.contentHash && remote.contentHash !== savedState.contentHash) {
				// Файл изменён И локально, И на Drive → конфликт
				this.handleConflict(
					actions,
					conflicts,
					localFile.path,
					localFile.modifiedTime,
					new Date(remote.modifiedTime).getTime(),
					remote.driveFileId,
				);
			} else {
				// Файл изменён только локально → загрузить
				actions.push({
					action: SyncAction.Upload,
					vaultPath: localFile.path,
					driveFileId: remote.driveFileId,
					reason: 'Локальные изменения',
				});
			}
		}

		// ---- 2. Обработка локально удалённых файлов ----
		for (const deletedPath of localDeleted) {
			const remote = remoteByPath.get(deletedPath);
			const savedState = syncState[deletedPath];

			if (!remote) {
				// Удалён и локально, и на Drive — ничего не делать
				actions.push({
					action: SyncAction.Skip,
					vaultPath: deletedPath,
					reason: 'Удалён с обеих сторон',
				});
			} else if (savedState && remote.contentHash && remote.contentHash !== savedState.contentHash) {
				// Удалён локально, но изменён на Drive → скачать (восстановить)
				actions.push({
					action: SyncAction.Download,
					vaultPath: deletedPath,
					driveFileId: remote.driveFileId,
					reason: 'Удалён локально, но изменён на Drive — восстановление',
				});
			} else {
				// Удалён локально, не изменён на Drive → удалить на Drive
				actions.push({
					action: SyncAction.DeleteRemote,
					vaultPath: deletedPath,
					driveFileId: remote?.driveFileId,
					reason: 'Удалён локально',
				});
			}
		}

		// ---- 3. Обработка файлов, существующих только на Drive ----
		for (const remote of remoteFiles) {
			if (localModifiedPaths.has(remote.vaultPath) || localDeletedPaths.has(remote.vaultPath)) {
				continue; // Уже обработан выше
			}

			const savedState = syncState[remote.vaultPath];

			if (!savedState) {
				// Новый файл на Drive → скачать
				actions.push({
					action: SyncAction.Download,
					vaultPath: remote.vaultPath,
					driveFileId: remote.driveFileId,
					reason: 'Новый файл на Drive',
				});
			} else if (remote.contentHash && remote.contentHash !== savedState.contentHash) {
				// Файл изменён на Drive, не изменён локально → скачать
				actions.push({
					action: SyncAction.Download,
					vaultPath: remote.vaultPath,
					driveFileId: remote.driveFileId,
					reason: 'Изменён на Drive',
				});
			} else if (new Date(remote.modifiedTime).getTime() > new Date(savedState.driveModifiedTime).getTime()) {
				// modifiedTime на Drive новее (но хеш совпал или отсутствует) → скачать на всякий случай
				actions.push({
					action: SyncAction.Download,
					vaultPath: remote.vaultPath,
					driveFileId: remote.driveFileId,
					reason: 'Обновлён на Drive (по времени)',
				});
			}
			// Иначе файл не изменился → пропуск
		}

		// ---- 4. Обработка файлов, удалённых с Google Drive ----
		// Файлы, которые есть в syncState (ранее синхронизированы),
		// НЕ были удалены локально, но ОТСУТСТВУЮТ на Drive.
		// Значит они удалены с другого устройства → удаляем локально.
		const processedPaths = new Set([
			...localModifiedPaths,
			...localDeletedPaths,
			...remoteFiles.map((r) => r.vaultPath),
		]);

		for (const [path, fileState] of Object.entries(syncState)) {
			if (processedPaths.has(path)) {
				continue; // Уже обработан в секциях 1-3
			}

			// Файл есть в syncState, но нет ни в modified, ни в deleted, ни на Drive.
			// → Он существует локально без изменений, но удалён с Drive.
			if (!remoteByPath.has(path)) {
				logger.info(`Файл удалён с Google Drive, удаляем локально: ${path}`);
				actions.push({
					action: SyncAction.DeleteLocal,
					vaultPath: path,
					reason: 'Удалён с Drive — удаляем локально',
				});
			}
		}

		logger.info(
			`План синхронизации: ↑${actions.filter((a) => a.action === SyncAction.Upload).length} ` +
			`↓${actions.filter((a) => a.action === SyncAction.Download).length} ` +
			`🗑Drive:${actions.filter((a) => a.action === SyncAction.DeleteRemote).length} ` +
			`🗑Local:${actions.filter((a) => a.action === SyncAction.DeleteLocal).length} ` +
			`⚠${conflicts.length}`,
		);

		return { actions, conflicts };
	}

	/**
	 * Обрабатывает конфликт согласно выбранной стратегии.
	 */
	private handleConflict(
		actions: SyncPlanAction[],
		conflicts: SyncConflict[],
		vaultPath: string,
		localModifiedTime: number,
		remoteModifiedTime: number,
		driveFileId: string,
	): void {
		switch (this.strategy) {
			case ConflictStrategy.KeepNewer:
				if (localModifiedTime >= remoteModifiedTime) {
					actions.push({
						action: SyncAction.Upload,
						vaultPath,
						driveFileId,
						reason: 'Конфликт: локальная версия новее',
					});
				} else {
					actions.push({
						action: SyncAction.Download,
						vaultPath,
						driveFileId,
						reason: 'Конфликт: удалённая версия новее',
					});
				}
				break;

			case ConflictStrategy.KeepLocal:
				actions.push({
					action: SyncAction.Upload,
					vaultPath,
					driveFileId,
					reason: 'Конфликт: выбрана локальная версия',
				});
				break;

			case ConflictStrategy.KeepRemote:
				actions.push({
					action: SyncAction.Download,
					vaultPath,
					driveFileId,
					reason: 'Конфликт: выбрана удалённая версия',
				});
				break;

			case ConflictStrategy.CreateCopy:
				// Скачиваем удалённую версию как конфликтную копию, сохраняем локальную
				conflicts.push({
					vaultPath,
					localModifiedTime,
					remoteModifiedTime,
					driveFileId,
				});
				actions.push({
					action: SyncAction.Conflict,
					vaultPath,
					driveFileId,
					reason: 'Конфликт: создание копии',
				});
				break;
		}
	}
}
