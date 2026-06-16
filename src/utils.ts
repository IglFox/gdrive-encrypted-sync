/**
 * Утилиты для плагина Google Drive Encrypted Sync
 */

/**
 * Проверяет, соответствует ли путь файла одному из glob-паттернов исключений.
 * Поддерживает простые паттерны: *, **, ?
 */
export function matchesExcludePattern(filePath: string, patterns: string[]): boolean {
	const normalized = normalizePath(filePath);
	for (const pattern of patterns) {
		if (simpleGlobMatch(normalized, normalizePath(pattern))) {
			return true;
		}
	}
	return false;
}

/**
 * Простой glob-матчер для паттернов с *, ** и ?
 */
function simpleGlobMatch(path: string, pattern: string): boolean {
	// Конвертируем glob в regex
	let regexStr = '^';
	let i = 0;
	while (i < pattern.length) {
		const char = pattern[i];
		if (char === '*') {
			if (pattern[i + 1] === '*') {
				// ** — любые символы включая /
				regexStr += '.*';
				i += 2;
				// Пропустить / после **
				if (pattern[i] === '/') {
					i++;
				}
			} else {
				// * — любые символы кроме /
				regexStr += '[^/]*';
				i++;
			}
		} else if (char === '?') {
			regexStr += '[^/]';
			i++;
		} else if ('.+^${}()|[]\\'.includes(char!)) {
			regexStr += '\\' + char;
			i++;
		} else {
			regexStr += char;
			i++;
		}
	}
	regexStr += '$';

	try {
		return new RegExp(regexStr).test(path);
	} catch {
		return false;
	}
}

/**
 * Нормализация пути: заменяет обратные слеши на прямые, убирает дублирующие слеши.
 */
export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/\/$/, '');
}

/**
 * Форматирование размера файла для отображения пользователю.
 */
export function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 Б';
	const units = ['Б', 'КБ', 'МБ', 'ГБ'];
	const k = 1024;
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	const size = bytes / Math.pow(k, i);
	return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i] ?? 'ГБ'}`;
}

/**
 * Debounce: задержка вызова функции до прекращения событий.
 */
export function debounce<T extends (...args: unknown[]) => void>(
	fn: T,
	delayMs: number,
): T & { cancel: () => void } {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const debounced = function (this: unknown, ...args: unknown[]) {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
		}
		timeoutId = setTimeout(() => {
			fn.apply(this, args);
			timeoutId = null;
		}, delayMs);
	} as T & { cancel: () => void };

	debounced.cancel = () => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
	};

	return debounced;
}

/**
 * Повторные попытки с экспоненциальной задержкой.
 */
export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	maxRetries: number = 3,
	baseDelayMs: number = 1000,
): Promise<T> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < maxRetries) {
				const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
				await sleep(delay);
			}
		}
	}
	throw lastError;
}

/**
 * Задержка выполнения.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Получить текущее время в формате ISO 8601.
 */
export function nowISO(): string {
	return new Date().toISOString();
}

/**
 * ArrayBuffer → base64 строка.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}

/**
 * Base64 строка → ArrayBuffer.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

/**
 * ArrayBuffer → base64url строка (безопасна для имён файлов).
 */
export function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
	return arrayBufferToBase64(buffer)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/**
 * Base64url строка → ArrayBuffer.
 */
export function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
	let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
	while (base64.length % 4 !== 0) {
		base64 += '=';
	}
	return base64ToArrayBuffer(base64);
}

/**
 * Конкатенация нескольких ArrayBuffer в один.
 */
export function concatArrayBuffers(...buffers: ArrayBuffer[]): ArrayBuffer {
	const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const buf of buffers) {
		result.set(new Uint8Array(buf), offset);
		offset += buf.byteLength;
	}
	return result.buffer;
}

/**
 * Форматирование даты для отображения пользователю.
 */
export function formatDateTime(isoString: string): string {
	if (!isoString) return 'Никогда';
	const date = new Date(isoString);
	return date.toLocaleString('ru-RU', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

/**
 * Генерация имени конфликтной копии файла.
 */
export function generateConflictFileName(originalPath: string): string {
	const now = new Date();
	const timestamp = now.toLocaleString('ru-RU', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	}).replace(/[/:]/g, '-').replace(/,\s*/g, '_');

	const lastDot = originalPath.lastIndexOf('.');
	if (lastDot === -1) {
		return `${originalPath} (конфликт ${timestamp})`;
	}
	const name = originalPath.substring(0, lastDot);
	const ext = originalPath.substring(lastDot);
	return `${name} (конфликт ${timestamp})${ext}`;
}

/**
 * Простой мьютекс для предотвращения параллельных операций.
 */
export class Mutex {
	private _locked = false;
	private _queue: (() => void)[] = [];

	async acquire(): Promise<() => void> {
		return new Promise((resolve) => {
			const tryAcquire = () => {
				if (!this._locked) {
					this._locked = true;
					resolve(() => {
						this._locked = false;
						const next = this._queue.shift();
						if (next) {
							next();
						}
					});
				} else {
					this._queue.push(tryAcquire);
				}
			};
			tryAcquire();
		});
	}

	get isLocked(): boolean {
		return this._locked;
	}
}
