/**
 * Google Drive Encrypted Sync — плагин для Obsidian.
 *
 * Двусторонняя синхронизация хранилища через Google Drive
 * с end-to-end шифрованием AES-256-GCM на стороне клиента.
 *
 * Точка входа плагина.
 */

import { Notice, Plugin } from 'obsidian';
import {
	PluginSettings,
	DEFAULT_SETTINGS,
	OAuthTokens,
	SyncStatus,
	SyncResult,
	getEmptySyncState,
} from './types';
import { CryptoService } from './crypto';
import { OAuthManager } from './oauth';
import { GoogleDriveClient } from './google-drive';
import { StateTracker } from './state-tracker';
import { SyncEngine } from './sync-engine';
import { GDriveSyncSettingTab } from './settings';
import { SyncStatusModal } from './ui/sync-status-modal';
import { logger } from './logger';
import { normalizePath, formatDateTime } from './utils';

/** Ключ для хранения токенов в data.json */
const TOKENS_KEY = '__oauth_tokens__';

export default class GDriveSyncPlugin extends Plugin {
	settings!: PluginSettings;
	private cryptoService!: CryptoService;
	private oauthManager!: OAuthManager;
	private driveClient!: GoogleDriveClient;
	private stateTracker!: StateTracker;
	private syncEngine!: SyncEngine;

	private autoSyncIntervalId: ReturnType<typeof setInterval> | null = null;
	private statusBarEl: HTMLElement | null = null;
	private lastSyncResult: SyncResult | null = null;
	private savedTokens: OAuthTokens | null = null;

	// ============================================================
	// Жизненный цикл плагина
	// ============================================================

	async onload() {
		logger.info('Загрузка плагина Google Drive Encrypted Sync...');

		// Загружаем настройки
		await this.loadSettings();

		// Инициализируем модули
		this.cryptoService = new CryptoService();
		this.oauthManager = new OAuthManager(this);
		this.driveClient = new GoogleDriveClient(this.oauthManager);

		const pluginDir = normalizePath(
			`${this.app.vault.configDir}/plugins/gdrive-encrypted-sync`,
		);

		this.stateTracker = new StateTracker(
			this.app,
			this.cryptoService,
			pluginDir,
			this.settings.excludePatterns,
		);

		this.syncEngine = new SyncEngine(
			this.app,
			this.cryptoService,
			this.driveClient,
			this.oauthManager,
			this.stateTracker,
			this.settings,
		);

		// Настраиваем колбэки для UI
		this.syncEngine.onStatusChange = (status) => this.updateStatusBar(status);
		this.syncEngine.onProgressChange = (current, total, file) => {
			this.updateStatusBar(SyncStatus.Syncing, `${current}/${total}`);
		};

		// Регистрируем OAuth protocol handler
		this.oauthManager.registerProtocolHandler();

		// Восстанавливаем OAuth токены
		this.loadTokens();

		// Настраиваем OAuth конфиг
		if (this.settings.clientId && this.settings.clientSecret) {
			this.oauthManager.setConfig({
				clientId: this.settings.clientId,
				clientSecret: this.settings.clientSecret,
			});
		}

		// Инициализируем шифрование (если пароль уже был установлен)
		// Примечание: реальная инициализация ключа произойдёт при первой синхронизации

		// Загружаем состояние синхронизации
		await this.stateTracker.loadState();

		// ---- Ribbon Icon ----
		this.addRibbonIcon('cloud', 'Синхронизировать с Google Drive', async () => {
			if (!this.isReady()) {
				new Notice('Настройте подключение к Google Drive и пароль шифрования');
				return;
			}
			await this.syncNow();
		});

		// ---- Status Bar ----
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar(
			this.isReady() ? SyncStatus.Idle : SyncStatus.NotConfigured,
		);

		// Клик на статус-бар открывает модальное окно
		this.statusBarEl.onClickEvent(() => {
			new SyncStatusModal(
				this.app,
				this.syncEngine.status,
				this.lastSyncResult,
				this.syncEngine.lastSyncTime,
				this.syncEngine.progress,
			).open();
		});

		// ---- Команды ----
		this.addCommand({
			id: 'gdrive-sync-now',
			name: 'Синхронизировать сейчас',
			callback: async () => {
				await this.syncNow();
			},
		});

		this.addCommand({
			id: 'gdrive-sync-status',
			name: 'Статус синхронизации',
			callback: () => {
				new SyncStatusModal(
					this.app,
					this.syncEngine.status,
					this.lastSyncResult,
					this.syncEngine.lastSyncTime,
					this.syncEngine.progress,
				).open();
			},
		});

		this.addCommand({
			id: 'gdrive-connect',
			name: 'Подключить Google Drive',
			callback: async () => {
				try {
					await this.connect();
					new Notice('Google Drive подключён!');
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					new Notice(`Ошибка: ${msg}`);
				}
			},
		});

		this.addCommand({
			id: 'gdrive-disconnect',
			name: 'Отключить Google Drive',
			callback: () => {
				this.disconnect();
				new Notice('Google Drive отключён');
			},
		});

		this.addCommand({
			id: 'gdrive-full-resync',
			name: 'Полная пересинхронизация',
			callback: async () => {
				await this.fullResync();
			},
		});

		// ---- Settings Tab ----
		this.addSettingTab(new GDriveSyncSettingTab(this.app, this));

		// ---- Автосинхронизация ----
		this.startAutoSync();

		// ---- Синхронизация при запуске ----
		if (this.settings.syncOnStartup && this.isReady()) {
			// Задержка 3 секунды, чтобы Obsidian полностью загрузился
			setTimeout(async () => {
				logger.info('Синхронизация при запуске...');
				await this.syncNow();
			}, 3000);
		}

		logger.info('Плагин загружен');
	}

	onunload() {
		logger.info('Выгрузка плагина...');
		this.stopAutoSync();
		this.cryptoService.destroy();
	}

	// ============================================================
	// Публичный API (используется из Settings и команд)
	// ============================================================

	/**
	 * Проверяет, подключён ли Google Drive.
	 */
	isConnected(): boolean {
		return this.oauthManager.isAuthenticated;
	}

	/**
	 * Проверяет, готов ли плагин к синхронизации.
	 */
	isReady(): boolean {
		return this.isConnected() && !!this.settings.passwordHash && !!this.settings.encryptionSalt;
	}

	/**
	 * Подключение к Google Drive через OAuth.
	 */
	async connect(): Promise<void> {
		if (!this.settings.clientId || !this.settings.clientSecret) {
			throw new Error('Введите Client ID и Client Secret в настройках плагина');
		}

		this.oauthManager.setConfig({
			clientId: this.settings.clientId,
			clientSecret: this.settings.clientSecret,
		});

		const tokens = await this.oauthManager.authorize();
		await this.saveTokens(tokens);
	}

	/**
	 * Отключение Google Drive.
	 */
	disconnect(): void {
		this.oauthManager.disconnect();
		this.savedTokens = null;
		this.saveSettings();
		this.updateStatusBar(SyncStatus.NotConfigured);
	}

	/**
	 * Настройка шифрования (вызывается из Settings).
	 */
	async setupEncryption(password: string): Promise<void> {
		// Генерируем или используем существующую соль
		if (!this.settings.encryptionSalt) {
			this.settings.encryptionSalt = this.cryptoService.generateSalt();
		}

		// Инициализируем крипто-сервис
		await this.cryptoService.init(password, this.settings.encryptionSalt);

		// Сохраняем хеш пароля для верификации
		this.settings.passwordHash = await this.cryptoService.hashPassword(
			password,
			this.settings.encryptionSalt,
		);

		await this.saveSettings();
		logger.info('Шифрование настроено');
	}

	/**
	 * Синхронизировать сейчас.
	 */
	async syncNow(): Promise<void> {
		if (!this.isReady()) {
			new Notice('Настройте подключение и пароль шифрования');
			return;
		}

		// Инициализируем шифрование если ещё не сделано
		if (!this.cryptoService.isInitialized) {
			// В текущей версии пароль не кешируется между сессиями.
			// Пользователю нужно ввести его при первой синхронизации после запуска.
			new Notice('Введите пароль шифрования для начала синхронизации');
			return;
		}

		this.lastSyncResult = await this.syncEngine.sync();
	}

	/**
	 * Полная пересинхронизация.
	 */
	async fullResync(): Promise<void> {
		logger.info('Запуск полной пересинхронизации...');
		this.stateTracker.setState(getEmptySyncState());
		await this.stateTracker.saveState();
		await this.syncNow();
	}

	/**
	 * Перезапуск автосинхронизации (при изменении интервала).
	 */
	restartAutoSync(): void {
		this.stopAutoSync();
		this.startAutoSync();
	}

	// ============================================================
	// Настройки
	// ============================================================

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

		// Загружаем токены
		if (data?.[TOKENS_KEY]) {
			this.savedTokens = data[TOKENS_KEY] as OAuthTokens;
		}
	}

	async saveSettings() {
		const dataToSave: Record<string, unknown> = { ...this.settings };

		// Сохраняем токены вместе с настройками
		if (this.savedTokens) {
			dataToSave[TOKENS_KEY] = this.savedTokens;
		}

		await this.saveData(dataToSave);
	}

	// ============================================================
	// Приватные
	// ============================================================

	/**
	 * Загрузка сохранённых OAuth токенов.
	 */
	private loadTokens(): void {
		if (this.savedTokens) {
			this.oauthManager.setTokens(this.savedTokens);
			logger.info('OAuth токены восстановлены');
		}
	}

	/**
	 * Сохранение OAuth токенов.
	 */
	private async saveTokens(tokens: OAuthTokens): Promise<void> {
		this.savedTokens = tokens;
		await this.saveSettings();
	}

	/**
	 * Запуск таймера автосинхронизации.
	 */
	private startAutoSync(): void {
		if (this.settings.autoSyncInterval <= 0) {
			logger.info('Автосинхронизация отключена');
			return;
		}

		const intervalMs = this.settings.autoSyncInterval * 60 * 1000;
		logger.info(`Автосинхронизация: каждые ${this.settings.autoSyncInterval} мин`);

		this.autoSyncIntervalId = setInterval(async () => {
			if (this.isReady() && this.cryptoService.isInitialized) {
				logger.debug('Автосинхронизация...');
				await this.syncNow();
			}
		}, intervalMs);

		// Регистрируем интервал для автоочистки при выгрузке
		this.registerInterval(this.autoSyncIntervalId as unknown as number);
	}

	/**
	 * Остановка таймера автосинхронизации.
	 */
	private stopAutoSync(): void {
		if (this.autoSyncIntervalId !== null) {
			clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}

	/**
	 * Обновление текста в статус-баре.
	 */
	private updateStatusBar(status: SyncStatus, extra?: string): void {
		if (!this.statusBarEl) return;

		let text: string;
		switch (status) {
			case SyncStatus.Idle:
				text = '☁️ Синхронизировано';
				if (this.syncEngine.lastSyncTime) {
					text += ` (${formatDateTime(this.syncEngine.lastSyncTime)})`;
				}
				break;
			case SyncStatus.Syncing:
				text = `🔄 Синхронизация${extra ? ` ${extra}` : '...'}`;
				break;
			case SyncStatus.Error:
				text = '❌ Ошибка синхронизации';
				break;
			case SyncStatus.NotConfigured:
				text = '☁️ GDrive: не настроено';
				break;
			case SyncStatus.NoConnection:
				text = '📵 Нет соединения';
				break;
			default:
				text = '☁️ GDrive Sync';
		}

		this.statusBarEl.setText(text);
	}
}
