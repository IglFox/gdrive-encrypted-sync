/**
 * Модуль клиентского шифрования для Google Drive Encrypted Sync.
 *
 * Использует Web Crypto API (доступен в Electron/Obsidian):
 * - PBKDF2 для деривации ключа из пароля
 * - AES-256-GCM для шифрования данных
 * - SHA-256 для хеширования
 *
 * Формат зашифрованных данных:
 * [1 byte: version] [12 bytes: IV] [N bytes: ciphertext + GCM auth tag (16 bytes)]
 */

import {
	ENCRYPTION_FORMAT_VERSION,
	AES_GCM_IV_LENGTH,
	AES_KEY_LENGTH,
	PBKDF2_ITERATIONS,
} from './types';
import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
	arrayBufferToBase64Url,
	base64UrlToArrayBuffer,
	concatArrayBuffers,
} from './utils';
import { logger } from './logger';

/**
 * Сервис шифрования — инкапсулирует все криптографические операции.
 */
export class CryptoService {
	private key: CryptoKey | null = null;
	private rawKeyBytes: ArrayBuffer | null = null;

	/**
	 * Инициализация: деривация ключа из пароля.
	 * Вызывается один раз при вводе пароля пользователем.
	 */
	async init(password: string, saltBase64: string): Promise<void> {
		const salt = base64ToArrayBuffer(saltBase64);
		this.key = await this.deriveKey(password, salt);
		// Экспортируем raw-ключ для хеширования имён файлов
		this.rawKeyBytes = await crypto.subtle.exportKey('raw', this.key);
		logger.info('Ключ шифрования успешно создан');
	}

	/**
	 * Проверяет, инициализирован ли сервис.
	 */
	get isInitialized(): boolean {
		return this.key !== null;
	}

	/**
	 * Очистка ключа из памяти.
	 */
	destroy(): void {
		this.key = null;
		this.rawKeyBytes = null;
	}

	// ============================================================
	// Деривация ключа
	// ============================================================

	/**
	 * Генерация случайной соли для PBKDF2.
	 * Вызывается один раз при первой настройке шифрования.
	 */
	generateSalt(): string {
		const salt = crypto.getRandomValues(new Uint8Array(32));
		return arrayBufferToBase64(salt.buffer);
	}

	/**
	 * Деривация AES-256 ключа из пароля через PBKDF2.
	 */
	private async deriveKey(password: string, salt: ArrayBuffer): Promise<CryptoKey> {
		// Импортируем пароль как ключевой материал
		const passwordKey = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(password),
			'PBKDF2',
			false,
			['deriveKey'],
		);

		// Деривируем AES-256-GCM ключ
		return crypto.subtle.deriveKey(
			{
				name: 'PBKDF2',
				salt: salt,
				iterations: PBKDF2_ITERATIONS,
				hash: 'SHA-256',
			},
			passwordKey,
			{
				name: 'AES-GCM',
				length: AES_KEY_LENGTH,
			},
			true, // extractable — нужно для экспорта raw ключа
			['encrypt', 'decrypt'],
		);
	}

	// ============================================================
	// Шифрование / Расшифровка данных
	// ============================================================

	/**
	 * Шифрует данные с помощью AES-256-GCM.
	 *
	 * @param data Данные для шифрования (ArrayBuffer или string)
	 * @returns Зашифрованный буфер: [version (1 byte)] [IV (12 bytes)] [ciphertext + auth tag]
	 */
	async encrypt(data: ArrayBuffer | string): Promise<ArrayBuffer> {
		this.ensureInitialized();

		const plaintext = typeof data === 'string'
			? new TextEncoder().encode(data).buffer
			: data;

		// Случайный IV для каждой операции шифрования
		const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));

		const ciphertext = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			this.key!,
			plaintext,
		);

		// Формируем результат: version + IV + ciphertext
		const version = new Uint8Array([ENCRYPTION_FORMAT_VERSION]);
		return concatArrayBuffers(version.buffer, iv.buffer, ciphertext);
	}

	/**
	 * Расшифровывает данные, зашифрованные методом encrypt().
	 *
	 * @param encryptedData Зашифрованный буфер
	 * @returns Расшифрованные данные (ArrayBuffer)
	 * @throws Если auth tag не совпадает (данные повреждены или неверный пароль)
	 */
	async decrypt(encryptedData: ArrayBuffer): Promise<ArrayBuffer> {
		this.ensureInitialized();

		const dataView = new Uint8Array(encryptedData);

		// Проверяем версию формата
		const version = dataView[0];
		if (version !== ENCRYPTION_FORMAT_VERSION) {
			throw new Error(`Неподдерживаемая версия формата шифрования: ${version}`);
		}

		// Извлекаем IV и ciphertext
		const iv = dataView.slice(1, 1 + AES_GCM_IV_LENGTH);
		const ciphertext = dataView.slice(1 + AES_GCM_IV_LENGTH);

		try {
			return await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv },
				this.key!,
				ciphertext,
			);
		} catch (err) {
			throw new Error(
				'Не удалось расшифровать данные. Возможные причины: неверный пароль или повреждённые данные.',
			);
		}
	}

	/**
	 * Шифрует строку и возвращает результат в base64.
	 */
	async encryptToBase64(text: string): Promise<string> {
		const encrypted = await this.encrypt(text);
		return arrayBufferToBase64(encrypted);
	}

	/**
	 * Расшифровывает строку из base64.
	 */
	async decryptFromBase64(base64: string): Promise<string> {
		const encrypted = base64ToArrayBuffer(base64);
		const decrypted = await this.decrypt(encrypted);
		return new TextDecoder().decode(decrypted);
	}

	// ============================================================
	// Шифрование имён файлов
	// ============================================================

	/**
	 * Шифрует имя файла/путь → base64url строка.
	 * Результат безопасен для использования как имя файла на Google Drive.
	 */
	async encryptFileName(name: string): Promise<string> {
		const encrypted = await this.encrypt(name);
		return arrayBufferToBase64Url(encrypted);
	}

	/**
	 * Расшифровывает зашифрованное имя файла из base64url.
	 */
	async decryptFileName(encrypted: string): Promise<string> {
		const buffer = base64UrlToArrayBuffer(encrypted);
		const decrypted = await this.decrypt(buffer);
		return new TextDecoder().decode(decrypted);
	}

	// ============================================================
	// Хеширование
	// ============================================================

	/**
	 * Вычисляет SHA-256 хеш данных.
	 */
	async hash(data: ArrayBuffer | string): Promise<string> {
		const buffer = typeof data === 'string'
			? new TextEncoder().encode(data).buffer
			: data;
		const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
		return arrayBufferToBase64(hashBuffer);
	}

	/**
	 * Хеш пароля для быстрой верификации при вводе.
	 * НЕ используется для шифрования — только для проверки «правильный ли пароль».
	 */
	async hashPassword(password: string, salt: string): Promise<string> {
		const data = password + ':' + salt;
		return this.hash(data);
	}

	/**
	 * Вычисляет SHA-256 хеш содержимого файла.
	 */
	async computeContentHash(content: ArrayBuffer): Promise<string> {
		return this.hash(content);
	}

	// ============================================================
	// Приватные
	// ============================================================

	private ensureInitialized(): void {
		if (!this.key) {
			throw new Error('CryptoService не инициализирован. Вызовите init() с паролем.');
		}
	}
}
