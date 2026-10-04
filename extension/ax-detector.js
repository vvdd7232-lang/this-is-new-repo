/* AI Execute Runner — ax-detector.js
 * Чистые функции детекции: распознавание execute-блоков, сниффер языка,
 * опасные паттерны, нормализация текста. Без побочек и без обращений к chrome.*
 *
 * UMD: в браузере вешается на window.AXDetector, в Node — module.exports.
 * Благодаря этому detectRunner/sniffRunner можно тестировать в jsdom (см. tests/).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AXDetector = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Языки блоков, которые считаем исполняемыми.
  const EXEC_LANGS = new Map([
    ['execute', 'shell'], ['exec', 'shell'], ['shell-execute', 'shell'],
    ['terminal', 'shell'], ['cmd-exec', 'shell'],
    ['execute-python', 'python'], ['execute:python', 'python'],
    ['exec-python', 'python'], ['python-exec', 'python'],
    ['execute-js', 'node'], ['execute:js', 'node'], ['exec-js', 'node'],
    ['execute-node', 'node'], ['node-exec', 'node'],
    ['execute-pwsh', 'powershell'], ['execute-powershell', 'powershell'],
    ['exec-pwsh', 'powershell'],
    // MCP [экспериментально]: блок execute-mcp выполняет инструмент внешнего
    // MCP-сервера, а не shell-команду. Содержимое — JSON с полями
    // server / tool / arguments.
    ['execute-mcp', 'mcp'], ['execute:mcp', 'mcp'], ['exec-mcp', 'mcp'],
    ['mcp-execute', 'mcp'],
  ]);

  // Unicode-пробелы и невидимые модификаторы (NBSP и родня) — их вставляют
  // чаты в code-блоки, они ломают Python/PowerShell парсеры.
  const UNICODE_SPACES_RE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;
  const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g;
  function normalizeWhitespace(text) {
    if (!text) return text;
    return String(text).replace(UNICODE_SPACES_RE, ' ').replace(ZERO_WIDTH_RE, '');
  }

  // Опасные паттерны разделены на два уровня:
  //   HARD — необратимые/разрушительные действия. Блокируют АВТОзапуск
  //          (ручной ▶ с подтверждением по-прежнему доступен).
  //   SOFT — подозрительные конструкции динамического выполнения кода
  //          (eval/exec и аналоги), часто встречающиеся в легитимном коде:
  //          тесты, кодогенераторы, скрипты-обёртки. Автопилот их НЕ блокирует —
  //          только подсветка в модалке подтверждения.
  // Разделение появилось после реального ложного срабатывания: команда,
  // генерирующая файл с regex-паттернами опасных команд внутри, глушилась
  // автопилотом, хотя ничего опасного не делала.
  const DANGER_HARD = [
    /:\(\)\s*\{\s*:\|:\s*&\s*\}/,
    /\bmkfs\b/i, /\bdd\s+if=/i, /\bshutdown\b/i, /\breboot\b/i,
    /\bformat\s+[a-z]:/i, /del\s+\/[fs]/i, /rd\s+\/s/i,
    /\bsudo\b/i, /chmod\s+-R\s+777/i, /curl.*\|\s*(bash|sh)/i, /wget.*\|\s*(bash|sh)/i,
    /git\s+push\s+.*--force/i, /git\s+push\s+-f\b/i, /npm\s+publish/i,
    /\bDROP\s+(TABLE|DATABASE)\b/i, /\bTRUNCATE\s+TABLE\b/i,
    /while\s+true\s*;\s*do\s+/, /for\s*\(\s*;\s*;\s*\)/,
    /\bhalt\b/i, /\bpoweroff\b/i, /\bdoas\b/i,
  ];
  const DANGER_SOFT = [
    /\beval\s*\(/i, /\bexec\s*\(/i, /Invoke[\s-]*Expression/i,
  ];

  // --- Второй проход: «подписи» необратимых действий вне кавычек -------------
  // Зачем: stripStringLiterals() вырезает содержимое строк, чтобы упоминания
  // опасных слов в литералах не блокировали автозапуск. Побочный эффект был
  // дырой: `rm -rf "/"` или `bash -c "rm -rf /"` после вырезания кавычек
  // перестают совпадать с DANGER_HARD и уходят в автопилот.
  // Поэтому проверяем ЕЩЁ РАЗ — по некавычечным фрагментам (там, где команда
  // реально исполняется) и с учётом «опасных» аргументов, которые как раз
  // обычно стоят внутри кавычек.
  const DANGEROUS_ARGS = [
    /^\s*[\/~*]/,
    /^\s*\/\*/,
    /^\s*\*/,
    /^\s*\$HOME\b/i,
    /^\s*\$\{?HOME\}?/i,
    /^\s*%USERPROFILE%/i,
    /^\s*%HOMEPATH%/i,
    /^\s*\$env:USERPROFILE/i,
    /^\s*[A-Za-z]:[\\/]?\s*$/,
  ];
  // «Голые» подписи (проверяются прямо в тексте некавычечного фрагмента).
  const BARE_SIGNATURES = [
    /:\(\)\s*\{\s*:\|:\s*&\s*\}/,           // fork bomb
    /\bInvoke[\s-]*Expression\b/i,           // IEX — динамический код
    /\bFormat-Volume\b/i,
    /\bClear-Disk\b/i,
    /\bInitialize-Disk\b/i,
    /\bdiskpart\b/i,
    /\bDeltree\b/i,
    /\bgit\s+clean\b[^\n]*(-[a-z]*f[a-z]*d|[a-z]*d[a-z]*f)/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\breg\s+delete\b/i,
    /\bbcdedit\b/i,
    /\bvssadmin\s+delete\s+shadows\b/i,
    /\bcipher\s+\/w\b/i,
    /\btskill\b/i,
    /\btaskkill\b[^\n]*\/f\b/i,
    /\bnpm\s+publish\b/i,
    /\bgit\s+push\b[^\n]*(--force\b|-f\b)/i,
    /\b(shutdown|poweroff|halt|reboot|doas)\b/i,
    /\bmkfs(\.\w+)?\b/i,
    /\bdd\s+if=/i,
    /\bDROP\s+(TABLE|DATABASE)\b/i,
    /\bTRUNCATE\s+TABLE\b/i,
    /\bwhile\s+true\s*;\s*do\s+/,
    /\bfor\s*\(\s*;\s*;\s*\)/,
    /\bchmod\s+-R\s+777\b/i,
    /\b(Stop-Computer|Restart-Computer)\b/i,
  ];
  // Подписи-КОМАНДЫ: должны стоять в начале команды (или после ; | && ), иначе
  // это упоминание в аргументе: `grep -r "Remove-Item -Recurse" .`,
  // `git log --grep="shutil.rmtree"` — не выполнение, а поиск.
  const CMD_BOUNDARY = '(?:^|[;&|]\\s*|&&\\s*|\\|\\|\\s*|\\n\\s*)';
  const COMMAND_SIGNATURES = [
    { re: new RegExp(CMD_BOUNDARY + 'Remove-Item\\b[^\\n]*?(?:-Recurse\\b|-r\\b)', 'i') },
    { re: new RegExp(CMD_BOUNDARY + '(?:rd|rmdir)\\b[^\\n]{0,24}?(?:\\/[a-z]+\\s+)*[A-Za-z]:[\\\\/]', 'i') },
    { re: new RegExp(CMD_BOUNDARY + 'del\\b[^\\n]{0,24}?(?:\\/[a-z]+\\s+)*[A-Za-z]:[\\\\/]', 'i') },
    { re: new RegExp(CMD_BOUNDARY + '(?:bash|sh|zsh|dash|ksh)\\s+-c\\b', 'i') },
  ];
  // Команды с аргументами-путями: имя + аргументы проверяем отдельно, чтобы
  // учитывать кавычки внутри аргументов.
  const CMDS_WITH_ARGS = [
    { re: /\brm\b\s+(-[a-z]+\s+)*/i, needsForce: true },
    { re: /\brd\b\s*(\/[a-z]+\s*)*/i, needsForce: false },
    { re: /\brmdir\b\s*(\/[a-z]+\s*)*/i, needsForce: false },
    { re: /\bdel\b\s*(\/[a-z]+\s*)*/i, needsForce: false },
    { re: /\bRemove-Item\b\s+/i, needsForce: false },
  ];
  // Разбивает команду на фрагменты «вне кавычек» (там, где текст реально
  // исполняется). Экранированные (\", \') и удвоенные ("") кавычки строку не
  // закрывают. Соседние литералы склеиваются в один разделитель.
  function unquotedSegments(cmd) {
    const s = String(cmd == null ? '' : cmd);
    const out = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        if (ch === '\\' && quote === '"' && i + 1 < s.length) { i++; continue; }
        if (ch === quote) {
          if (s[i + 1] === quote) { i++; continue; }
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  // Токенизатор аргументов с флагом «был в кавычках». Нужен, чтобы отличить
  // `rm -rf /` (голый корень = беда) от `rm -rf "/"` (то же самое, но кавычки
  // вырезаны первым проходом) и при этом не путать с `rm -rf /tmp/build`.
  // Работает и с текстом, где кавычки уже вырезаны: экранированные кавычки без
  // обрамления просто остаются символами.
  function scanArgs(text) {
    const s = String(text == null ? '' : text);
    const args = [];
    let i = 0;
    let quote = null;         // текущая кавычка
    let tk = '';
    let tkQuoted = false;
    const flush = () => {
      if (tk) { args.push({ text: tk, quoted: tkQuoted }); tk = ''; tkQuoted = false; }
    };
    while (i < s.length) {
      const ch = s[i];
      if (!quote) {
        if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') break;
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; tkQuoted = true; i++; continue; }
        if (/\s/.test(ch)) { flush(); i++; continue; }
        if (ch === '\\' && i + 1 < s.length && /["'\s]/.test(s[i + 1])) { tk += s[i + 1]; i += 2; continue; }
        tk += ch; i++; continue;
      }
      // внутри кавычек
      if (ch === '\\' && quote === '"' && i + 1 < s.length) { tk += s[i + 1]; i += 2; continue; }
      if (ch === quote) {
        if (s[i + 1] === quote) { tk += ch; i += 2; continue; }
        quote = null; i++; continue;
      }
      tk += ch; i++;
    }
    flush();
    return { args };
  }

  // Нормализуем «голый» Windows-путь, который остался от вырезанных кавычек:
  // `C:\\Users` после stripStringLiterals выглядит так же, как настоящий
  // `C:\Users`, поэтому дополнительно сверяемся с исходной строкой.
  function isQuotedAt(raw, token) {
    if (!raw || !token) return false;
    const idx = String(raw).indexOf(token);
    if (idx <= 0) return false;
    const before = String(raw)[idx - 1];
    return before === '"' || before === "'" || before === '`';
  }

  // Системные корни и служебные каталоги: удаление/затирание внутри них —
  // всегда разрушительно. Рабочие каталоги (`/tmp/build`, `C:\build\out`)
  // сюда не попадают, иначе автопилот блокировал бы обычную уборку мусора.
  const SYS_ROOT_PATH = new RegExp(
    '^(?:[\\/~]|\\*' +
    '|/+(?:etc|usr|bin|sbin|lib|boot|dev|proc|sys|var|opt|srv|root|home|System|Applications|Library|Users|Volumes)(?:/|$)' +
    '|[A-Za-z]:[\\\\/]?(?:[Ww]indows|[Pp]rogram [Ff]iles(?: \\(x86\\))?|[Uu]sers)?[\\\\/]?$' +
    '|\\$HOME|\\$\\{HOME\\}|%USERPROFILE%|%HOMEPATH%|\\$env:USERPROFILE)$', 'i');

  function hasDangerousArg(after) {
    const { args } = scanArgs(after);
    for (const a of args) {
      const t = a.text.replace(/[\u00a0\s]+$/, '');
      if (!t) continue;
      if (t === '-' || t === '--') continue;
      if (/^-/.test(t)) continue;                       // это флаг, не путь
      if (SYS_ROOT_PATH.test(t)) return true;
      // Путь к рабочему каталогу опасен, только если его специально закрыли
      // кавычками (`rm -rf "/"`), — значит, цель не случайная.
      if (a.quoted) {
        for (const re of DANGEROUS_ARGS) if (re.test(t)) return true;
      }
    }
    return false;
  }

  function hasDangerousSignature(cmd) {
    const segs = unquotedSegments(cmd);
    for (const seg of segs) {
      if (!seg) continue;
      for (const re of BARE_SIGNATURES) if (re.test(seg)) return true;
      for (const { re } of COMMAND_SIGNATURES) if (re.test(seg)) return true;
      for (const { re, needsForce } of CMDS_WITH_ARGS) {
        const m = re.exec(seg);
        if (!m) continue;
        if (needsForce && !/-[a-z]*[rf]/i.test(m[0])) continue;
        if (hasDangerousArg(seg.slice(m.index + m[0].length))) return true;
      }
    }
    // Обёртки «выполнить строку как код»: содержимое кавычек здесь не данные,
    // а команда, поэтому анализируем его как обычную команду (рекурсивно).
    // Именно так прятали `rm -rf /` в `bash -c "rm -rf /"`.
    const wrapped = ['bash', 'sh', 'zsh', 'dash', 'ksh', 'cmd', 'powershell', 'pwsh', 'python', 'python3', 'node'];
    const wrapper = new RegExp('\\b(' + wrapped.join('|') + ')\\b[^\\n]{0,40}?(?:-c|-e|-Command|--eval|/c)\\s+(["\'])([\\s\\S]*?)\\2', 'i');
    const wm = wrapper.exec(String(cmd == null ? '' : cmd));
    if (wm && wm[3] && wm[3].trim() && wm[3].length < String(cmd).length) {
      if (dangerLevel(wm[3]) === 'hard') return true;
    }
    // Третий слой: проверяем и текст ВНУТРИ кавычек, но только когда внутри
    // лежит короткая команда-подпись. Это то, что теряли оба прохода выше:
    // `rm -rf "/"`, `rm -rf "$HOME"`, `python -c "import shutil; shutil.rmtree('/')"`.
    // Легитимный код, который лишь УПОМИНАЕТ опасное слово в литерале
    // (`f.write("sudo apt")`, тесты детектора), по-прежнему не блокируется:
    // там нет короткой команды, начинающейся с деструктивного глагола.
    return hasDangerousLiteral(cmd);
  }

  // Подписи «внутри кавычек»: деструктивный глагол + его цель.
  const LITERAL_SIGNATURES = [
    /\brm\b[^"'`\n]{0,24}?-[a-z]*[rf][a-z]*[^"'`\n]{0,40}?["'`]\s*(?:\/|~|\*|\$HOME|\$\{HOME\}|%USERPROFILE%|[A-Za-z]:[\\/])["'`]/i,
    /\brm\b\s+["'`]\s*(?:\/|~|\*|\$HOME|\$\{HOME\}|%USERPROFILE%|[A-Za-z]:[\\/])\s*["'`]/i,
    /\b(?:rd|rmdir)\b(?=[^"'`\n]{0,20}?\/s\b)[^"'`\n]{0,20}?[A-Za-z]:[\\/][^"'`\n]*/i,
    /\bdel\b[^"'`\n]{0,20}?[A-Za-z]:[\\/][^"'`\n]*/i,
    /(?:^|[;&|]\s*)\s*(?:import\s+shutil[\s\S]{0,80}?)?\bshutil\s*\.\s*rmtree\b/i,
    /(?:^|[;&|]\s*)\s*\bos\s*\.\s*(?:remove|unlink|rmdir)\s*\(/i,
    /(?:^|[;&|]\s*)\s*\bfs\s*\.\s*(?:rm|rmdir|unlink)\w*\s*\(/i,
    /(?:^|[;&|]\s*)\s*\bRemove-Item\b[^"'`\n]*-(?:Recurse|-r\b)/i,
    /(?:^|[;&|]\s*)\s*(?:require\s*\(\s*['"`]fs['"`]\s*\)\s*\.\s*)?rmSync\s*\(/i,
  ];
  // Маркеры «это запись файла, а не выполнение»: если в команде есть такой
  // вызов, содержимое литералов считаем данными и не поднимаем до hard.
  const WRITE_MARKERS = /\b(?:write|writelines|writeln|WriteAllText|WriteAllLines|Set-Content|Out-File|Add-Content|appendFile|writeFile|writeFileSync|createWriteStream|print)\s*[(«"]|\bWrite-Host\b|>{1,2}\s*["'\w]|<<-?\s*["']?\w+/i;

  function hasDangerousLiteral(cmd) {
    const s = String(cmd == null ? '' : cmd);
    if (!s || !/["'`]/.test(s)) return false;
    for (const re of LITERAL_SIGNATURES) {
      if (re.test(s)) return !WRITE_MARKERS.test(s);
    }
    return false;
  }

  // Грубо вырезает содержимое строковых литералов и heredoc'ов перед проверкой.
  // Смысл: когда ИИ пишет ФАЙЛ, в тексте которого просто упоминаются опасные
  // слова (тесты whitelist'а, regex-паттерны детектора, документация) — это
  // ещё не выполнение этих действий. Убираем содержимое строк, чтобы такие
  // упоминания не блокировали автозапуск легитимной команды.
  // Настоящий вызов системной команды вне кавычек — остаётся и блокируется.
  function stripStringLiterals(cmd) {
    if (!cmd) return '';
    let s = String(cmd);
    s = s.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\b/g, '<<HEREDOC>>');
    s = s.replace(/"""[\s\S]*?"""/g, '""');
    s = s.replace(/'{3}[\s\S]*?'{3}/g, "''");
    s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    s = s.replace(/`[^`]*`/g, '``');
    return s;
  }

  // --- Человеческое объяснение ошибок выполнения ---------------------------
  // Смысл: сырой stderr вида «'gti' is not recognized…» понятен не всем, а ИИ
  // в чате видит только текст. Переводим типовые провалы в «что случилось +
  // что сделать», не заменяя исходный вывод.
  // Правила упорядочены от частного к общему: первое совпадение выигрывает.
  const FAILURE_RULES = [
    {
      id: 'timeout',
      test: (x) => /\[TIMEOUT \d+s\]/.test(x.stderr) || x.timedOut === true || x.exitCode === 124,
      title: 'Команда не успела выполниться',
      hint: 'Увеличь таймаут (⚙️ → «Таймаут команды», сейчас действует на всю команду) или разбей работу на части. Уже напечатанный вывод сохранён.',
    },
    {
      id: 'unknown-command-windows',
      test: (x) => /is not recognized as an internal or external command/i.test(x.stderr),
      title: 'Такой команды нет в системе',
      hint: 'Проверь опечатку в имени, установлена ли программа и есть ли она в PATH. Для Unix-команд на Windows нужен WSL или Git Bash.',
    },
    {
      id: 'node-command',
      test: (x) => /node: command not found|'node' is not recognized/i.test(x.stderr),
      title: 'Node.js не установлен',
      hint: 'Блок `execute-js` требует Node.js. Альтернатива — попросить ИИ написать на Python (`execute-python`).',
    },
    {
      id: 'unknown-command-unix',
      test: (x) => /command not found|: not found$/im.test(x.stderr),
      title: 'Команда не найдена',
      hint: 'Проверь имя и PATH: `which <команда>`. Возможно, пакет не установлен.',
    },
    {
      id: 'path-not-found-ps',
      test: (x) => /Cannot find (path|drive)|because it does not exist|не удается найти путь/i.test(x.stderr),
      title: 'Путь не найден',
      hint: 'Проверь рабочую папку в результате (`cwd`) — относительные пути считаются от неё. Надёжнее указывать абсолютный путь. Важно: PowerShell при этом часто отдаёт exit=0 и пишет ошибку только в stderr.',
    },
    {
      id: 'file-not-found-generic',
      test: (x) => /No such file or directory|ENOENT/i.test(x.stderr),
      title: 'Файл или папка не найдены',
      hint: 'Сверь путь с фактическим (`ls` / `dir`) и учти, что команда выполняется в рабочей папке из настроек.',
    },
    {
      id: 'permission',
      test: (x) => /permission denied|EACCES|EPERM|access (is |to the path .* is )?denied|отказано в доступе/i.test(x.stderr),
      title: 'Недостаточно прав',
      hint: 'Файл занят другой программой либо нужны права администратора. Не запускай сервер от админа без необходимости — лучше выбери папку, доступную пользователю.',
    },
    {
      id: 'python-name',
      test: (x) => /NameError: name '([^']+)' is not defined/.test(x.stderr),
      title: 'Python: переменная не определена',
      hint: 'Чаще всего имя использовано до присваивания или опечатка в регистре.',
    },
    {
      id: 'python-module',
      test: (x) => /ModuleNotFoundError: No module named '([^']+)'/.test(x.stderr),
      title: 'Python: модуль не установлен',
      hint: 'Установи пакет: `pip install <модуль>`. Учти, что сервер и ИИ используют один и тот же Python.',
    },
    {
      id: 'python-syntax-nbsp',
      test: (x) => /invalid non-printable character U\+00A0|invalid character/i.test(x.stderr),
      title: 'Python: неразрывный пробел в коде',
      hint: 'Чат вставил NBSP (U+00A0) вместо пробела. Расширение вычищает такие символы автоматически — если ошибка осталась, проверь скрытые символы в строке.',
    },
    {
      id: 'python-syntax',
      test: (x) => /SyntaxError|IndentationError|TabError/.test(x.stderr),
      title: 'Python: синтаксис или отступы',
      hint: 'Проверь отступы (табы и пробелы в одном блоке) и незакрытые скобки. Номер проблемной строки указан в тексте ошибки.',
    },
    {
      id: 'python-traceback',
      test: (x) => /Traceback \(most recent call last\)/.test(x.stderr),
      title: 'Python: исключение во время выполнения',
      hint: 'Смотри последнюю строку трейсбека — там тип и причина. Выше видно файл и номер строки.',
    },
    {
      id: 'node-module',
      test: (x) => /Cannot find module '([^']+)'/.test(x.stderr),
      title: 'Node: модуль не найден',
      hint: 'Поставь зависимости (`npm install`) или укажи правильный путь. Для встроенных модулей проверь написание имени.',
    },
    {
      id: 'port-busy',
      test: (x) => /EADDRINUSE|address already in use|WinError 10048|Only one usage of each socket address/i.test(x.stderr),
      title: 'Порт уже занят',
      hint: 'Освободи порт или запусти на другом: `python server.py --port 8766` (и поменяй адрес в настройках расширения).',
    },
    {
      id: 'encoding',
      test: (x) => /UnicodeDecodeError|UnicodeEncodeError|codec can't (decode|encode)|charmap/i.test(x.stderr),
      title: 'Проблема с кодировкой текста',
      hint: 'Кириллица попала в поток, который ждали в другой кодировке. Сервер уже подставляет UTF-8 для python; если ошибка в самом скрипте — открой файл с `encoding="utf-8"`.',
    },
    {
      id: 'network',
      test: (x) => /Could not resolve host|Temporary failure in name resolution|getaddrinfo|ECONNREFUSED|connection refused/i.test(x.stderr),
      title: 'Сеть недоступна',
      hint: 'Проверь интернет, прокси и адрес хоста. В корпоративной сети может мешать файрвол.',
    },
    {
      id: 'silent-fail-windows',
      test: (x) => x.platform === 'windows' && x.exitCode !== 0 && !x.stdout && !x.stderr,
      title: 'Команда завершилась с ошибкой без вывода',
      hint: 'Бывает при ошибке в синтаксисе пакетного файла или при неверном пути. Запусти ту же команду вручную в консоли, чтобы увидеть текст.',
    },
  ];

  /**
   * Разбирает результат выполнения и возвращает объяснение для пользователя.
   * @returns {null | {id: string, title: string, hint: string}}
   */
  function describeFailure(result) {
    const r = result || {};
    const exitCode = (typeof r.exit_code === 'number') ? r.exit_code : (typeof r.exitCode === 'number' ? r.exitCode : null);
    const stderr = String(r.stderr == null ? '' : r.stderr);
    const stdout = String(r.stdout == null ? '' : r.stdout);
    const serverError = String(r.error == null ? '' : r.error);
    const x = {
      exitCode: exitCode,
      stdout: stdout,
      stderr: stderr,
      timedOut: !!r.timed_out,
      blocked: !!r.blocked,
      platform: (r.platform === 'windows' || r.platform === 'Windows') ? 'windows' : 'unix',
    };

    // Не запускалось вовсе — это не «ошибка команды», а отказ до запуска.
    if (r.blocked || /whitelist/i.test(serverError)) {
      return {
        id: 'blocked',
        title: 'Запуск заблокирован whitelist',
        hint: 'Команда не входит в список разрешённых. Либо запусти её вручную кнопкой, либо добавь префикс в файл whitelist и перезапусти сервер.',
      };
    }
    if (serverError && !/^HTTP \d/.test(serverError)) {
      if (/cwd/i.test(serverError)) {
        return { id: 'bad-cwd', title: 'Рабочая папка не существует', hint: 'Проверь путь в ⚙️ → «Рабочая папка для команд» — он должен существовать на диске.' };
      }
      if (/interpreter not found/i.test(serverError)) {
        return { id: 'no-interpreter', title: 'Интерпретатор не найден', hint: 'Для этой среды не установлена программа (например, node или powershell). Переключи среду на панели или установи её.' };
      }
      return { id: 'server-error', title: 'Сервер не смог выполнить команду', hint: serverError };
    }

    // Нет вывода и код 0 — команда прошла, объяснять нечего.
    // Важно: exit=0 сам по себе НЕ значит успех. PowerShell на ненайденный путь
    // отдаёт 0 и пишет ошибку только в stderr (классика, описана в
    // TROUBLESHOOTING), поэтому при непустом stderr правила всё равно проверяем.
    if (exitCode === 0 && !x.timedOut && !stderr.trim()) return null;

    for (const rule of FAILURE_RULES) {
      let hit = false;
      try { hit = !!rule.test(x); } catch (e) { hit = false; }
      if (hit) return { id: rule.id, title: rule.title, hint: rule.hint };
    }

    if (exitCode !== 0 && exitCode !== null) {
      return {
        id: 'exit-code',
        title: 'Команда завершилась с кодом ' + exitCode,
        hint: 'Подробности — в блоке вывода ниже (stderr). Если текста нет, запусти ту же команду вручную в консоли.',
      };
    }
    return null;
  }

  function dangerLevel(cmd) {
    const c = stripStringLiterals(cmd || '');
    if (DANGER_HARD.some((re) => re.test(c))) return 'hard';
    if (DANGER_SOFT.some((re) => re.test(c))) return 'soft';
    // Второй проход по некавычечным фрагментам: ловит то, что первый проход
    // потерял вместе с вырезанными литералами (см. hasDangerousSignature).
    const raw = String(cmd == null ? '' : cmd);
    if (hasDangerousSignature(raw)) return 'hard';
    return null;
  }
  // HARD блокирует автозапуск и форсит подтверждение даже при выключенном
  // requireConfirm. SOFT — только подсветка, автопилот проходит.
  function isHardDangerous(cmd) { return dangerLevel(cmd) === 'hard'; }
  // Совместимое имя: «есть ли вообще что-то подозрительное» (hard или soft).
  function isDangerous(cmd) { return dangerLevel(cmd) !== null; }

  // --- опасные MCP-инструменты ------------------------------------------------
  // Инструмент может исполнять произвольный код (execute_blender_code, run_code)
  // или удалять данные. Для них подтверждение нужно ВСЕГДА, даже при включённом
  // автопилоте: иначе модель сама выполнит произвольный код в Blender/Godot.
  const DANGEROUS_MCP_TOOLS = [
    /execute/i, /run_code/i, /eval/i, /exec/i,
    /^(write|edit|delete|remove|drop|destroy)_/i,
    /_write$/i, /_delete$/i, /_remove$/i,
    /save_scene/i, /export/i,
  ];
  // Инструменты, которые меняют проект, но не разрушают его: подтверждение
  // по общим правилам (requireConfirm), автопилот проходит.
  function mcpToolDanger(toolName) {
    const t = String(toolName || '').trim();
    if (!t) return null;
    return DANGEROUS_MCP_TOOLS.some((re) => re.test(t)) ? 'hard' : null;
  }
  // Уровень опасности всего MCP-блока: смотрим и сервер, и инструмент.
  function mcpBlockDanger(cmd) {
    const m = String(cmd || '').match(/"tool"\s*:\s*"([^"]*)"/);
    const tool = m ? m[1] : '';
    if (mcpToolDanger(tool) === 'hard') return 'hard';
    // Неизвестный инструмент без подтверждения опасен по определению:
    // не знаем, что он делает.
    return tool ? null : 'hard';
  }

  const RUNNER_OPTIONS = [
    ['shell', 'shell'],
    ['powershell', 'powershell'],
    ['python', 'python'],
    ['node', 'node'],
    // mcp нужен здесь по двум причинам: runnerValid() должен признавать среду
    // (иначе теряется память среды блока), а fillRunnerSelect() строит список
    // выбора именно из RUNNER_OPTIONS — без 'mcp' селект для блока execute-mcp
    // оставался бы на 'shell', и JSON ушёл бы в cmd.
    ['mcp', 'mcp'],
  ];
  function runnerValid(r) { return RUNNER_OPTIONS.some(([v]) => v === r) ? r : null; }

  function normLang(s) {
    return (s || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  }

  // --- маскирование секретов ------------------------------------------------
  // Журнал выполнений и палитра команд хранятся локально, но журнал ещё и
  // выгружается в .md — а туда попадает всё, что лежит в storage. Поэтому
  // значение токена/пароля в команде не должно туда уехать никогда.
  // Работаем только с текстом (без chrome.*), поэтому функция тестируется в Node.
  const SECRET_MASK = '«скрыто»';
  // «ключ = значение»: типичные имена параметров с секретами.
  const SECRET_KV_RE = /((?:--|\-\/)?(?:x-auth-token|auth[-_]?token|token|password|passwd|pwd|secret|api[-_]?key|access[-_]?token|private[-_]?key|client[-_]?secret)\s*[=:]?\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi;
  // Значение после «Bearer»/«Basic» в заголовке Authorization.
  const BEARER_RE = /\b(bearer|basic)\s+[\w.\-+/=]{6,}/gi;

  /**
   * Заменяет секреты в тексте команды на «скрыто».
   * @param {string} text — исходная команда
   * @param {string[]} [extraSecrets] — точные значения, которые надо скрыть
   *        (например, настроенный токен локального сервера)
   * @returns {string} тот же текст с замаскированными секретами
   */
  function redactSecrets(text, extraSecrets) {
    const src = String(text == null ? '' : text);
    if (!src) return src;
    let out = src;
    // Точные значения: короткие не трогаем — иначе замаскируется любая команда.
    const extras = Array.isArray(extraSecrets) ? extraSecrets : (extraSecrets ? [extraSecrets] : []);
    for (const raw of extras) {
      const value = String(raw == null ? '' : raw).trim();
      if (value.length < 8) continue;
      if (out.indexOf(value) !== -1) out = out.split(value).join(SECRET_MASK);
    }
    out = out.replace(BEARER_RE, (_m, kind) => kind + ' ' + SECRET_MASK);
    out = out.replace(SECRET_KV_RE, (_m, key) => key + SECRET_MASK);
    return out;
  }

  // Сниффер содержимого для ПРОСТЫХ execute-блоков (без суффикса языка):
  // если код очевидно на python/powershell/node — выполняем в правильной среде,
  // а не в shell. Смотрим ТОЛЬКО первую значимую строку, пропуская комментарии.
  function sniffRunner(command) {
    const lines = (command || '').split('\n');
    let line = '';
    let inBlock = null;
    for (const s of lines) {
      let t = s.trim();
      if (inBlock === 'ps') {
        const end = t.indexOf('#>');
        if (end === -1) continue;
        inBlock = null;
        t = t.slice(end + 2).trim();
        if (!t) continue;
      }
      if (inBlock === 'c') {
        const end = t.indexOf('*/');
        if (end === -1) continue;
        inBlock = null;
        t = t.slice(end + 2).trim();
        if (!t) continue;
      }
      if (!t) continue;
      if (t.startsWith('<#')) {
        const end = t.indexOf('#>', 2);
        if (end === -1) { inBlock = 'ps'; continue; }
        t = t.slice(end + 2).trim();
        if (!t) continue;
      }
      if (t.startsWith('/*')) {
        const end = t.indexOf('*/', 2);
        if (end === -1) { inBlock = 'c'; continue; }
        t = t.slice(end + 2).trim();
        if (!t) continue;
      }
      if (/^(#|\/\/|rem\s)/i.test(t)) continue;
      line = t; break;
    }
    if (!line) return null;
    if (/^(import\s+[\w.]+(\s*,\s*[\w.]+)*\s*(;|$|#)|from\s+[\w.]+\s+import[\s(]|(async\s+)?def\s+\w+\s*\(|print\s*\(|print\s+["']|class\s+\w+(\([^)]*\))?\s*:(?!\s*\w+\s*\{)|@\w[\w.]*|if\s+__name__\s*==)/.test(line)) return 'python';
    if (/^(console\.(log|error|warn)\s*\(|require\s*\(|(const|let|var)\s+[\w\s{},:*]+\s*=\s*require\s*\(|import\s+.+\s+from\s+["']|export\s+(default|const\b|let\b|var\b|function\b|class\b|async\b|\{)|async\s+function\b)/.test(line)) return 'node';
    if (/^((Get|Set|New|Remove|Start|Stop|Test|Write|Read|Import|Export|Invoke|Out|Select|Where|ForEach|Sort|Measure|Compare|Resolve|Split|Join|Clear|Copy|Move|Rename|Restart|Suspend|Update|Wait|Add|Format|ConvertTo|ConvertFrom|Group|Tee|Unblock|Compress|Expand|Push|Pop)-[A-Z]\w*|param\s*\(|function\s+[A-Za-z]+-|class\s+\w+(\s*:\s*\w+)?\s*\{|\$[A-Za-z_][\w:]*\s*=|\$PSVersionTable\b|\[[A-Za-z_][\w.]*\]::)/.test(line)) return 'powershell';
    return null;
  }

  // --- DOM-зависимые функции (тестируются через jsdom) ---

  function getCodeText(pre) {
    const code = pre.querySelector('code');
    const raw = (code ? (code.innerText != null ? code.innerText : code.textContent) : (pre.innerText != null ? pre.innerText : pre.textContent)) || '';
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    if (lines.length && /^(?:#!\/usr\/bin\/env\s+|#!|\/\/|#)\s*(?:execut(?:e|ion)?|exec)(?:[-:][a-z0-9_-]+)?$/i.test(lines[0].trim()))
      lines.shift();
    return normalizeWhitespace(lines.join('\n').replace(/\n+$/, ''));
  }

  // Пытаемся определить язык блока <pre> разными способами под разные сайты.
  function detectRunner(pre) {
    const code = pre.querySelector('code');
    const exact = [];
    const fuzzy = [];
    const pushE = (v) => { if (v && typeof v === 'string') exact.push(v); };
    const pushF = (v) => { if (v && typeof v === 'string' && v.trim() && v.trim().length <= 80) fuzzy.push(v.trim()); };

    for (const el of [code, pre]) {
      if (!el || !el.classList) continue;
      for (const c of el.classList) {
        const m = String(c).match(/(?:language|lang)-(.+)/i);
        if (m) pushE(m[1]);
        else if (/exec/i.test(c)) pushE(c);
      }
    }
    const chain = [code, pre, pre.parentElement, pre.parentElement && pre.parentElement.parentElement];
    for (const el of chain) {
      if (!el || !el.dataset) continue;
      pushE(el.dataset.language);
      pushE(el.dataset.lang);
      try {
        for (const v of Object.values(el.dataset)) {
          if (typeof v === 'string' && v.length <= 60) pushE(v);
        }
      } catch (e) { /* ignore */ }
    }
    for (const el of [code, pre]) {
      if (!el || !el.getAttribute) continue;
      pushE(el.getAttribute('data-language'));
      pushE(el.getAttribute('data-lang'));
      pushE(el.getAttribute('title'));
      pushE(el.getAttribute('aria-label'));
    }
    const container = pre.closest('div');
    if (container) {
      const labels = container.querySelectorAll(
        '[data-testid*="language"], .language-label, [class*="language"], [class*="lang-"], ' +
        'span.font-mono, div.text-xs, [class*="code-header"], [class*="codeheader"], ' +
        '[class*="CodeBlock"] [class*="header"], [class*="toolbar"]'
      );
      labels.forEach((label) => { if (label.textContent) pushF(label.textContent); });
    }
    for (const sib of [pre.previousElementSibling, pre.nextElementSibling]) {
      if (!sib || !sib.textContent) continue;
      if (sib.classList && sib.classList.contains('ax-exec-panel')) continue;
      pushF(sib.textContent);
    }
    try {
      const first = pre.firstElementChild;
      if (code && first && first.tagName !== 'CODE' && first.textContent) pushF(first.textContent);
    } catch (e) { /* ignore */ }

    for (const c of exact.concat(fuzzy)) {
      const n = normLang(c);
      if (EXEC_LANGS.has(n)) return { lang: n, runner: EXEC_LANGS.get(n) };
    }
    for (const c of fuzzy) {
      const t = c.slice(0, 40);
      if (c.length > 40 || /[.:;!?]$/.test(t.trim())) continue;
      if (/\bexecut(e|ion)?\b/i.test(t) || /(^|[^a-z])exec([^a-z]|$)/i.test(t)) {
        let runner = 'shell';
        if (/mcp/i.test(t)) runner = 'mcp';
        else if (/python/i.test(t)) runner = 'python';
        else if (/node|\bjs\b/i.test(t)) runner = 'node';
        else if (/pwsh|powershell/i.test(t)) runner = 'powershell';
        return { lang: 'execute', runner };
      }
    }
    if (code) {
      const first = ((code.innerText != null ? code.innerText : code.textContent) || '').split('\n')[0].trim().toLowerCase();
      const m = first.match(/^(?:#!\/usr\/bin\/env\s+|#!|\/\/|#)\s*(execut(?:e|ion)?|exec)(?:[-:](python|js|node|pwsh|powershell|mcp))?$/i);
      if (m) {
        let runner = 'shell';
        const suf = (m[2] || '').toLowerCase();
        if (/mcp/.test(suf)) runner = 'mcp';
        else if (/python/.test(suf)) runner = 'python';
        else if (/node|js/.test(suf)) runner = 'node';
        else if (/pwsh|powershell/.test(suf)) runner = 'powershell';
        return { lang: 'execute', runner };
      }
    }
    return null;
  }

  // Нестрогий поиск: язык блока не распознан, но рядом есть слово execute.
  // settings должен содержать defaultRunner.
  function detectFallback(pre, settings) {
    settings = settings || {};
    let node = pre;
    for (let depth = 0; depth < 3 && node && node !== document.body; depth++) {
      let sib = node.previousElementSibling;
      let hops = 0;
      while (sib && hops < 3) {
        if (sib.classList && sib.classList.contains('ax-exec-panel')) { sib = sib.previousElementSibling; continue; }
        const hasPre = sib.tagName === 'PRE' || (sib.querySelector && sib.querySelector('pre'));
        if (!hasPre) {
          const t = ((sib.innerText != null ? sib.innerText : sib.textContent) || '').trim();
          if (t) {
            const cleaned = t.replace(/copy|копировать|скопировано/gi, '').trim();
            const bare = cleaned.replace(/^[^a-zа-яё`]+|[^a-zа-яё`]+$/gi, '');
            const m = (bare || cleaned).match(/^\s*`{0,3}\s*(execut(e|ion)?|exec)([-:](python|js|node|pwsh|powershell))?\s*`{0,3}\s*$/i);
            if (m) {
              let runner = 'shell';
              const suf = (m[3] || '').toLowerCase();
              if (/python/i.test(suf)) runner = 'python';
              else if (/node|js/i.test(suf)) runner = 'node';
              else if (/pwsh|powershell/i.test(suf)) runner = 'powershell';
              return { runner, strong: true };
            }
            if (t.length <= 120 && /\b(execut(e|ion)?|exec)\b/i.test(t)) {
              return { runner: runnerValid(settings.defaultRunner) || 'shell', strong: false };
            }
          }
        }
        sib = sib.previousElementSibling;
        hops++;
      }
      node = node.parentElement;
    }
    return null;
  }

  return {
    EXEC_LANGS, RUNNER_OPTIONS,
    normalizeWhitespace, isDangerous, isHardDangerous, dangerLevel, stripStringLiterals, runnerValid, normLang,
    mcpToolDanger, mcpBlockDanger,
    unquotedSegments, hasDangerousSignature, describeFailure, redactSecrets, SECRET_MASK,
    sniffRunner, getCodeText, detectRunner, detectFallback,
  };
});
