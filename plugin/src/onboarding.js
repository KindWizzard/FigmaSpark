export function connectionPrompt({ url, online, startCommand }) {
  return `Подключись к Figma через FigmaSpark. Локальная инструкция:
${url}
${online ? '' : `Сервис сейчас отключён. Если у тебя есть локальный терминал, сначала выполни: ${startCommand}\n`}В Claude Desktop с инструментами FigmaSpark вызови figma_spark_connect с этой ссылкой.
В Claude Code (в том числе режим Code приложения), Codex или Cursor получи инструкцию именно через локальный терминал: curl --fail --silent --show-error --max-time 5 '${url}'. Затем установи/используй скилл figma-spark и начни с overview.
Не открывай localhost через облачный WebFetch. Обычный чат claude.ai не видит мой компьютер; если локальных инструментов нет, объясни это и предложи режим Code или подключение FigmaSpark в Claude Desktop.`;
}
