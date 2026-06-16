/**
 * Отслеживание состояния файлов для синхронизации.
 *
 * Хранит хеши файлов, ID на Google Drive, и время последней синхронизации.
 * Позволяет определить, какие файлы были изменены с момента последней синхронизации.
 */

import { App, TFile, TFolder, Vault } from 'obsidian';
import { SyncState, FileState, getEmptySyncState } from './types';
import { CryptoService } from './crypto';
import { logger } from './logger';
import { normalizePath, matchesExcludePattern } from './utils';

const SYNC_STATE_FILE = 'sync-state.json';

export interface LocalFileInfo {
	path: string;
	contentHash: string;
	modifiedTime: number; // Unix timestamp ms
	size: number;
	content: ArrayBuffer;
}

export interface ChangeSet {
	/** Файлы, которые были созданы или изменены локально */
	modified: LocalFileInfo[];
	/** Файлы, которые были удалены локально (есть в state, но нет на диске) */
	deleted: string[];
	/** Все текущие локальные файлы */
	currentFiles: Map<string, LocalFileInfo>;
}

export class StateTracker {
	private app: App;
	private crypto: CryptoService;
	private state: SyncState;
	private pluginDir: string;
	private excludePatterns: string[];

	constructor(app: App, crypto: CryptoService, pluginDir: string, excludePatterns: string[]) {
		this.app = app;
		this.crypto = crypto;
		this.pluginDir = pluginDir;
		this.excludePatterns = excludePatterns;
		this.state = getEmptySyncState();
	}

	/**
	 * Получить текущее состояние синхронизации.
	 */
	getState(): SyncState {
		return this.state;
	}

	/**
	 * Установить состояние (при загрузке из файла).
	 */
	setState(state: SyncState): void {
		this.state = state;
	}

	/**
	 * Обновить паттерны исключений.
	 */
	setExcludePatterns(patterns: string[]): void {
		this.excludePatterns = patterns;
	}

	/**
	 * Загрузить состояние синхронизации из файла.
	 */
	async loadState(): Promise<void> {
		try {
			const filePath = normalizePath(`${this.pluginDir}/${SYNC_STATE_FILE}`);
			const adapter = this.app.vault.adapter;

			if (await adapter.exists(filePath)) {
				const content = await adapter.read(filePath);
				this.state = JSON.parse(content) as SyncState;
				logger.info(`Состояние загружено: ${Object.keys(this.state.files).length} файлов`);
			} else {
				this.state = getEmptySyncState();
				logger.info('Файл состояния не найден, начинаем с чистого состояния');
			}
		} catch (err) {
			logger.error('Ошибка загрузки состояния синхронизации:', err);
			this.state = getEmptySyncState();
		}
	}

	/**
	 * Сохранить состояние синхронизации в файл.
	 */
	async saveState(): Promise<void> {
		try {
			const filePath = normalizePath(`${this.pluginDir}/${SYNC_STATE_FILE}`);
			const content = JSON.stringify(this.state, null, 2);
			await this.app.vault.adapter.write(filePath, content);
			logger.debug('Состояние синхронизации сохранено');
		} catch (err) {
			logger.error('Ошибка сохранения состояния:', err);
		}
	}

	/**
	 * Сканирует хранилище и определяет изменения с момента последней синхронизации.
	 */
	async getLocalChanges(): Promise<ChangeSet> {
		const modified: LocalFileInfo[] = [];
		const currentFiles = new Map<string, LocalFileInfo>();

		// Получаем все файлы в хранилище
		const allFiles = this.app.vault.getFiles();

		for (const file of allFiles) {
			const path = normalizePath(file.path);

			// Пропускаем файлы по паттернам исключений
			if (this.shouldExclude(path)) {
				continue;
			}

			// Читаем содержимое файла
			const content = await this.app.vault.readBinary(file);
			const contentHash = await this.crypto.hash(content);

			const fileInfo: LocalFileInfo = {
				path,
				contentHash,
				modifiedTime: file.stat.mtime,
				size: file.stat.size,
				content,
			};

			currentFiles.set(path, fileInfo);

			// Проверяем, изменился ли файл
			const savedState = this.state.files[path];
			if (!savedState || savedState.contentHash !== contentHash) {
				modified.push(fileInfo);
			}
		}

		// Определяем удалённые файлы (есть в state, но нет на диске)
		const deleted: string[] = [];
		for (const path of Object.keys(this.state.files)) {
			if (!currentFiles.has(path) && !this.shouldExclude(path)) {
				deleted.push(path);
			}
		}

		logger.info(
			`Локальные изменения: ${modified.length} изменённых, ${deleted.length} удалённых ` +
			`(из ${currentFiles.size} файлов)`,
		);

		return { modified, deleted, currentFiles };
	}

	/**
	 * Обновляет состояние файла после успешной синхронизации.
	 */
	updateFileState(
		vaultPath: string,
		contentHash: string,
		driveFileId: string,
		encryptedName: string,
		driveModifiedTime: string,
		size: number,
	): void {
		this.state.files[vaultPath] = {
			vaultPath,
			contentHash,
			driveFileId,
			encryptedName,
			lastSyncTime: new Date().toISOString(),
			driveModifiedTime,
			size,
		};
	}

	/**
	 * Удаляет файл из состояния синхронизации.
	 */
	removeFileState(vaultPath: string): void {
		delete this.state.files[vaultPath];
	}

	/**
	 * Получить состояние конкретного файла.
	 */
	getFileState(vaultPath: string): FileState | undefined {
		return this.state.files[vaultPath];
	}

	/**
	 * Обновить время последней полной синхронизации.
	 */
	updateLastFullSync(): void {
		this.state.lastFullSync = new Date().toISOString();
	}

	/**
	 * Проверяет, нужно ли исключить файл из синхронизации.
	 */
	private shouldExclude(path: string): boolean {
		// Всегда исключаем служебные файлы плагина
		if (path.startsWith('.obsidian/plugins/gdrive-encrypted-sync/')) {
			return true;
		}
		return matchesExcludePattern(path, this.excludePatterns);
	}
}
