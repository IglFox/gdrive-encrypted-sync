/**
 * Клиент Google Drive API v3.
 *
 * Все HTTP-запросы через Obsidian requestUrl.
 * Управляет файлами в папке ObsidianEncryptedSync на Google Drive.
 */

import { requestUrl, RequestUrlParam } from 'obsidian';
import {
	DriveFileMetadata,
	DriveFileList,
	DRIVE_FOLDER_MIME,
	SYNC_FOLDER_NAME,
} from './types';
import { OAuthManager } from './oauth';
import { logger } from './logger';
import { retryWithBackoff } from './utils';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export class GoogleDriveClient {
	private oauth: OAuthManager;

	constructor(oauth: OAuthManager) {
		this.oauth = oauth;
	}

	// ============================================================
	// Папки
	// ============================================================

	/**
	 * Создаёт или находит корневую папку синхронизации на Google Drive.
	 * Возвращает ID папки.
	 */
	async ensureSyncFolder(): Promise<string> {
		// Ищем существующую папку
		const query = `name='${SYNC_FOLDER_NAME}' and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false and 'root' in parents`;
		const result = await this.listFilesRaw(query, 'id,name', 1);

		if (result.files.length > 0) {
			const folderId = result.files[0]!.id;
			logger.info(`Папка синхронизации найдена: ${folderId}`);
			return folderId;
		}

		// Создаём папку
		logger.info('Создаём папку синхронизации на Google Drive...');
		const folder = await this.createFolder(SYNC_FOLDER_NAME);
		logger.info(`Папка синхронизации создана: ${folder.id}`);
		return folder.id;
	}

	/**
	 * Создаёт папку на Google Drive.
	 */
	async createFolder(name: string, parentId?: string): Promise<DriveFileMetadata> {
		const metadata: Record<string, unknown> = {
			name,
			mimeType: DRIVE_FOLDER_MIME,
		};
		if (parentId) {
			metadata['parents'] = [parentId];
		}

		return this.apiRequest<DriveFileMetadata>(`${DRIVE_API_BASE}/files`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(metadata),
		});
	}

	// ============================================================
	// Загрузка файлов
	// ============================================================

	/**
	 * Загружает новый файл на Google Drive (multipart upload).
	 *
	 * @param fileName Имя файла (зашифрованное)
	 * @param data Содержимое файла (зашифрованное)
	 * @param parentId ID родительской папки
	 * @param appProperties Дополнительные метаданные (хранятся приватно)
	 */
	async uploadFile(
		fileName: string,
		data: ArrayBuffer,
		parentId: string,
		appProperties?: Record<string, string>,
	): Promise<DriveFileMetadata> {
		return retryWithBackoff(async () => {
			const metadata: Record<string, unknown> = {
				name: fileName,
				parents: [parentId],
			};
			if (appProperties) {
				metadata['appProperties'] = appProperties;
			}

			const boundary = '----GDriveSyncBoundary' + Date.now();
			const metadataStr = JSON.stringify(metadata);

			// Формируем multipart body
			const body = this.buildMultipartBody(boundary, metadataStr, data);

			const token = await this.oauth.getAccessToken();
			const response = await requestUrl({
				url: `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,modifiedTime,size`,
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': `multipart/related; boundary=${boundary}`,
				},
				body: body,
			});

			if (response.status !== 200) {
				throw new Error(`Ошибка загрузки файла: ${response.status}`);
			}

			return response.json as DriveFileMetadata;
		}, 2);
	}

	/**
	 * Обновляет содержимое существующего файла на Google Drive.
	 */
	async updateFile(
		fileId: string,
		data: ArrayBuffer,
		appProperties?: Record<string, string>,
	): Promise<DriveFileMetadata> {
		return retryWithBackoff(async () => {
			const boundary = '----GDriveSyncBoundary' + Date.now();
			const metadata: Record<string, unknown> = {};
			if (appProperties) {
				metadata['appProperties'] = appProperties;
			}
			const metadataStr = JSON.stringify(metadata);

			const body = this.buildMultipartBody(boundary, metadataStr, data);

			const token = await this.oauth.getAccessToken();
			const response = await requestUrl({
				url: `${DRIVE_UPLOAD_BASE}/files/${fileId}?uploadType=multipart&fields=id,name,modifiedTime,size`,
				method: 'PATCH',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': `multipart/related; boundary=${boundary}`,
				},
				body: body,
			});

			if (response.status !== 200) {
				throw new Error(`Ошибка обновления файла: ${response.status}`);
			}

			return response.json as DriveFileMetadata;
		}, 2);
	}

	// ============================================================
	// Скачивание файлов
	// ============================================================

	/**
	 * Скачивает содержимое файла с Google Drive.
	 */
	async downloadFile(fileId: string): Promise<ArrayBuffer> {
		return retryWithBackoff(async () => {
			const token = await this.oauth.getAccessToken();
			const response = await requestUrl({
				url: `${DRIVE_API_BASE}/files/${fileId}?alt=media`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${token}`,
				},
			});

			if (response.status !== 200) {
				throw new Error(`Ошибка скачивания файла: ${response.status}`);
			}

			return response.arrayBuffer;
		}, 2);
	}

	// ============================================================
	// Удаление
	// ============================================================

	/**
	 * Удаляет файл (перемещает в корзину Google Drive).
	 */
	async deleteFile(fileId: string): Promise<void> {
		await this.apiRequest(`${DRIVE_API_BASE}/files/${fileId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ trashed: true }),
		});
	}

	// ============================================================
	// Листинг и метаданные
	// ============================================================

	/**
	 * Получает список файлов в указанной папке.
	 */
	async listFiles(
		folderId: string,
		pageToken?: string,
	): Promise<DriveFileList> {
		const query = `'${folderId}' in parents and trashed=false`;
		return this.listFilesRaw(
			query,
			'id,name,mimeType,modifiedTime,size,appProperties',
			100,
			pageToken,
		);
	}

	/**
	 * Получает ВСЕ файлы из папки (с пагинацией).
	 */
	async listAllFiles(folderId: string): Promise<DriveFileMetadata[]> {
		const allFiles: DriveFileMetadata[] = [];
		let pageToken: string | undefined;

		do {
			const result = await this.listFiles(folderId, pageToken);
			allFiles.push(...result.files);
			pageToken = result.nextPageToken;
		} while (pageToken);

		return allFiles;
	}

	/**
	 * Получает метаданные одного файла.
	 */
	async getFileMetadata(fileId: string): Promise<DriveFileMetadata> {
		return this.apiRequest<DriveFileMetadata>(
			`${DRIVE_API_BASE}/files/${fileId}?fields=id,name,mimeType,modifiedTime,size,appProperties,trashed`,
			{ method: 'GET' },
		);
	}

	/**
	 * Поиск файла по имени в папке.
	 */
	async findFileByName(
		name: string,
		parentId: string,
	): Promise<DriveFileMetadata | null> {
		const query = `name='${name}' and '${parentId}' in parents and trashed=false`;
		const result = await this.listFilesRaw(query, 'id,name,modifiedTime,size', 1);
		return result.files[0] ?? null;
	}

	// ============================================================
	// Приватные
	// ============================================================

	/**
	 * Выполнение запроса к Drive API с авторизацией.
	 */
	private async apiRequest<T>(
		url: string,
		options: Partial<RequestUrlParam>,
	): Promise<T> {
		return retryWithBackoff(async () => {
			const token = await this.oauth.getAccessToken();
			const response = await requestUrl({
				url,
				method: options.method ?? 'GET',
				headers: {
					'Authorization': `Bearer ${token}`,
					...options.headers,
				},
				body: options.body,
			});

			if (response.status < 200 || response.status >= 300) {
				throw new Error(`Google Drive API ошибка: ${response.status} ${response.text}`);
			}

			return response.json as T;
		}, 2);
	}

	/**
	 * Запрос листинга файлов с параметрами.
	 */
	private async listFilesRaw(
		query: string,
		fields: string,
		pageSize: number,
		pageToken?: string,
	): Promise<DriveFileList> {
		const params = new URLSearchParams({
			q: query,
			fields: `nextPageToken,files(${fields})`,
			pageSize: String(pageSize),
		});
		if (pageToken) {
			params.set('pageToken', pageToken);
		}

		return this.apiRequest<DriveFileList>(
			`${DRIVE_API_BASE}/files?${params.toString()}`,
			{ method: 'GET' },
		);
	}

	/**
	 * Построение multipart/related body для загрузки файла.
	 */
	private buildMultipartBody(
		boundary: string,
		metadataJson: string,
		fileData: ArrayBuffer,
	): ArrayBuffer {
		const encoder = new TextEncoder();

		const preamble = encoder.encode(
			`--${boundary}\r\n` +
			`Content-Type: application/json; charset=UTF-8\r\n\r\n` +
			`${metadataJson}\r\n` +
			`--${boundary}\r\n` +
			`Content-Type: application/octet-stream\r\n\r\n`,
		);

		const postamble = encoder.encode(`\r\n--${boundary}--`);

		// Собираем буфер
		const totalLength = preamble.byteLength + fileData.byteLength + postamble.byteLength;
		const result = new Uint8Array(totalLength);
		result.set(new Uint8Array(preamble), 0);
		result.set(new Uint8Array(fileData), preamble.byteLength);
		result.set(new Uint8Array(postamble), preamble.byteLength + fileData.byteLength);

		return result.buffer;
	}
}
