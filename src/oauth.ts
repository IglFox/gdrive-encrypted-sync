/**
 * OAuth2 менеджер для авторизации через Google.
 *
 * Использует Obsidian Protocol Handler (obsidian://gdrive-encrypted-sync)
 * для получения authorization code из системного браузера.
 */

import { requestUrl, Plugin } from 'obsidian';
import * as http from 'http';
import { AddressInfo } from 'net';
import { OAuthTokens, OAuthConfig } from './types';
import { logger } from './logger';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

export class OAuthManager {
	private tokens: OAuthTokens | null = null;
	private config: OAuthConfig | null = null;
	private plugin: Plugin;
	private authResolve: ((code: string) => void) | null = null;
	private authReject: ((err: Error) => void) | null = null;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	/**
	 * Настройка OAuth конфигурации.
	 */
	setConfig(config: OAuthConfig): void {
		this.config = config;
	}

	/**
	 * Установка сохранённых токенов (при загрузке плагина).
	 */
	setTokens(tokens: OAuthTokens | null): void {
		this.tokens = tokens;
	}

	/**
	 * Получить текущие токены.
	 */
	getTokens(): OAuthTokens | null {
		return this.tokens;
	}

	/**
	 * Проверяет, авторизован ли пользователь.
	 */
	get isAuthenticated(): boolean {
		return this.tokens !== null && !!this.tokens.refreshToken;
	}

	/**
	 * Регистрация обработчика протокола Obsidian (больше не используется для Google из-за политики безопасности, но сохранена сигнатура).
	 */
	registerProtocolHandler(): void {
		// Больше не используется, так как Google блокирует кастомные схемы (obsidian://) для Desktop OAuth.
	}

	/**
	 * Запуск процесса авторизации.
	 * Открывает системный браузер для входа в Google.
	 * Запускает временный локальный сервер для перехвата редиректа.
	 */
	async authorize(): Promise<OAuthTokens> {
		this.ensureConfig();

		// Генерируем state для защиты от CSRF
		const state = this.generateState();

		return new Promise<OAuthTokens>((resolve, reject) => {
			const server = http.createServer(async (req, res) => {
				try {
					const url = new URL(req.url || '', `http://${req.headers.host}`);
					const code = url.searchParams.get('code');
					const error = url.searchParams.get('error');
					const receivedState = url.searchParams.get('state');

					// Игнорируем запросы к favicon или любые другие, не содержащие параметры авторизации
					if (!code && !error) {
						res.writeHead(404);
						res.end();
						return;
					}

					if (receivedState !== state) {
						res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
						res.end('<h3>Ошибка авторизации: неверный параметр state.</h3>');
						server.close();
						reject(new Error('State mismatch error during OAuth flow.'));
						return;
					}

					if (error) {
						res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
						res.end(`<h3>Ошибка авторизации Google: ${error}</h3>`);
						server.close();
						reject(new Error(`Ошибка авторизации Google: ${error}`));
						return;
					}

					if (code) {
						res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
						res.end('<h3>Авторизация успешна! Вы можете закрыть эту страницу и вернуться в Obsidian.</h3>');
						
						// Закрываем сервер сразу после успешного перехвата
						server.close();

						try {
							const tokens = await this.exchangeCodeForTokens(code, redirectUri);
							this.tokens = tokens;
							logger.info('Авторизация Google успешно завершена');
							resolve(tokens);
						} catch (tokenErr) {
							reject(tokenErr);
						}
						return;
					}

					res.writeHead(404);
					res.end();
				} catch (err) {
					res.writeHead(500);
					res.end('Internal Server Error');
					server.close();
					reject(err);
				}
			});

			let redirectUri = '';

			server.on('error', (err) => {
				reject(new Error(`Не удалось запустить локальный сервер для авторизации: ${err.message}`));
			});

			// Запускаем сервер на случайном порту (0) на loopback-интерфейсе
			server.listen(0, '127.0.0.1', () => {
				const port = (server.address() as AddressInfo).port;
				redirectUri = `http://127.0.0.1:${port}`;

				logger.info(`Локальный OAuth сервер запущен на ${redirectUri}`);

				const authUrl = new URL(GOOGLE_AUTH_URL);
				authUrl.searchParams.set('client_id', this.config!.clientId);
				authUrl.searchParams.set('redirect_uri', redirectUri);
				authUrl.searchParams.set('response_type', 'code');
				authUrl.searchParams.set('scope', SCOPES);
				authUrl.searchParams.set('access_type', 'offline');
				authUrl.searchParams.set('prompt', 'consent');
				authUrl.searchParams.set('state', state);

				logger.info('Открываем браузер для авторизации Google...');
				window.open(authUrl.toString());
			});

			// Таймаут авторизации 5 минут
			setTimeout(() => {
				if (server.listening) {
					server.close();
					reject(new Error('Превышено время ожидания авторизации. Попробуйте еще раз.'));
				}
			}, 5 * 60 * 1000);
		});
	}

	/**
	 * Получить актуальный access token.
	 * Автоматически обновляет, если истёк.
	 */
	async getAccessToken(): Promise<string> {
		if (!this.tokens) {
			throw new Error('Не авторизован. Подключите Google Drive в настройках.');
		}

		// Обновляем, если токен истекает в течение 5 минут
		if (Date.now() > this.tokens.expiresAt - 5 * 60 * 1000) {
			await this.refreshAccessToken();
		}

		return this.tokens.accessToken;
	}

	/**
	 * Отключение — удаление токенов.
	 */
	disconnect(): void {
		this.tokens = null;
		logger.info('Google Drive отключён');
	}

	// ============================================================
	// Приватные методы
	// ============================================================

	/**
	 * Обмен authorization code на access_token + refresh_token.
	 */
	private async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokens> {
		this.ensureConfig();

		const response = await requestUrl({
			url: GOOGLE_TOKEN_URL,
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				code,
				client_id: this.config!.clientId,
				client_secret: this.config!.clientSecret,
				redirect_uri: redirectUri,
				grant_type: 'authorization_code',
			}).toString(),
		});

		if (response.status !== 200) {
			throw new Error(`Ошибка обмена code на токены: ${response.status} ${response.text}`);
		}

		const data = response.json;
		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresAt: Date.now() + (data.expires_in as number) * 1000,
		};
	}

	/**
	 * Обновление access_token через refresh_token.
	 */
	private async refreshAccessToken(): Promise<void> {
		this.ensureConfig();

		if (!this.tokens?.refreshToken) {
			throw new Error('Нет refresh token. Переподключите Google Drive.');
		}

		logger.debug('Обновление access token...');

		const response = await requestUrl({
			url: GOOGLE_TOKEN_URL,
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: this.config!.clientId,
				client_secret: this.config!.clientSecret,
				refresh_token: this.tokens.refreshToken,
				grant_type: 'refresh_token',
			}).toString(),
		});

		if (response.status !== 200) {
			throw new Error(`Ошибка обновления токена: ${response.status} ${response.text}`);
		}

		const data = response.json;
		this.tokens = {
			accessToken: data.access_token,
			refreshToken: this.tokens.refreshToken, // refresh_token остаётся прежним
			expiresAt: Date.now() + (data.expires_in as number) * 1000,
		};

		logger.debug('Access token успешно обновлён');
	}

	/**
	 * Генерация случайной строки для CSRF-защиты.
	 */
	private generateState(): string {
		const array = crypto.getRandomValues(new Uint8Array(16));
		return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
	}

	private ensureConfig(): void {
		if (!this.config || !this.config.clientId || !this.config.clientSecret) {
			throw new Error(
				'OAuth не настроен. Введите Client ID и Client Secret в настройках плагина.',
			);
		}
	}
}
