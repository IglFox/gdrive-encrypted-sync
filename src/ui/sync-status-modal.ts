/**
 * Модальное окно статуса синхронизации.
 *
 * Показывает подробную информацию о текущей/последней синхронизации:
 * прогресс, результаты, лог последних действий.
 */

import { App, Modal } from 'obsidian';
import { SyncResult, SyncStatus } from '../types';
import { logger } from '../logger';
import { formatDateTime, formatFileSize } from '../utils';

export class SyncStatusModal extends Modal {
	private status: SyncStatus;
	private lastResult: SyncResult | null;
	private lastSyncTime: string;
	private progress: { current: number; total: number; file: string };

	constructor(
		app: App,
		status: SyncStatus,
		lastResult: SyncResult | null,
		lastSyncTime: string,
		progress: { current: number; total: number; file: string },
	) {
		super(app);
		this.status = status;
		this.lastResult = lastResult;
		this.lastSyncTime = lastSyncTime;
		this.progress = progress;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('gdrive-sync-status-modal');

		// Заголовок
		contentEl.createEl('h2', { text: '📊 Статус синхронизации' });

		// Текущий статус
		const statusContainer = contentEl.createDiv('gdrive-status-section');
		statusContainer.createEl('h3', { text: 'Текущее состояние' });

		const statusText = this.getStatusText();
		const statusEl = statusContainer.createDiv('gdrive-status-badge');
		statusEl.createSpan({ text: statusText.emoji + ' ' });
		statusEl.createSpan({ text: statusText.text, cls: `gdrive-status-${this.status}` });

		// Прогресс (если синхронизируется)
		if (this.status === SyncStatus.Syncing && this.progress.total > 0) {
			const progressSection = contentEl.createDiv('gdrive-status-section');
			progressSection.createEl('h3', { text: 'Прогресс' });

			const progressBar = progressSection.createDiv('gdrive-progress-bar');
			const fill = progressBar.createDiv('gdrive-progress-fill');
			const percent = Math.round((this.progress.current / this.progress.total) * 100);
			fill.style.width = `${percent}%`;

			progressSection.createEl('p', {
				text: `${this.progress.current} / ${this.progress.total} — ${this.progress.file}`,
				cls: 'gdrive-progress-text',
			});
		}

		// Последняя синхронизация
		const timeSection = contentEl.createDiv('gdrive-status-section');
		timeSection.createEl('h3', { text: 'Последняя синхронизация' });
		timeSection.createEl('p', {
			text: this.lastSyncTime ? formatDateTime(this.lastSyncTime) : 'Ещё не выполнялась',
		});

		// Результаты последней синхронизации
		if (this.lastResult) {
			const resultSection = contentEl.createDiv('gdrive-status-section');
			resultSection.createEl('h3', { text: 'Результаты' });

			const table = resultSection.createEl('table', { cls: 'gdrive-result-table' });

			const rows = [
				['↑ Загружено на Drive', String(this.lastResult.uploaded)],
				['↓ Скачано с Drive', String(this.lastResult.downloaded)],
				['🗑 Удалено на Drive', String(this.lastResult.deletedRemote)],
				['🗑 Удалено локально', String(this.lastResult.deletedLocal)],
				['⚠ Конфликтов', String(this.lastResult.conflicts)],
				['❌ Ошибок', String(this.lastResult.errors.length)],
				['⏱ Время', `${this.lastResult.duration}мс`],
			];

			for (const [label, value] of rows) {
				const tr = table.createEl('tr');
				tr.createEl('td', { text: label });
				tr.createEl('td', { text: value, cls: 'gdrive-result-value' });
			}

			// Ошибки
			if (this.lastResult.errors.length > 0) {
				const errSection = contentEl.createDiv('gdrive-status-section');
				errSection.createEl('h3', { text: '❌ Ошибки' });

				for (const err of this.lastResult.errors) {
					const errEl = errSection.createDiv('gdrive-error-item');
					errEl.createEl('strong', { text: err.vaultPath || 'Общая ошибка' });
					errEl.createEl('p', { text: `[${err.action}] ${err.message}` });
				}
			}
		}

		// Лог
		const logSection = contentEl.createDiv('gdrive-status-section');
		logSection.createEl('h3', { text: '📋 Последние записи лога' });

		const logContainer = logSection.createDiv('gdrive-log-container');
		const recentLogs = logger.getRecentLogs(20);

		if (recentLogs.length === 0) {
			logContainer.createEl('p', { text: 'Лог пуст', cls: 'gdrive-log-empty' });
		} else {
			for (const entry of recentLogs) {
				logContainer.createDiv({ text: entry, cls: 'gdrive-log-entry' });
			}
			// Прокручиваем вниз
			logContainer.scrollTop = logContainer.scrollHeight;
		}

		// Стили
		this.addStyles(contentEl);
	}

	onClose() {
		this.contentEl.empty();
	}

	private getStatusText(): { emoji: string; text: string } {
		switch (this.status) {
			case SyncStatus.Idle:
				return { emoji: '✅', text: 'Готов к синхронизации' };
			case SyncStatus.Syncing:
				return { emoji: '🔄', text: 'Синхронизация...' };
			case SyncStatus.Error:
				return { emoji: '❌', text: 'Ошибка' };
			case SyncStatus.NoConnection:
				return { emoji: '📵', text: 'Нет соединения' };
			case SyncStatus.NotConfigured:
				return { emoji: '⚙️', text: 'Не настроено' };
			default:
				return { emoji: '❓', text: 'Неизвестно' };
		}
	}

	private addStyles(container: HTMLElement): void {
		const style = container.createEl('style');
		style.textContent = `
			.gdrive-sync-status-modal {
				max-width: 600px;
			}
			.gdrive-status-section {
				margin-bottom: 16px;
				padding-bottom: 12px;
				border-bottom: 1px solid var(--background-modifier-border);
			}
			.gdrive-status-section:last-child {
				border-bottom: none;
			}
			.gdrive-status-section h3 {
				margin: 0 0 8px 0;
				font-size: 14px;
				color: var(--text-muted);
			}
			.gdrive-status-badge {
				font-size: 16px;
				font-weight: 600;
			}
			.gdrive-status-idle { color: var(--text-success); }
			.gdrive-status-syncing { color: var(--text-accent); }
			.gdrive-status-error { color: var(--text-error); }
			.gdrive-status-not_configured { color: var(--text-warning); }
			.gdrive-progress-bar {
				width: 100%;
				height: 8px;
				background: var(--background-modifier-border);
				border-radius: 4px;
				overflow: hidden;
				margin: 8px 0;
			}
			.gdrive-progress-fill {
				height: 100%;
				background: var(--interactive-accent);
				border-radius: 4px;
				transition: width 0.3s ease;
			}
			.gdrive-progress-text {
				font-size: 12px;
				color: var(--text-muted);
				margin: 4px 0;
			}
			.gdrive-result-table {
				width: 100%;
				border-collapse: collapse;
			}
			.gdrive-result-table td {
				padding: 4px 8px;
				border-bottom: 1px solid var(--background-modifier-border);
			}
			.gdrive-result-value {
				text-align: right;
				font-weight: 600;
				font-variant-numeric: tabular-nums;
			}
			.gdrive-error-item {
				margin: 8px 0;
				padding: 8px;
				background: var(--background-modifier-error);
				border-radius: 4px;
				font-size: 13px;
			}
			.gdrive-error-item p { margin: 4px 0 0; }
			.gdrive-log-container {
				max-height: 200px;
				overflow-y: auto;
				font-family: var(--font-monospace);
				font-size: 11px;
				background: var(--background-primary-alt);
				padding: 8px;
				border-radius: 4px;
			}
			.gdrive-log-entry {
				white-space: pre-wrap;
				word-break: break-all;
				padding: 2px 0;
				border-bottom: 1px solid var(--background-modifier-border);
			}
			.gdrive-log-empty {
				color: var(--text-muted);
				font-style: italic;
			}
		`;
	}
}
