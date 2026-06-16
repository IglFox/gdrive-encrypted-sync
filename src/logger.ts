/**
 * Логирование для плагина Google Drive Encrypted Sync.
 *
 * Пишет логи в консоль разработчика Obsidian с префиксом [GDriveSync].
 * Опционально сохраняет логи в файл для отладки.
 */

import { LogLevel } from './types';

const LOG_PREFIX = '[GDriveSync]';
const MAX_LOG_ENTRIES = 500;

export class Logger {
	private level: LogLevel;
	private logBuffer: string[] = [];

	constructor(level: LogLevel = LogLevel.INFO) {
		this.level = level;
	}

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	debug(message: string, ...args: unknown[]): void {
		this.log(LogLevel.DEBUG, message, ...args);
	}

	info(message: string, ...args: unknown[]): void {
		this.log(LogLevel.INFO, message, ...args);
	}

	warn(message: string, ...args: unknown[]): void {
		this.log(LogLevel.WARN, message, ...args);
	}

	error(message: string, ...args: unknown[]): void {
		this.log(LogLevel.ERROR, message, ...args);
	}

	/**
	 * Получить последние записи лога для отображения в UI.
	 */
	getRecentLogs(count: number = 50): string[] {
		return this.logBuffer.slice(-count);
	}

	/**
	 * Очистить буфер логов.
	 */
	clearLogs(): void {
		this.logBuffer = [];
	}

	private log(level: LogLevel, message: string, ...args: unknown[]): void {
		if (level < this.level) return;

		const timestamp = new Date().toISOString().substring(11, 23);
		const levelStr = LogLevel[level] ?? 'UNKNOWN';
		const formattedMessage = `${LOG_PREFIX} ${timestamp} [${levelStr}] ${message}`;

		// Сохраняем в буфер
		this.logBuffer.push(formattedMessage);
		if (this.logBuffer.length > MAX_LOG_ENTRIES) {
			this.logBuffer = this.logBuffer.slice(-MAX_LOG_ENTRIES);
		}

		// Выводим в консоль
		switch (level) {
			case LogLevel.DEBUG:
				console.debug(formattedMessage, ...args);
				break;
			case LogLevel.INFO:
				console.info(formattedMessage, ...args);
				break;
			case LogLevel.WARN:
				console.warn(formattedMessage, ...args);
				break;
			case LogLevel.ERROR:
				console.error(formattedMessage, ...args);
				break;
		}
	}
}

/** Синглтон логгера */
export const logger = new Logger();
