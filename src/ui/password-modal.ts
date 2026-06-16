import { App, Modal, Setting, Notice } from 'obsidian';
import type GDriveSyncPlugin from '../main';

export class PasswordModal extends Modal {
	private plugin: GDriveSyncPlugin;
	private isChange: boolean;
	private onSubmit: () => void;

	constructor(app: App, plugin: GDriveSyncPlugin, isChange: boolean, onSubmit: () => void) {
		super(app);
		this.plugin = plugin;
		this.isChange = isChange;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h3', { text: this.isChange ? 'Изменить пароль' : 'Установить пароль шифрования' });

		if (this.isChange) {
			contentEl.createEl('p', {
				text: '⚠️ При изменении пароля все файлы на Google Drive будут перешифрованы ' +
					'при следующей полной синхронизации.',
				cls: 'gdrive-warning-text',
			});
		}

		let passwordValue = '';
		let confirmValue = '';

		new Setting(contentEl)
			.setName('Пароль')
			.setDesc('Минимум 8 символов')
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setPlaceholder('Введите пароль...');
				text.onChange((value) => {
					passwordValue = value;
				});
			});

		new Setting(contentEl)
			.setName('Подтверждение')
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setPlaceholder('Повторите пароль...');
				text.onChange((value) => {
					confirmValue = value;
				});
			});

		const btnContainer = contentEl.createDiv('gdrive-password-buttons');
		
		const saveBtn = btnContainer.createEl('button', {
			text: 'Сохранить',
			cls: 'mod-cta',
		});
		saveBtn.onclick = async () => {
			if (passwordValue.length < 8) {
				new Notice('Пароль должен быть не менее 8 символов');
				return;
			}
			if (passwordValue !== confirmValue) {
				new Notice('Пароли не совпадают');
				return;
			}

			try {
				await this.plugin.setupEncryption(passwordValue);
				new Notice('Пароль шифрования установлен!');
				this.close();
				this.onSubmit();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				new Notice(`Ошибка: ${msg}`);
			}
		};

		const cancelBtn = btnContainer.createEl('button', { text: 'Отмена' });
		cancelBtn.onclick = () => {
			this.close();
		};

		const style = contentEl.createEl('style');
		style.textContent = `
			.gdrive-password-buttons {
				display: flex;
				gap: 8px;
				margin-top: 16px;
				justify-content: flex-end;
			}
			.gdrive-warning-text {
				color: var(--text-warning);
				font-style: italic;
				margin-bottom: 12px;
			}
		`;
	}

	onClose() {
		this.contentEl.empty();
	}
}
