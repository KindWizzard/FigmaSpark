import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from './config.mjs';
import { PROTOCOL, READ_COMMANDS, UI_COMMANDS, WRITE_COMMANDS } from './protocol.mjs';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SKILL_FILES = new Map([
  ['SKILL.md', 'text/markdown'],
  ['references/api.md', 'text/markdown'],
  ['agents/openai.yaml', 'text/yaml'],
  ['scripts/spark.mjs', 'text/javascript']
]);

// Shell examples are POSIX; structured argv is supplied for other shells.
export function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

export function connectionManifest({ url, sessionId = null, sessionAvailable = false, configPath = DEFAULT_CONFIG }) {
  const cli = join(PROJECT_ROOT, 'scripts', 'spark.mjs');
  const installer = join(PROJECT_ROOT, 'scripts', 'install-skill.mjs');
  const connectURL = new URL('/connect', url);
  if (sessionId) connectURL.searchParams.set('session', sessionId);
  return {
    ok: true, product: 'FigmaSpark', version: '0.2.1', protocol: PROTOCOL,
    connectURL: connectURL.href, sessionId, sessionAvailable,
    skill: {
      name: 'figma-spark', url: new URL('/skills/figma-spark/SKILL.md', url).href,
      referenceURL: new URL('/skills/figma-spark/references/api.md', url).href,
      files: [...SKILL_FILES.keys()],
      installation: { executable: process.execPath, script: installer, editors: ['codex', 'cursor', 'claude'], customDirectoryOption: '--dest', updateOption: '--update' }
    },
    local: { project: PROJECT_ROOT, node: process.execPath, cli, configPath, service: join(PROJECT_ROOT, 'scripts', 'service.mjs') },
    clients: {
      localEditors: ['Codex', 'Cursor', 'Claude Code, including Desktop Code mode'],
      claudeDesktopChat: { adapter: join(PROJECT_ROOT, 'bridge', 'claude.mjs'), installer: join(PROJECT_ROOT, 'scripts', 'install-claude-desktop.mjs'), tool: 'figma_spark_connect', transport: 'local-stdio', readOnly: true },
      claudeWebChat: { supported: false, reason: 'Cloud tools cannot reach this computer\'s localhost.' }
    },
    api: {
      url, status: '/status', rpc: '/rpc', authentication: 'Bearer token from the local config file; never copy credentials into chat',
      transport: 'persistent-websocket', format: 'json', compression: 'deflate/gzip at 4096 bytes',
      read: [...READ_COMMANDS], navigationAndReports: [...UI_COMMANDS], write: [...WRITE_COMMANDS],
      writePermission: 'patch additionally requires the native allow-edits entry in Figma'
    },
    workflow: { first: 'overview', then: ['search', 'snapshot', 'libraries when relevant', 'targeted export', 'audit or report'], snapshotDetail: 'review', defaultBatchSize: 100 }
  };
}

export function connectionMarkdown(manifest) {
  const { local, sessionId, sessionAvailable } = manifest;
  const command = [local.node, local.cli].map(shellQuote).join(' ');
  const selected = sessionId && sessionAvailable ? ` --session ${shellQuote(sessionId)}` : '';
  const install = [local.node, manifest.skill.installation.script].map(shellQuote).join(' ');
  return `# FigmaSpark — локальное подключение для ИИ

Эта инструкция отдаётся работающим FigmaSpark на этом компьютере. Данные макета и ключи доступа сюда не включены.

Для Claude Code (включая режим Code приложения), Codex и Cursor используй **локальный терминал**, а не облачный WebFetch. Получение скилла: \`curl --fail --silent --show-error --max-time 5 ${shellQuote(manifest.skill.url)}\`.

В обычном чате Claude Desktop при установленном локальном адаптере вызови \`figma_spark_connect\` с \`url: ${manifest.connectURL}\`; дальше используй \`figma_spark_read\` и \`figma_spark_image\`. Если инструмента нет, однократно установи адаптер в локальном терминале: \`${shellQuote(local.node)} ${shellQuote(manifest.clients.claudeDesktopChat.installer)}\`, затем полностью перезапусти Claude, когда текущие задачи завершены. На сайте claude.ai это локальное подключение недоступно; предложи режим Code или приложение с адаптером.

1. Получи актуальный [скилл figma-spark](${manifest.skill.url}) через локальный терминал. Его справочник загружай только по необходимости: [API](${manifest.skill.referenceURL}). Не используй стандартный Figma MCP для этого канала.
2. Если скилла нет в редакторе пользователя, установи его локальным установщиком. Для Codex: \`${install} --editor codex\`. Для Cursor используй \`--editor cursor\`, для Claude Code — \`--editor claude\`. В другом редакторе узнай поддерживаемую папку скиллов и используй \`--dest <папка>/figma-spark\`. Установщик не изменяет настройки редактора; обновление существующей установки требует \`--update\` и сохраняет резервную копию. Если установка в задаче не разрешена, предложи её и используй загруженный скилл в этой сессии.
3. Подтверди живое подключение: \`${command} connect ${shellQuote(manifest.connectURL)}\`. CLI читает локальную конфигурацию сам. Не вставляй token, pairing code или содержимое конфигурации в чат. Конфигурация: \`${local.configPath}\`.
4. ${sessionId && sessionAvailable ? `Ссылка выбрала сессию \`${sessionId}\`. Передавай этот ID во всех запросах.` : 'Сессия не выбрана или уже переподключилась. Получи status и выбери файл по задаче пользователя; несколько файлов не объединяй.'} Начни с \`${command} overview${selected}\`.
5. Далее — обзор страниц/экранов → поиск в нужной области → компактный snapshot выбранных node IDs. По умолчанию 100 слоёв, следующие порции запрашиваются явно. Не выгружай весь файл. Общие определения компонентов читай один раз, текст и overrides экземпляров проверяй отдельно.
6. При сверке с документацией указывай источник требования, node IDs и coverage. Неполные данные не подтверждают отсутствие элемента. Отчёт верни в чат; большие снимки и изображения сохраняй в файлы. Обычный режим плагина — чтение.

Машиночитаемое описание подключения: ${manifest.connectURL}${manifest.connectURL.includes('?') ? '&' : '?'}format=json

Нужны локальный инструмент на этом компьютере, работающий сервис и открытый Figma Design-файл с плагином. Если сервис остановлен, запусти \`npm run service -- start\` в \`${local.project}\`. Он работает в фоне после завершения терминала. Проверка: \`npm run service -- status\`; перезапуск: \`npm run service -- restart\`. После смены конфигурации пересобери плагин: \`npm run build\`.
`;
}
