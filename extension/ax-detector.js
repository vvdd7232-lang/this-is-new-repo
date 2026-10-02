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
    /rm\s+-rf?\s+[\/~]/i, /\brm\s+-rf?\s+\*/i, /:\(\)\s*\{\s*:\|:\s*&\s*\}/,
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

  function dangerLevel(cmd) {
    const c = stripStringLiterals(cmd || '');
    if (DANGER_HARD.some((re) => re.test(c))) return 'hard';
    if (DANGER_SOFT.some((re) => re.test(c))) return 'soft';
    return null;
  }
  // HARD блокирует автозапуск и форсит подтверждение даже при выключенном
  // requireConfirm. SOFT — только подсветка, автопилот проходит.
  function isHardDangerous(cmd) { return dangerLevel(cmd) === 'hard'; }
  // Совместимое имя: «есть ли вообще что-то подозрительное» (hard или soft).
  function isDangerous(cmd) { return dangerLevel(cmd) !== null; }

  const RUNNER_OPTIONS = [
    ['shell', 'shell'],
    ['powershell', 'powershell'],
    ['python', 'python'],
    ['node', 'node'],
  ];
  function runnerValid(r) { return RUNNER_OPTIONS.some(([v]) => v === r) ? r : null; }

  function normLang(s) {
    return (s || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
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
        if (/python/i.test(t)) runner = 'python';
        else if (/node|\bjs\b/i.test(t)) runner = 'node';
        else if (/pwsh|powershell/i.test(t)) runner = 'powershell';
        return { lang: 'execute', runner };
      }
    }
    if (code) {
      const first = ((code.innerText != null ? code.innerText : code.textContent) || '').split('\n')[0].trim().toLowerCase();
      const m = first.match(/^(?:#!\/usr\/bin\/env\s+|#!|\/\/|#)\s*(execut(?:e|ion)?|exec)(?:[-:](python|js|node|pwsh|powershell))?$/i);
      if (m) {
        let runner = 'shell';
        const suf = (m[2] || '').toLowerCase();
        if (/python/.test(suf)) runner = 'python';
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
    sniffRunner, getCodeText, detectRunner, detectFallback,
  };
});
