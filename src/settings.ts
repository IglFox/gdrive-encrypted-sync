/**
 * Страница настроек плагина Google Drive Encrypted Sync.
 *
 * Интерфейс на русском языке.
 * Пользователь вводит свои Google OAuth credentials и пароль шифрования.
 */

import { App, Notice, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import { PluginSettings, ConflictStrategy } from './types';
import type GDriveSyncPlugin from './main';
import { PasswordModal } from './ui/password-modal';

export class GDriveSyncSettingTab extends PluginSettingTab {
	plugin: GDriveSyncPlugin;

	constructor(app: App, plugin: GDriveSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ============================================================
		// Google Drive подключение
		// ============================================================

		containerEl.createEl('h2', { text: '🔗 Подключение к Google Drive' });

		containerEl.createEl('p', {
			text: 'Для работы плагина необходимо создать проект в Google Cloud Console и получить OAuth 2.0 credentials.',
			cls: 'setting-item-description',
		});

		// Инструкция
		const instructionEl = containerEl.createDiv('gdrive-instruction');
		instructionEl.createEl('details', {}, (details) => {
			details.createEl('summary', { text: '📖 Инструкция по настройке Google Cloud' });
			const ol = details.createEl('ol');
			ol.createEl('li', { text: 'Перейдите в Google Cloud Console (console.cloud.google.com)' });
			ol.createEl('li', { text: 'Создайте новый проект или выберите существующий' });
			ol.createEl('li', { text: 'Включите Google Drive API (APIs & Services → Library)' });
			ol.createEl('li', { text: 'Настройте OAuth consent screen (тип: External)' });
			ol.createEl('li', { text: 'Создайте OAuth 2.0 Client ID (тип: Desktop app)' });
			ol.createEl('li', { text: 'Скопируйте Client ID и Client Secret в поля ниже' });
		});

		new Setting(containerEl)
			.setName('Client ID')
			.setDesc('OAuth 2.0 Client ID из Google Cloud Console')
			.addText((text) =>
				text
					.setPlaceholder('xxx.apps.googleusercontent.com')
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Client Secret')
			.setDesc('OAuth 2.0 Client Secret из Google Cloud Console')
			.addText((text) => {
				text
					.setPlaceholder('GOCSPX-...')
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value.trim();
						await this.plugin.saveSettings();
					});
				// Маскируем ввод
				text.inputEl.type = 'password';
			});

		// Кнопка подключения / отключения
		const isConnected = this.plugin.isConnected();

		new Setting(containerEl)
			.setName(isConnected ? '✅ Google Drive подключён' : '⚡ Подключить Google Drive')
			.setDesc(
				isConnected
					? 'Нажмите для отключения'
					: 'Откроется браузер для входа в Google аккаунт',
			)
			.addButton((button) => {
				button
					.setButtonText(isConnected ? 'Отключить' : 'Подключить')
					.setCta()
					.onClick(async () => {
						if (isConnected) {
							this.plugin.disconnect();
							new Notice('Google Drive отключён');
						} else {
							try {
								await this.plugin.connect();
								new Notice('Google Drive подключён!');
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								new Notice(`Ошибка подключения: ${msg}`);
							}
						}
						this.display(); // Обновляем UI
					});

				if (isConnected) {
					button.buttonEl.classList.add('mod-warning');
				}
			});

		// ============================================================
		// Шифрование
		// ============================================================

		containerEl.createEl('h2', { text: '🔐 Шифрование' });

		const hasPassword = !!this.plugin.settings.passwordHash;

		if (hasPassword) {
			new Setting(containerEl)
				.setName('✅ Пароль шифрования установлен')
				.setDesc('Все данные шифруются перед отправкой на Google Drive (AES-256-GCM)')
				.addButton((button) => {
					button
						.setButtonText('Изменить пароль')
						.onClick(() => {
							this.showPasswordDialog(containerEl, true);
						});
				});
		} else {
			const warnEl = containerEl.createDiv('gdrive-warning');
			warnEl.createEl('strong', { text: '⚠️ Внимание: ' });
			warnEl.appendText('Пароль шифрования — единственный ключ доступа к вашим данным на Google Drive. Если вы его забудете, восстановить данные будет невозможно!');

			new Setting(containerEl)
				.setName('Установить пароль шифрования')
				.setDesc('Данные будут зашифрованы AES-256-GCM перед отправкой')
				.addButton((button) => {
					button
						.setButtonText('Установить пароль')
						.setCta()
						.onClick(() => {
							this.showPasswordDialog(containerEl, false);
						});
				});
		}

		// ============================================================
		// Автосинхронизация
		// ============================================================

		containerEl.createEl('h2', { text: '⚙️ Синхронизация' });

		new Setting(containerEl)
			.setName('Автосинхронизация')
			.setDesc('Интервал в минутах (0 = отключена). Если отключить, синхронизация будет только при запуске (если включено ниже) или вручную.')
			.addText((text) =>
				text
					.setPlaceholder('5')
					.setValue(String(this.plugin.settings.autoSyncInterval))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.autoSyncInterval = num;
							await this.plugin.saveSettings();
							this.plugin.restartAutoSync();
						}
					}),
			);

		new Setting(containerEl)
			.setName('Синхронизировать при запуске')
			.setDesc('Автоматически запускать синхронизацию при открытии Obsidian')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Стратегия конфликтов')
			.setDesc('Что делать, если файл изменён и локально, и на Google Drive')
			.addDropdown((dropdown) =>
				dropdown
					.addOption(ConflictStrategy.KeepNewer, 'Побеждает новая версия')
					.addOption(ConflictStrategy.CreateCopy, 'Создавать конфликтную копию')
					.addOption(ConflictStrategy.KeepLocal, 'Всегда оставлять локальную')
					.addOption(ConflictStrategy.KeepRemote, 'Всегда оставлять удалённую')
					.setValue(this.plugin.settings.conflictResolution)
					.onChange(async (value) => {
						this.plugin.settings.conflictResolution = value as ConflictStrategy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Показывать уведомления')
			.setDesc('Показывать уведомления о результатах синхронизации')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showNotifications)
					.onChange(async (value) => {
						this.plugin.settings.showNotifications = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Защита от массового удаления')
			.setDesc('Останавливать синхронизацию, если планируется удалить более 50% файлов в хранилище или на Google Drive')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDeletionGuard)
					.onChange(async (value) => {
						this.plugin.settings.enableDeletionGuard = value;
						await this.plugin.saveSettings();
					}),
			);

		// ============================================================
		// Исключения
		// ============================================================

		containerEl.createEl('h2', { text: '🚫 Исключения' });

		new Setting(containerEl)
			.setName('Паттерны исключений')
			.setDesc(
				'Файлы, соответствующие этим glob-паттернам, не будут синхронизироваться. ' +
				'По одному на строку. Примеры: .obsidian/workspace.json, .trash/**, *.tmp',
			)
			.addTextArea((text) => {
				text
					.setPlaceholder('.obsidian/workspace.json\n.trash/**')
					.setValue(this.plugin.settings.excludePatterns.join('\n'))
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value
							.split('\n')
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 5;
				text.inputEl.cols = 40;
			});

		// ============================================================
		// Действия
		// ============================================================

		containerEl.createEl('h2', { text: '🔧 Действия' });

		new Setting(containerEl)
			.setName('Полная пересинхронизация')
			.setDesc('Сбрасывает состояние и синхронизирует все файлы заново. Используйте при проблемах.')
			.addButton((button) =>
				button
					.setButtonText('Пересинхронизировать')
					.setWarning()
					.onClick(async () => {
						const confirmed = confirm(
							'Вы уверены? Это сбросит состояние синхронизации и заново сравнит все файлы.',
						);
						if (confirmed) {
							await this.plugin.fullResync();
						}
					}),
			);

		// Стили для страницы настроек
		this.addSettingsStyles(containerEl);
	}

	private showPasswordDialog(container: HTMLElement, isChange: boolean): void {
		new PasswordModal(this.app, this.plugin, isChange, () => {
			this.display();
		}).open();
	}

	private addSettingsStyles(container: HTMLElement): void {
		const style = container.createEl('style');
		style.textContent = `
			.gdrive-instruction {
				margin-bottom: 16px;
			}
			.gdrive-instruction details {
				background: var(--background-primary-alt);
				padding: 12px;
				border-radius: 8px;
				border: 1px solid var(--background-modifier-border);
			}
			.gdrive-instruction summary {
				cursor: pointer;
				font-weight: 600;
				margin-bottom: 8px;
			}
			.gdrive-instruction ol {
				margin: 8px 0;
				padding-left: 20px;
			}
			.gdrive-instruction li {
				margin: 4px 0;
			}
			.gdrive-warning {
				background: rgba(224, 150, 0, 0.08);
				border-left: 4px solid var(--text-warning);
				color: var(--text-normal);
				padding: 12px 16px;
				border-radius: 4px;
				margin-bottom: 16px;
				font-size: 0.95em;
				line-height: 1.5;
			}
			.gdrive-warning-text {
				color: var(--text-warning);
				font-style: italic;
			}
			.gdrive-password-dialog {
				background: var(--background-primary-alt);
				padding: 16px;
				border-radius: 8px;
				border: 1px solid var(--background-modifier-border);
				margin: 16px 0;
			}
			.gdrive-password-buttons {
				display: flex;
				gap: 8px;
				margin-top: 12px;
				justify-content: flex-end;
			}
		`;
	}
}
