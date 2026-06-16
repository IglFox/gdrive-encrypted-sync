/**
 * Типы и интерфейсы для плагина Google Drive Encrypted Sync
 */

// ============================================================
// Стратегии разрешения конфликтов (объявляем до PluginSettings)
// ============================================================

export enum ConflictStrategy {
	CreateCopy = 'create_copy',
	KeepNewer = 'keep_newer',
	KeepLocal = 'keep_local',
	KeepRemote = 'keep_remote',
}

// ============================================================
// Настройки плагина
// ============================================================

export interface PluginSettings {
	/** Google OAuth2 Client ID */
	clientId: string;
	/** Google OAuth2 Client Secret */
	clientSecret: string;
	/** Хеш пароля шифрования (SHA-256) для верификации */
	passwordHash: string;
	/** Соль для PBKDF2 (base64) */
	encryptionSalt: string;
	/** Интервал автосинхронизации в минутах (0 = отключено) */
	autoSyncInterval: number;
	/** Синхронизировать при запуске Obsidian */
	syncOnStartup: boolean;
	/** Glob-паттерны исключений */
	excludePatterns: string[];
	/** Стратегия разрешения конфликтов */
	conflictResolution: ConflictStrategy;
	/** Показывать уведомления о синхронизации */
	showNotifications: boolean;
	/** ID корневой папки синхронизации на Google Drive */
	driveSyncFolderId: string;
	/** ID файла манифеста на Google Drive */
	driveManifestFileId: string;
	/** Включить защиту от массового удаления (>50% файлов) */
	enableDeletionGuard: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	clientId: '',
	clientSecret: '',
	passwordHash: '',
	encryptionSalt: '',
	autoSyncInterval: 5,
	syncOnStartup: true,
	excludePatterns: ['.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.trash/**'],
	conflictResolution: ConflictStrategy.KeepNewer,
	showNotifications: true,
	driveSyncFolderId: '',
	driveManifestFileId: '',
	enableDeletionGuard: true,
};

// ============================================================
// Шифрование
// ============================================================

/** Версия формата шифрования */
export const ENCRYPTION_FORMAT_VERSION = 1;

/** Размер IV для AES-GCM в байтах */
export const AES_GCM_IV_LENGTH = 12;

/** Длина ключа AES в битах */
export const AES_KEY_LENGTH = 256;

/** Количество итераций PBKDF2 */
export const PBKDF2_ITERATIONS = 600_000;

/** Зашифрованные данные */
export interface EncryptedPayload {
	/** Версия формата */
	version: number;
	/** Initialization Vector (base64) */
	iv: string;
	/** Зашифрованные данные (base64) */
	ciphertext: string;
}

// ============================================================
// OAuth2
// ============================================================

export interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // Unix timestamp (ms)
}

export interface OAuthConfig {
	clientId: string;
	clientSecret: string;
}

// ============================================================
// Google Drive
// ============================================================

export interface DriveFileMetadata {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string; // ISO 8601
	size?: string;
	parents?: string[];
	trashed?: boolean;
	appProperties?: Record<string, string>;
}

export interface DriveFileList {
	files: DriveFileMetadata[];
	nextPageToken?: string;
}

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SYNC_FOLDER_NAME = 'ObsidianEncryptedSync';
export const MANIFEST_FILE_NAME = '.sync-manifest.enc';

// ============================================================
// Состояние синхронизации
// ============================================================

export interface FileState {
	/** Путь файла в хранилище */
	vaultPath: string;
	/** SHA-256 хеш содержимого (до шифрования) */
	contentHash: string;
	/** ID файла на Google Drive */
	driveFileId: string;
	/** Зашифрованное имя файла на Drive */
	encryptedName: string;
	/** Время последней синхронизации (ISO 8601) */
	lastSyncTime: string;
	/** modifiedTime на Drive при последней синхронизации */
	driveModifiedTime: string;
	/** Размер файла в байтах */
	size: number;
}

export interface SyncState {
	/** Версия формата состояния */
	version: number;
	/** Маппинг: vaultPath → FileState */
	files: Record<string, FileState>;
	/** Время последней полной синхронизации */
	lastFullSync: string;
}

export const getEmptySyncState = (): SyncState => ({
	version: 1,
	files: {},
	lastFullSync: '',
});

// ============================================================
// Манифест (хранится на Drive)
// ============================================================

export interface SyncManifest {
	/** Версия формата манифеста */
	version: number;
	/** Маппинг: encryptedName → { vaultPath (зашифрован), driveFileId } */
	entries: ManifestEntry[];
	/** Время последнего обновления манифеста */
	updatedAt: string;
}

export interface ManifestEntry {
	/** Зашифрованное имя файла */
	encryptedName: string;
	/** Зашифрованный путь в хранилище (для обратного маппинга) */
	encryptedVaultPath: string;
	/** ID файла на Google Drive */
	driveFileId: string;
	/** SHA-256 хеш содержимого на момент загрузки */
	contentHash: string;
}

// ============================================================
// Синхронизация — результаты и действия
// ============================================================

export enum SyncAction {
	Upload = 'upload',
	Download = 'download',
	DeleteLocal = 'delete_local',
	DeleteRemote = 'delete_remote',
	Conflict = 'conflict',
	Skip = 'skip',
}

// ConflictStrategy — объявлен выше, перед PluginSettings

export interface SyncPlan {
	actions: SyncPlanAction[];
	conflicts: SyncConflict[];
}

export interface SyncPlanAction {
	action: SyncAction;
	vaultPath: string;
	driveFileId?: string;
	reason: string;
}

export interface SyncConflict {
	vaultPath: string;
	localModifiedTime: number;
	remoteModifiedTime: number;
	driveFileId: string;
}

export interface SyncResult {
	success: boolean;
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
	errors: SyncError[];
	duration: number; // ms
}

export interface SyncError {
	vaultPath: string;
	action: SyncAction;
	message: string;
}

export enum SyncStatus {
	Idle = 'idle',
	Syncing = 'syncing',
	Error = 'error',
	NoConnection = 'no_connection',
	NotConfigured = 'not_configured',
}

// ============================================================
// Логирование
// ============================================================

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
}
