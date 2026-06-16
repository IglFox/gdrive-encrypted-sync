import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.argv[2];
if (!targetVersion) {
	console.error('Пожалуйста, укажите версию. Пример: node version-bump.mjs 1.0.1');
	process.exit(1);
}

// Валидация формата версии (x.y.z)
if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
	console.error('Неверный формат версии. Используйте формат x.y.z (например, 1.0.1)');
	process.exit(1);
}

console.log(`Обновление версии до ${targetVersion}...`);

// 1. Обновление package.json
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
packageJson.version = targetVersion;
writeFileSync('package.json', JSON.stringify(packageJson, null, '\t') + '\n', 'utf8');
console.log('✔ package.json успешно обновлен');

// 2. Обновление manifest.json
const manifestJson = JSON.parse(readFileSync('manifest.json', 'utf8'));
manifestJson.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifestJson, null, '\t') + '\n', 'utf8');
console.log('✔ manifest.json успешно обновлен');

// 3. Обновление versions.json
const versionsJson = JSON.parse(readFileSync('versions.json', 'utf8'));
const minAppVersion = manifestJson.minAppVersion || '1.0.0';
versionsJson[targetVersion] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versionsJson, null, '\t') + '\n', 'utf8');
console.log('✔ versions.json успешно обновлен');

console.log(`\n🎉 Версия успешно повышена до ${targetVersion}!`);
console.log('Теперь вы можете закоммитить изменения и создать тег:');
console.log(`git add . && git commit -m "bump version to ${targetVersion}"`);
console.log(`git tag -a ${targetVersion} -m "${targetVersion}"`);
console.log(`git push origin main --tags`);
