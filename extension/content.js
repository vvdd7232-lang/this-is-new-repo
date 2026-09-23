/* AI Execute Runner — content script
 * Ищет на странице код-блоки с языком execute/exec/... и добавляет кнопку
 * "▶ Выполнить". Выполнение идёт через локальный сервер 127.0.0.1:8765.
 * Работает на ChatGPT, Claude, Arena, Google AI Mode, Gemini, Grok, DeepSeek, Qwen и др. (см. manifest).
 * На Арене поддерживаются все режимы: Battle, Side-by-Side и Direct —
 * сканируются все <pre> на странице, включая оба столбца в баттле.
 */
(() => {
  'use strict';

  /* ----- Защита от "Extension context invalidated" -----
   * После перезагрузки расширения старый content-script продолжает висеть
   * на открытых вкладках (таймеры, observer), но chrome.* уже мёртв.
   * Вместо спама ошибок — один тост "обнови вкладку" и остановка таймеров. */
  let serverTimer = null;
  let scanTimer = null;
  let deadNotified = false;
  function ctxAlive() {
    try { return !!(window.chrome && chrome.runtime && chrome.runtime.id); }
    catch { return false; }
  }
  function safeSend(msg, cb) {
    if (!ctxAlive()) {
      if (cb) { try { cb(null); } catch {} }
      handleDeadContext();
      return;
    }
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        try {
          if (chrome.runtime.lastError) { if (cb) cb(null); return; }
        } catch {}
        if (cb) { try { cb(resp); } catch (e) { console.warn('[AX]', e); } }
      });
    } catch (e) {
      if (cb) { try { cb(null); } catch {} }
      handleDeadContext();
    }
  }
  function handleDeadContext() {
    try { observer.disconnect(); } catch {}
    try { if (serverTimer) { clearInterval(serverTimer); serverTimer = null; } } catch {}
    try { if (scanTimer) { clearInterval(scanTimer); scanTimer = null; } } catch {}
    if (deadNotified) return;
    deadNotified = true;
    try {
      const dot = document.getElementById('ax-server-dot');
      if (dot) {
        dot.className = 'ax-offline';
        dot.textContent = '⚡ exec: обнови страницу (F5)';
        dot.title = 'Расширение было обновлено/перезагружено — нажми F5';
        dot.onclick = () => location.reload();
        dot.ondblclick = null;
      }
    } catch {}
    try { toast('⚡ Расширение обновлено — обнови вкладку (F5)'); } catch {}
  }

  // Языки блоков, которые считаем исполняемыми.
  // Нейросеть должна писать: ```execute ... ``` (см. SYSTEM_PROMPT.md)
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

  // Опасные паттерны — показываем красное предупреждение в модалке.
  const DANGER_PATTERNS = [
    /rm\s+-rf?\s+[\/~]/i, /\brm\s+-rf?\s+\*/i, /:\(\)\s*\{\s*:\|:\s*&\s*\}/,
    /\bmkfs\b/i, /\bdd\s+if=/i, /\bshutdown\b/i, /\breboot\b/i,
    /\bformat\s+[a-z]:/i, /del\s+\/[fs]/i, /rd\s+\/s/i,
    /\bsudo\b/i, /chmod\s+-R\s+777/i, /curl.*\|\s*(bash|sh)/i, /wget.*\|\s*(bash|sh)/i,
  ];

  let settings = { serverUrl: 'http://127.0.0.1:8765', timeout: 30, requireConfirm: true, maxOutputChars: 32000, autoExecute: false, autoInsert: false, autoSend: false, autoDelay: 3, looseSearch: true, autoWeak: false, maxAutoRuns: 0, defaultRunner: 'shell', showToasts: true, defaultCwd: '' };

  // --- состояние автопилота (на одну загрузку вкладки) ---
  // Лимит автозапусков задаётся настройкой maxAutoRuns (0 = без лимита)
  let autoRunCount = 0;
  let lastAutoCommands = [];
  let loopBlocked = false;
  const AX_SESSION = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); // id этой загрузки вкладки
  const AX_BOOT = Date.now();
  const BOOT_GRACE_MS = 15000; // первые секунды после загрузки: блоки с неизменным текстом считаем старыми
  // Дедуп автозапусков: команда+среда -> время последнего автозапуска.
  // Чаты перерисовывают DOM при стриминге — для одного блока могут создаться
  // панели-дубли, и без дедупа одна команда выполнялась бы 2-3 раза.
  const recentAutoRuns = new Map();
  const DEDUP_WINDOW_MS = 60000;
  function autoRunKey(cmd, runner) { return runner + '\n' + (cmd || '').trim().slice(0, 4000); }
  function dupAge(cmd, runner) {
    const now = Date.now();
    for (const [k, t] of recentAutoRuns) if (now - t > DEDUP_WINDOW_MS) recentAutoRuns.delete(k);
    const t = recentAutoRuns.get(autoRunKey(cmd, runner));
    return t ? Math.max(1, Math.round((now - t) / 1000)) : 0;
  }
  function markAutoRun(cmd, runner) {
    recentAutoRuns.delete(autoRunKey(cmd, runner));
    recentAutoRuns.set(autoRunKey(cmd, runner), Date.now());
    while (recentAutoRuns.size > 200) recentAutoRuns.delete(recentAutoRuns.keys().next().value);
  }
  // История выполненных команд (переживает перезагрузки): ключ autoRunKey -> {t, s}.
  // Автопилот не трогает команды из прошлых сессий — защита от прогона всей истории при F5.
  const execHistory = new Map();
  const EXEC_HIST_KEY = 'axExecutedHistory';
  function loadExecHistory(o) {
    execHistory.clear();
    if (o) for (const [k, v] of Object.entries(o)) {
      if (v && typeof v.t === 'number') execHistory.set(k, { t: v.t, s: typeof v.s === 'string' ? v.s : '' });
    }
  }
  function saveExecHistory() {
    try { chrome.storage.local.set({ [EXEC_HIST_KEY]: Object.fromEntries(execHistory) }); } catch {}
  }
  function markExecuted(cmd, runner) {
    execHistory.delete(autoRunKey(cmd, runner));
    execHistory.set(autoRunKey(cmd, runner), { t: Date.now(), s: AX_SESSION });
    while (execHistory.size > 200) execHistory.delete(execHistory.keys().next().value);
    saveExecHistory();
  }
  function historyAge(cmd, runner) {
    const e = execHistory.get(autoRunKey(cmd, runner));
    if (!e || e.s === AX_SESSION) return 0;
    return Math.max(1, Math.round((Date.now() - e.t) / 1000));
  }
  function fmtAge(sec) {
    if (sec < 120) return sec + 'с';
    if (sec < 7200) return Math.round(sec / 60) + 'м';
    if (sec < 172800) return Math.round(sec / 3600) + 'ч';
    return Math.round(sec / 86400) + 'д';
  }
  try { chrome.storage.local.get([EXEC_HIST_KEY], (d) => loadExecHistory(d && d[EXEC_HIST_KEY])); } catch {}
  const livePanels = [];         // { started, done, start(), finish() }
  let foundToastShown = false;
  function applyAutoToPending() {
    if (!settings.autoExecute) return;
    for (let i = livePanels.length - 1; i >= 0; i--) {
      const h = livePanels[i];
      if (h.el && !h.el.isConnected) { livePanels.splice(i, 1); continue; } // панель удалена со страницы
      try { h.retry(); } catch {}
    }
  }

  // --- очередь автозапусков: строго по одному, в порядке появления на странице ---
  const autoQueue = [];
  let autoActive = false;
  let currentAuto = null;
  let axSeq = 0; // сквозной номер запусков на вкладку (в результатах: seq=N)
  function enqueueAuto(handle) {
    // НЕ проверяем isConnected здесь: start() вызывается до вставки панели в DOM.
    // Мёртвые панели отсекаются в pumpAutoQueue.
    if (!autoQueue.includes(handle)) autoQueue.push(handle);
    updateQueueStatuses();
    pumpAutoQueue();
  }
  function dequeueAuto(handle) {
    const ix = autoQueue.indexOf(handle);
    if (ix >= 0) autoQueue.splice(ix, 1);
    if (autoActive && currentAuto === handle) { autoActive = false; currentAuto = null; }
    updateQueueStatuses();
    pumpAutoQueue();
  }
  function updateQueueStatuses() {
    autoQueue.forEach((h, i) => { try { h.showQueued(i); } catch {} });
  }
  function pumpAutoQueue() {
    if (autoActive) return;
    let h = null;
    // Пропускаем мёртвые (панель исчезла из DOM) и зависшие (уже claimed,
    // но очередь их потеряла — иначе был бы двойной запуск).
    while (autoQueue.length) {
      const cand = autoQueue[0];
      const dead = cand.el && !cand.el.isConnected;
      if (dead || cand.claimed) { autoQueue.shift(); updateQueueStatuses(); continue; }
      h = cand;
      break;
    }
    if (!h) return;
    autoActive = true;
    currentAuto = h;
    h.claimed = true;
    try {
      h.runNow(() => {
        const ix = autoQueue.indexOf(h);
        if (ix >= 0) autoQueue.splice(ix, 1);
        if (currentAuto === h) { autoActive = false; currentAuto = null; }
        updateQueueStatuses();
        pumpAutoQueue();
      });
    } catch {
      const ix = autoQueue.indexOf(h);
      if (ix >= 0) autoQueue.splice(ix, 1);
      autoActive = false;
      currentAuto = null;
      updateQueueStatuses();
      pumpAutoQueue();
    }
  }

  safeSend({ type: 'AX_GET_SETTINGS' }, (resp) => {
    if (resp && resp.ok) settings = { ...settings, ...resp.settings };
    applyAutoToPending();
  });
  try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes[EXEC_HIST_KEY]) loadExecHistory(changes[EXEC_HIST_KEY].newValue);
      return;
    }
    if (area !== 'sync') return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    if ((changes.autoExecute && changes.autoExecute.newValue === true) ||
        (changes.autoWeak && changes.autoWeak.newValue === true) ||
        (changes.maxAutoRuns && (changes.maxAutoRuns.newValue || 0) !== (changes.maxAutoRuns.oldValue || 0))) applyAutoToPending();
  });
  } catch {}

  // ---------- Утилиты ----------

  function toast(text, ms = 2200) {
    if (settings && settings.showToasts === false) return;
    let el = document.querySelector('.ax-toast');
    if (!el) { el = document.createElement('div'); el.className = 'ax-toast'; document.body.appendChild(el); }
    el.textContent = text;
    el.classList.add('ax-show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('ax-show'), ms);
  }

  function normLang(s) {
    return (s || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  }

  // Пытаемся определить язык блока <pre> разными способами под разные сайты.
  function detectRunner(pre) {
    const code = pre.querySelector('code');
    const exact = []; // кандидаты для точного совпадения (классы, data-атрибуты)
    const fuzzy = []; // короткие подписи рядом (шапка код-блока)
    const pushE = (v) => { if (v && typeof v === 'string') exact.push(v); };
    const pushF = (v) => { if (v && typeof v === 'string' && v.trim() && v.trim().length <= 80) fuzzy.push(v.trim()); };

    // 1) классы language-*/lang-* на code И на pre (разные рендеры кладут по-разному)
    for (const el of [code, pre]) {
      if (!el || !el.classList) continue;
      for (const c of el.classList) {
        const m = String(c).match(/(?:language|lang)-(.+)/i);
        if (m) pushE(m[1]);
        else if (/exec/i.test(c)) pushE(c); // голый токен "execute-python" без префикса тоже пробуем
      }
    }
    // 2) data-атрибуты на code/pre/родителях
    const chain = [code, pre, pre.parentElement, pre.parentElement && pre.parentElement.parentElement];
    for (const el of chain) {
      if (!el || !el.dataset) continue;
      pushE(el.dataset.language);
      pushE(el.dataset.lang);
      // остальные data-* тоже (data-code-language, data-lang-name и т.п.)
      try {
        for (const v of Object.values(el.dataset)) {
          if (typeof v === 'string' && v.length <= 60) pushE(v);
        }
      } catch {}
    }
    // 2b) те же атрибуты напрямую + title/aria-label (язык иногда кладут туда)
    for (const el of [code, pre]) {
      if (!el || !el.getAttribute) continue;
      pushE(el.getAttribute('data-language'));
      pushE(el.getAttribute('data-lang'));
      pushE(el.getAttribute('title'));
      pushE(el.getAttribute('aria-label'));
    }
    // 3) подпись языка рядом: шапка код-блока с кнопкой копирования
    const container = pre.closest('div');
    if (container) {
      const labels = container.querySelectorAll(
        '[data-testid*="language"], .language-label, [class*="language"], [class*="lang-"], ' +
        'span.font-mono, div.text-xs, [class*="code-header"], [class*="codeheader"], ' +
        '[class*="CodeBlock"] [class*="header"], [class*="toolbar"]'
      );
      labels.forEach((label) => { if (label.textContent) pushF(label.textContent); });
    }
    // 4) соседи pre (шапка часто лежит прямо перед блоком)
    for (const sib of [pre.previousElementSibling, pre.nextElementSibling]) {
      if (!sib || !sib.textContent) continue;
      if (sib.classList && sib.classList.contains('ax-exec-panel')) continue;
      pushF(sib.textContent);
    }
    // 4b) шапка ВНУТРИ pre (первый элемент — не <code>, а рядом есть <code>):
    // текст шапки — кандидат языка. Без <code> не смотрим (иначе первая строка
    // построчного кода дала бы ложные срабатывания).
    try {
      const first = pre.firstElementChild;
      if (code && first && first.tagName !== 'CODE' && first.textContent) pushF(first.textContent);
    } catch {}

    // 5) точное совпадение
    for (const c of exact.concat(fuzzy)) {
      const n = normLang(c);
      if (EXEC_LANGS.has(n)) return { lang: n, runner: EXEC_LANGS.get(n) };
    }
    // 6) нечёткое: короткая подпись СОДЕРЖИТ execute/exec ("Execute • Copy").
    // Требуем: длина <= 40 и непохоже на обычное предложение (без . : ! ? в конце),
    // чтобы фраза "Now execute this:" перед блоком не давала ложных кнопок.
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
    // 5) fallback: первая строка кода вида "#!execute" или "// execute"
    if (code) {
      const first = (code.innerText || '').split('\n')[0].trim().toLowerCase();
      if (first === '#!execute' || first === '// execute' || first === '# execute')
        return { lang: 'execute', runner: 'shell' };
    }
    return null;
  }

  // Нестрогий поиск: язык блока не распознан, но рядом есть слово execute.
  // Возвращает { runner, strong } или null.
  // strong = соседний элемент — это практически одно слово "execute" (ИИ написал
  // метку обычным текстом, а код — отдельным блоком). Такие блоки = полноценные.
  function detectFallback(pre) {
    let node = pre;
    for (let depth = 0; depth < 3 && node && node !== document.body; depth++) {
      let sib = node.previousElementSibling;
      let hops = 0;
      while (sib && hops < 3) {
        // пропускаем свои же панели (иначе слово EXECUTE в их тексте даёт ложные находки)
        if (sib.classList && sib.classList.contains('ax-exec-panel')) { sib = sib.previousElementSibling; continue; }
        const hasPre = sib.tagName === 'PRE' || (sib.querySelector && sib.querySelector('pre'));
        if (!hasPre) {
          const t = ((sib.innerText != null ? sib.innerText : sib.textContent) || '').trim();
          if (t) {
            const cleaned = t.replace(/copy|копировать|скопировано/gi, '').trim();
            // убираем декорации по краям ("💻 execute", "▶ execute •", "execute:") — это всё равно метка
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

  // Сниффер содержимого для ПРОСТЫХ execute-блоков (без суффикса языка):
  // если код очевидно на python/powershell/node — выполняем в правильной среде,
  // а не в shell (ИИ часто забывает суффикс, а сайты его отрезают).
  // Смотрим ТОЛЬКО первую значимую строку: дальше уже рискованно
  // (например shell-heredoc, создающий .py-файл, тоже содержит "import").
  function sniffRunner(command) {
    const lines = (command || '').split('\n');
    let line = '';
    for (const s of lines) {
      const t = s.trim();
      if (!t || /^(#|\/\/|rem\s|<\#)/i.test(t)) continue;
      line = t; break;
    }
    if (!line) return null;
    if (/^(import\s+[\w.]+(\s*,\s*[\w.]+)*\s*(;|$|#)|from\s+[\w.]+\s+import[\s(]|def\s+\w+\s*\(|print\s*\(|print\s+["'])/.test(line)) return 'python';
    if (/^(console\.(log|error|warn)\s*\(|require\s*\(|const\s+\w+\s*=\s*require\s*\(|import\s+.+\s+from\s+["']|export\s+(default|const\b|let\b|var\b|function\b|class\b|async\b|\{))/.test(line)) return 'node';
    if (/^((Get|Set|New|Remove|Start|Stop|Test|Write|Read|Import|Export|Invoke|Out|Select|Where|ForEach|Sort|Measure|Compare|Resolve|Split|Join|Clear|Copy|Move|Rename|Restart|Suspend|Update|Wait)-[A-Z]\w*)/.test(line)) return 'powershell';
    return null;
  }

  function getCodeText(pre) {
    const code = pre.querySelector('code');
    const raw = (code ? code.innerText : pre.innerText) || '';
    // убираем маркер первой строки, если он использовался как fallback
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    if (lines.length && ['#!execute', '// execute', '# execute'].includes(lines[0].trim().toLowerCase()))
      lines.shift();
    return lines.join('\n').replace(/\n+$/, '');
  }

  function isDangerous(cmd) {
    return DANGER_PATTERNS.some((re) => re.test(cmd));
  }

  // ---------- Модалка подтверждения ----------

  const RUNNER_OPTIONS = [
    ['shell', 'shell'],
    ['powershell', 'powershell'],
    ['python', 'python'],
    ['node', 'node'],
  ];
  function fillRunnerSelect(sel, current) {
    sel.innerHTML = '';
    for (const [val, label] of RUNNER_OPTIONS) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      if (val === current) o.selected = true;
      sel.appendChild(o);
    }
  }

  // Память выбора среды: начало текста команды -> runner.
  // Переживает перерисовки чата при стриминге и перезагрузку вкладки (chrome.storage.local, до 100 команд).
  const runnerMemory = new Map();
  const RUNNER_MEM_KEY = 'axRunnerMemory';
  function runnerValid(r) { return RUNNER_OPTIONS.some(([v]) => v === r) ? r : null; }
  function memKey(code) { return (code || '').trim().replace(/\s+/g, ' ').slice(0, 200); }
  function memGet(code) { return runnerValid(runnerMemory.get(memKey(code))); }
  function memSet(code, runner) {
    runner = runnerValid(runner);
    if (!runner || !memKey(code)) return;
    runnerMemory.delete(memKey(code));
    runnerMemory.set(memKey(code), runner);
    while (runnerMemory.size > 100) runnerMemory.delete(runnerMemory.keys().next().value);
    try { chrome.storage.local.set({ [RUNNER_MEM_KEY]: Object.fromEntries(runnerMemory) }); } catch {}
  }
  try {
    chrome.storage.local.get([RUNNER_MEM_KEY], (d) => {
      const o = d && d[RUNNER_MEM_KEY];
      if (o) for (const [k, v] of Object.entries(o)) { const r = runnerValid(v); if (r) runnerMemory.set(k, r); }
    });
  } catch {}

  function confirmModal({ lang, runner, command }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'ax-modal-backdrop';
      const dangerous = isDangerous(command);
      backdrop.innerHTML =
        '<div class="ax-modal">' +
          '<h3>⚡ Выполнить команду локально?</h3>' +
          '<div style="font-size:13px;opacity:.8">Блок <b>' + escapeHtml(lang) + '</b> на вашем ПК (сервер ' + escapeHtml(settings.serverUrl) + ').</div>' +
          '<div class="ax-runner-row">Среда выполнения: <select class="ax-runner-select ax-modal-select"></select></div>' +
          '<pre></pre>' +
          (dangerous
            ? '<div class="ax-warn ax-danger">⛔ Команда похожа на <b>опасную</b> (удаление / форматирование / sudo / pipe в shell). Выполняйте только если на 100% понимаете, что она делает.</div>'
            : '<div class="ax-warn">⚠️ Команда выполнится <b>на вашем компьютере</b> с вашими правами. Проверьте её перед запуском.</div>') +
          '<div class="ax-modal-row">' +
            '<button class="ax-btn ax-btn-cancel">Отмена</button>' +
            '<button class="ax-btn ax-btn-confirm' + (dangerous ? '' : ' safe') + '">▶ Выполнить</button>' +
          '</div>' +
        '</div>';
      backdrop.querySelector('pre').textContent = command;
      const sel = backdrop.querySelector('.ax-modal-select');
      fillRunnerSelect(sel, runner);
      const onKey = (e) => {
        if (e.key === 'Escape') { cleanup(); resolve({ ok: false }); }
      };
      const cleanup = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop || e.target.closest('.ax-btn-cancel')) { cleanup(); resolve({ ok: false }); }
        if (e.target.closest('.ax-btn-confirm')) { cleanup(); resolve({ ok: true, runner: sel.value }); }
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(backdrop);
      try { backdrop.querySelector('.ax-btn-confirm').focus({ preventScroll: true }); } catch {}
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Вставка результата в поле ввода чата ----------

  function formatResult({ command, runner, exit_code, stdout, stderr, truncated, cwd, stdoutBytes, stderrBytes, limitBytes, executed, seq, durationMs, timedOut }) {
    const max = +settings.maxOutputChars || 0; // 0 = без лимита
    const so = stdout || '', se = stderr || '';
    let out = max > 0 ? so.slice(0, max) : so;
    let err = max > 0 ? se.slice(0, Math.floor(max / 2)) : se;
    const clipIns = max > 0 && so.length > max;
    let txt = '[LOCAL EXEC RESULT] seq=' + (seq || 0) + ' status=done' +
      ' runner=' + runner + ' exit=' + (exit_code == null ? '?' : exit_code) +
      ' executed=' + (executed === false ? 'no' : 'yes') +
      ' cwd="' + (cwd || '?') + '"' +
      ' stdout_bytes=' + (stdoutBytes != null ? stdoutBytes : so.length) +
      ' stderr_bytes=' + (stderrBytes != null ? stderrBytes : se.length) +
      (durationMs != null ? ' dur=' + (durationMs < 1000 ? durationMs + 'ms' : (durationMs / 1000).toFixed(1) + 's') : '') +
      (clipIns ? ' insert_truncated=yes shown_chars=' + out.length + '/' + so.length : '') +
      '\n$ ' + command + '\n';
    if (out) txt += '--- stdout ---\n' + out + (max > 0 && so.length > max ? '\n…(обрезано вставкой: лимит ' + max + ' симв.)' : '') + '\n';
    if (err) txt += '--- stderr ---\n' + err + '\n';
    if (!out && !err) txt += '(пустой вывод)\n';
    if (truncated) txt += timedOut
      ? '(команда убита по таймауту — вывод частичный, см. [TIMEOUT] в stderr)\n'
      : '(stdout/stderr обрезаны сервером: лимит ' + (limitBytes || '?') + ' байт)\n';
    return txt;
  }

  function formatRunResult(cmd, runRunner, r, seq) {
    r = r || {};
    return formatResult({ command: cmd, runner: r.runner || runRunner, exit_code: r.exit_code, stdout: r.stdout || '', stderr: r.stderr || '', truncated: r.truncated, cwd: r.cwd, stdoutBytes: r.stdout_bytes, stderrBytes: r.stderr_bytes, limitBytes: r.limit_bytes, executed: r.executed, seq: seq, durationMs: r.duration_ms, timedOut: r.timed_out });
  }

  // Видимость через геометрию (offsetParent врёт для position:fixed)
  function isVisibleEl(el) {
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch { return false; }
  }

  function findChatInput() {
    const selectors = [
      'textarea#prompt-textarea',           // ChatGPT
      'div#prompt-textarea[contenteditable]', // ChatGPT (новый)
      'div[contenteditable="true"]',        // Claude / общий
      'textarea[placeholder]',              // Arena / общий (поле ввода с плейсхолдером)
      'textarea',
    ];
    const seen = new Set();
    const candidates = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (isVisibleEl(el) && !el.disabled && !el.readOnly) candidates.push(el);
      }
    }
    if (!candidates.length) return null;
    // Поле ввода чата обычно самое нижнее на странице (Arena, ChatGPT, Claude) —
    // берём видимый кандидат с максимальным bottom.
    candidates.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);
    return candidates[candidates.length - 1];
  }

  function setTextareaReactSafe(input, text) {
    // React-приложения (Arena и др.) не замечают input.value = ...,
    // поэтому пишем через нативный сеттер + событие input.
    try {
      const proto = window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      setter.call(input, input.value.slice(0, start) + text + input.value.slice(end));
      try { input.selectionStart = input.selectionEnd = start + text.length; } catch {}
    } catch {
      input.value += text;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // toastText: undefined = стандартный тост, строка = свой текст, null = тихо
  function insertIntoChat(text, toastText) {
    const input = findChatInput();
    if (!input) { if (toastText !== null) toast('Поле ввода чата не найдено — результат скопирован'); return null; }
    try {
      input.focus();
      if (input.tagName === 'TEXTAREA') {
        setTextareaReactSafe(input, text);
      } else {
        // contenteditable (Claude/ChatGPT): вставляем как текст
        let ok = false;
        try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
        if (!ok) throw new Error('execCommand failed');
      }
    } catch {
      silentCopy(text);
      if (toastText !== null) toast('Не удалось вставить в поле чата — текст скопирован');
      return null;
    }
    if (toastText === undefined) toast('Результат вставлен в чат — нажмите Enter чтобы отправить ИИ');
    else if (toastText) toast(toastText);
    return input;
  }

  // Копирование без тостов и необработанных ошибок (резервный путь)
  function silentCopy(text) {
    try {
      const pr = navigator.clipboard.writeText(text);
      if (pr && pr.catch) pr.catch(() => {});
    } catch {}
  }

  // Короткая служебная записка в чат (видна и пользователю, и ИИ-агенту)
  function noteToChat(text) {
    if (!settings.autoInsert) return;
    insertIntoChat(text, null);
  }

  // ---------- Утилиты автопилота ----------

  // Ждём конца стриминга: текст блока не меняется 2.5с (макс. ожидание 120с).
  // Возвращает функцию отмены.
  function waitForSettle(pre, cb) {
    let last = '';
    try { last = getCodeText(pre); } catch {}
    const t0 = Date.now();
    let lastChange = t0, goneSince = 0;
    const iv = setInterval(() => {
      const now = Date.now();
      // Блок выкинули из DOM (чат перерисовал): новый panel разберётся сам, этот пропускаем
      if (pre && !pre.isConnected) {
        if (!goneSince) goneSince = now;
        if (now - goneSince >= 1500) { clearInterval(iv); cb(''); return; }
      } else goneSince = 0;
      let cur = '';
      try { cur = getCodeText(pre); } catch {}
      if (cur !== last) { last = cur; lastChange = now; }
      if (now - lastChange >= 2500 || now - t0 >= 120000) { clearInterval(iv); cb(last); }
    }, 500);
    return () => clearInterval(iv);
  }

  function findSendButton(input) {
    const scopes = [];
    try { if (input && input.closest) { const f = input.closest('form'); if (f) scopes.push(f); } } catch {}
    scopes.push(document);
    const sels = ['button[data-testid*="send" i]', 'button[aria-label*="send" i]', 'button[type="submit"]'];
    for (const scope of scopes) {
      for (const sel of sels) {
        try {
          const b = scope.querySelector(sel);
          if (b && isVisibleEl(b) && !b.disabled) return b;
        } catch {}
      }
    }
    return null;
  }

  function autoSendToChat(input, onSent) {
    const done = () => { try { onSent && onSent(); } catch {} };
    setTimeout(() => {
      if (!input || !input.isConnected) { toast('Поле ввода исчезло — отправь сам'); done(); return; }
      const btn = findSendButton(input);
      if (btn) { btn.click(); toast('🤖 Результат отправлен ИИ'); done(); return; }
      try {
        input.focus();
        const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        input.dispatchEvent(ev);
        toast('⚠️ Кнопка не найдена: Enter отправлен, но чат мог его проигнорировать');
      } catch { toast('Не нашёл кнопку отправки — нажми Enter сам'); }
      done();
    }, 700);
  }

  // ---------- Запуск произвольного текста (контекстное меню) ----------

  function showResultModal(formatted, okExit) {
    const backdrop = document.createElement('div');
    backdrop.className = 'ax-modal-backdrop';
    backdrop.innerHTML =
      '<div class="ax-modal">' +
        '<h3>' + (okExit ? '✅ Команда выполнена (exit=0)' : '⚠️ Команда завершилась с ошибкой') + '</h3>' +
        '<pre></pre>' +
        '<div class="ax-modal-row">' +
          '<button class="ax-btn ax-btn-copy">📋 Копировать</button>' +
          '<button class="ax-btn ax-btn-insert">📥 Вставить в чат</button>' +
          '<button class="ax-btn ax-btn-cancel">Закрыть</button>' +
        '</div>' +
      '</div>';
    backdrop.querySelector('pre').textContent = formatted;
    const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
    const cleanup = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    backdrop.querySelector('.ax-btn-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(formatted); toast('Вывод скопирован'); } catch { toast('Не удалось скопировать'); }
    };
    backdrop.querySelector('.ax-btn-insert').onclick = () => {
      try { insertIntoChat('\n```text\n' + formatted + '\n```\n'); } catch {}
      silentCopy(formatted);
      cleanup();
    };
    backdrop.querySelector('.ax-btn-cancel').onclick = cleanup;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    try { backdrop.querySelector('.ax-btn-insert').focus({ preventScroll: true }); } catch {}
  }

  let arbitraryRunning = false;
  async function runArbitrary(text, defaultRunner) {
    const command = (text || '').trim();
    if (!command) { toast('Ничего не выделено'); return; }
    let runRunner = defaultRunner || 'shell';
    if (settings.requireConfirm) {
      const res = await confirmModal({ lang: 'selection', runner: runRunner, command });
      if (!res || !res.ok) return;
      runRunner = res.runner || runRunner;
    }
    if (arbitraryRunning) { toast('Уже выполняется — дождись результата'); return; }
    arbitraryRunning = true;
    toast('⏳ Выполняется локально…');
    const mySeq = ++axSeq;
    safeSend(
      { type: 'AX_RUN', payload: { command, runner: runRunner, timeout: settings.timeout, cwd: settings.defaultCwd || undefined } },
      (resp) => {
        arbitraryRunning = false;
        if (!resp || !resp.ok) {
          toast('❌ ' + ((resp && resp.error) || 'нет ответа') + ' — запущен ли server.py?');
          return;
        }
        const r = resp.result || {};
        markExecuted(command, r.runner || runRunner);
        const formatted = formatRunResult(command, runRunner, r, mySeq);
        showResultModal(formatted, r.exit_code === 0);
      }
    );
  }

  try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'AX_RUN_SELECTION') runArbitrary(msg.text, settings.defaultRunner || 'shell');
  });
  } catch {}

  // Общие тексты статусов автопилота (чтобы не дублировать строки)
  const MSG_WEAK_AUTO_OFF = '🔍 EXECUTE?: автозапуск для таких блоков выключен — жми ▶ вручную (или включи «Автозапуск блоков EXECUTE?» в настройках).';
  const MSG_LOOP_OFF = '🛑 Автопилот остановлен (зацикливание) — дальше вручную.';

  // ---------- Панель под блоком ----------

  function buildPanel(pre, info, command, flags) {
    flags = flags || {};
    const createdCmd = (command || '').trim();
    const panel = document.createElement('div');
    panel.className = 'ax-exec-panel';
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) panel.classList.add('ax-dark');

    panel.innerHTML =
      '<div class="ax-exec-header"><span class="ax-exec-badge">⚡ EXECUTE</span>' +
      '<span class="ax-exec-runner">блок <b></b></span></div>' +
      '<div class="ax-exec-cmd-preview"></div>' +
      '<div class="ax-exec-btns">' +
        '<button class="ax-btn ax-btn-run">▶ Выполнить</button>' +
        '<button class="ax-btn ax-btn-copy">📋 Команда</button>' +
      '</div>' +
      '<div class="ax-exec-status"></div>' +
      '<div class="ax-exec-output" style="display:none"></div>' +
      '<div class="ax-exec-btns ax-exec-after" style="display:none">' +
        '<button class="ax-btn ax-btn-insert">📥 В чат</button>' +
        '<button class="ax-btn ax-btn-copy ax-btn-copy-out">📋 Вывод</button>' +
      '</div>';

    if (flags.weak) {
      panel.querySelector('.ax-exec-badge').textContent = '⚡ EXECUTE?';
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;opacity:.75;font-weight:500';
      note.textContent = settings.autoWeak
        ? '🔍 находка нестрогая (EXECUTE?) — автозапуск разрешён'
        : '🔍 находка нестрогая (EXECUTE?) — только вручную';
      panel.querySelector('.ax-exec-header').appendChild(note);
    }
    panel.querySelector('.ax-exec-runner b').textContent = info.lang;
    // Выбор среды выполнения прямо на панели
    const runnerLabel = document.createElement('span');
    runnerLabel.className = 'ax-exec-runner';
    runnerLabel.textContent = 'среда: ';
    const runnerSelect = document.createElement('select');
    runnerSelect.className = 'ax-runner-select';
    runnerSelect.title = 'Среда выполнения (можно переключить)';
    fillRunnerSelect(runnerSelect, memGet(command) || info.runner);
    runnerSelect.onchange = () => memSet(command, runnerSelect.value);
    runnerLabel.appendChild(runnerSelect);
    panel.querySelector('.ax-exec-header').appendChild(runnerLabel);
    function panelRunner() {
      try { return (runnerSelect && runnerSelect.value) || info.runner; }
      catch { return info.runner; }
    }
    // Повторный сниффер на полном тексте (на момент создания панели блок мог стримиться).
    // Трогаем только нетронутый shell: без явного суффикса, без запомненного выбора,
    // селект пользователем не менялся (смена пишет в память через onchange).
    function maybeResniff(cmd) {
      try {
        if (runnerSelect.value === 'shell' && info.runner === 'shell' && !memGet(cmd)) {
          const sn = sniffRunner(cmd);
          if (sn) runnerSelect.value = sn;
        }
      } catch {}
      return panelRunner();
    }
    panel.querySelector('.ax-exec-cmd-preview').textContent = previewText(command);

    const btnRun = panel.querySelector('.ax-btn-run');
    const btnCopy = panel.querySelector('.ax-btn-copy');
    const status = panel.querySelector('.ax-exec-status');
    const outBox = panel.querySelector('.ax-exec-output');
    const after = panel.querySelector('.ax-exec-after');
    let lastFormatted = '';

    function previewText(cmd) {
      const t = cmd.split('\n').length > 3 ? cmd.split('\n').slice(0, 3).join('\n') + '\n…' : cmd;
      return t || '(пустая команда)';
    }

    btnCopy.onclick = async () => {
      try { await navigator.clipboard.writeText(getCodeText(pre) || command); toast('Команда скопирована'); }
      catch { toast('Не удалось скопировать'); }
    };

    function refreshPreview(cmd) {
      panel.querySelector('.ax-exec-cmd-preview').textContent = previewText(cmd);
    }

    async function doRun(cmdOverride, isAuto, onDone) {
      const fin = () => { running = false; try { onDone && onDone(); } catch {} };
      if (running) { toast('Уже выполняется — дождись результата'); fin(); return; }
      running = true;
      // команду перечитываем из блока в момент запуска (блок мог достримиться после создания панели)
      const cmd = ((cmdOverride != null ? cmdOverride : getCodeText(pre)) || '').trim();
      if (!cmd) { toast('Пустая команда'); fin(); return; }
      refreshPreview(cmd);
      let runRunner = maybeResniff(cmd);
      const mySeq = ++axSeq;
      if (!isAuto && settings.requireConfirm) {
        const res = await confirmModal({ lang: info.lang, runner: runRunner, command: cmd });
        if (!res || !res.ok) { fin(); return; }
        runRunner = res.runner || runRunner;
        try {
          runnerSelect.value = runRunner;
          memSet(cmd, runRunner);
        } catch {}
      }
      stopAutoTimer();
      btnRun.disabled = true;
      btnRun.textContent = '⏳ Выполняется…';
      status.className = 'ax-exec-status ax-running';
      status.textContent = isAuto ? '🤖 Автопилот: выполняется…' : 'Выполняется локально…';
      outBox.style.display = 'none';
      after.style.display = 'none';

      if (settings.autoInsert) {
        noteToChat('\n[LOCAL EXEC] seq=' + mySeq + ' status=running runner=' + runRunner + '\n$ ' + cmd + '\n');
      }
      safeSend(
        { type: 'AX_RUN', payload: { command: cmd, runner: runRunner, timeout: settings.timeout, cwd: settings.defaultCwd || undefined } },
        (resp) => {
          btnRun.disabled = false;
          btnRun.textContent = '▶ Выполнить';
          if (!resp) {
            noteToChat('\n[LOCAL EXEC RESULT] seq=' + mySeq + ' status=error\n$ ' + cmd + '\nнет ответа от расширения\n');
            status.className = 'ax-exec-status ax-err'; status.textContent = '❌ Нет ответа от расширения.'; fin(); return;
          }
          if (!resp.ok) {
            noteToChat('\n[LOCAL EXEC RESULT] seq=' + mySeq + ' status=error\n$ ' + cmd + '\n' + resp.error + '\n');
            const looksConn = /fetch|abort|network|ожидания|ECONN|Failed/i.test(resp.error || '');
            status.className = 'ax-exec-status ax-err';
            status.textContent = '❌ Ошибка: ' + resp.error + (looksConn ? ' — запущен ли server.py?' : '');
            toast('❌ ' + resp.error);
            fin();
            return;
          }
          autoHandle.finish();
          const r = resp.result || {};
          markExecuted(cmd, r.runner || runRunner);
          lastFormatted = formatRunResult(cmd, runRunner, r, mySeq);
          const okExit = r.exit_code === 0;
          status.className = 'ax-exec-status ' + (okExit ? 'ax-ok' : 'ax-err');
          status.textContent = (okExit ? '✅ exit=0' : '⚠️ exit=' + r.exit_code) + ' #' + mySeq + ' • stdout: ' + (r.stdout || '').length + ' симв. • stderr: ' + (r.stderr || '').length + ' симв.';
          outBox.textContent = lastFormatted;
          outBox.style.display = 'block';
          after.style.display = 'flex';
          // --- автопилот: автовставка + автоотправка ---
          // Отправку ждём до конца: следующий результат встанет в очередь только
          // после неё, иначе быстрые команды склеивались бы в одно сообщение.
          if (settings.autoInsert && lastFormatted) {
            try {
              const input = insertIntoChat('\n```text\n' + lastFormatted + '\n```\n');
              if (input && settings.autoSend) { autoSendToChat(input, fin); return; }
            } catch (e) { console.warn('[AX] insert:', e); }
          }
          fin();
        }
      );
    }

    btnRun.onclick = () => { stopAutoTimer(); dequeueAuto(autoHandle); doRun(null, false); };

    // ---------- Автозапуск этой панели ----------
    let autoTimer = null;
    let settleCancelFn = null;
    let autoCancelled = false;
    let running = false;
    let phase2 = false;
    let forceAutoOnce = false; // кнопка «Включить авто»: пропустить проверки истории/старости один раз

    function stopAutoTimer(msg) {
      autoCancelled = true;
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      if (settleCancelFn) { settleCancelFn(); settleCancelFn = null; }
      const cb = panel.querySelector('.ax-btn-cancel-auto');
      if (cb) cb.remove();
      if (msg) { status.className = 'ax-exec-status'; status.textContent = msg; }
    }

    function startAuto() {
      if (autoHandle.started || autoHandle.done || autoCancelled) return;
      autoHandle.started = true;
      if (flags.weak && !settings.autoWeak) {
        status.className = 'ax-exec-status';
        status.textContent = MSG_WEAK_AUTO_OFF;
        return;
      }
      if (!settings.autoExecute) return;
      if (loopBlocked) {
        status.className = 'ax-exec-status';
        status.textContent = MSG_LOOP_OFF;
        return;
      }
      ensureCancelBtn();
      enqueueAuto(autoHandle);
    }

    function ensureCancelBtn() {
      if (panel.querySelector('.ax-btn-cancel-auto')) return;
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ax-btn ax-btn-copy ax-btn-cancel-auto';
      cancelBtn.textContent = '✋ Отмена авто';
      cancelBtn.onclick = () => { stopAutoTimer('Автозапуск отменён — нажмите ▶ вручную.'); dequeueAuto(autoHandle); };
      panel.querySelector('.ax-exec-btns').appendChild(cancelBtn);
    }

    function showQueued(i) {
      if (phase2 || autoHandle.done || autoCancelled) return;
      status.className = 'ax-exec-status ax-running';
      status.textContent = i === 0 ? '🤖 Автопилот: подготовка…' : '🤖 В очереди на автозапуск (#' + (i + 1) + ')…';
    }

    function runAutoNow(onDone) {
      const finQ = () => { try { onDone && onDone(); } catch {} };
      // Разовый пропуск проверок гасим СРАЗУ (иначе ранний выход оставлял его взведённым
      // для следующего запуска этой панели).
      const bypassChecks = forceAutoOnce;
      forceAutoOnce = false;
      if (autoCancelled || autoHandle.done) { finQ(); return; }
      if (!settings.autoExecute) {
        noteToChat('\n[LOCAL EXEC] status=skipped reason=auto-disabled (выключено в настройках)\n');
        status.className = 'ax-exec-status';
        status.textContent = 'Автовыполнение выключено в настройках — нажмите ▶ вручную.';
        finQ(); return;
      }
      if (flags.weak && !settings.autoWeak) {
        noteToChat('\n[LOCAL EXEC] status=skipped reason=weak-disabled (блок EXECUTE?, автозапуск выключен)\n');
        status.className = 'ax-exec-status';
        status.textContent = MSG_WEAK_AUTO_OFF;
        finQ(); return;
      }
      if (loopBlocked) {
        noteToChat('\n[LOCAL EXEC] status=skipped reason=loop-guard (зацикливание, автопилот остановлен)\n');
        status.className = 'ax-exec-status';
        status.textContent = MSG_LOOP_OFF;
        finQ(); return;
      }
      phase2 = true;
      const runLim = +settings.maxAutoRuns || 0;
      if (runLim > 0 && autoRunCount >= runLim) {
        noteToChat('\n[LOCAL EXEC] status=skipped reason=tab-limit (' + runLim + ')\n');
        status.className = 'ax-exec-status';
        status.textContent = '🛑 Лимит автозапусков (' + runLim + ') на вкладку исчерпан — дальше вручную.';
        finQ(); return;
      }
      status.className = 'ax-exec-status ax-running';
      status.textContent = '🤖 Автопилот: жду конца генерации…';
      settleCancelFn = waitForSettle(pre, (settled) => {
        settleCancelFn = null;
        try {
        if (autoCancelled) { finQ(); return; }
        const cmd = (settled || '').trim();
        if (!cmd) { stopAutoTimer('Пустая команда — пропуск.'); finQ(); return; }
        maybeResniff(cmd);
        if (isDangerous(cmd)) {
          noteToChat('\n[LOCAL EXEC] status=skipped reason=dangerous-manual-only\n$ ' + cmd + '\n');
          stopAutoTimer();
          status.className = 'ax-exec-status ax-err';
          status.textContent = '⛔ Опасная команда: только вручную кнопкой ▶.';
          finQ(); return;
        }
        const dup = dupAge(cmd, panelRunner());
        if (dup > 0) {
          noteToChat('\n[LOCAL EXEC] status=skipped reason=duplicate age=' + dup + 's\n$ ' + cmd + '\n');
          stopAutoTimer('⏭ Дубль: такая команда уже выполнялась ' + dup + 'с назад — пропуск (жми ▶ для повтора).');
          finQ(); return;
        }
        if (!bypassChecks) {
          const hist = historyAge(cmd, panelRunner());
          if (hist > 0) {
            noteToChat('\n[LOCAL EXEC] status=skipped reason=already-executed age=' + hist + 's\n$ ' + cmd + '\n');
            stopAutoTimer('⏭ Уже выполнялась раньше (' + fmtAge(hist) + ' назад) — пропуск (жми ▶ для повтора).');
            finQ(); return;
          }
          if (!flags.forced && Date.now() - AX_BOOT < BOOT_GRACE_MS && createdCmd && cmd === createdCmd) {
            noteToChat('\n[LOCAL EXEC] status=skipped reason=old-block (был на странице при загрузке)\n$ ' + cmd + '\n');
            stopAutoTimer('⏭ Блок уже был на странице при загрузке — автозапуск пропущен (жми ▶).');
            finQ(); return;
          }
        }
        refreshPreview(cmd);
        lastAutoCommands.push(cmd);
        if (lastAutoCommands.length > 5) lastAutoCommands.shift();
        if (lastAutoCommands.length >= 3 && lastAutoCommands.slice(-3).every((c) => c === cmd)) {
          loopBlocked = true;
          noteToChat('\n[LOCAL EXEC] status=skipped reason=loop-guard (одна команда 3 раза подряд)\n');
          stopAutoTimer('🛑 Одна и та же команда 3 раза подряд — автопилот остановлен, дальше вручную.');
          toast('🛑 Похоже на зацикливание ИИ — автопилот выключен');
          finQ(); return;
        }
        const d = +settings.autoDelay;
        const left0 = (Number.isFinite(d) ? Math.max(0, Math.min(30, d)) : 3);
        const fireAt = Date.now() + left0 * 1000; // часы, а не счётчик: в фоновой вкладке таймеры тормозятся
        const tick = () => {
          const rem = Math.max(0, Math.ceil((fireAt - Date.now()) / 1000));
          status.textContent = '🤖 Автозапуск через ' + rem + 'с… (✋ Отмена авто — остановить)';
        };
        const fire = () => {
          autoRunCount++;
          markAutoRun(cmd, panelRunner());
          const cb = panel.querySelector('.ax-btn-cancel-auto');
          if (cb) cb.remove();
          doRun(cmd, true, finQ);
        };
        if (left0 <= 0) { fire(); return; }
        tick();
        autoTimer = setInterval(() => {
          if (autoCancelled) { if (autoTimer) clearInterval(autoTimer); autoTimer = null; finQ(); return; }
          if (Date.now() >= fireAt) { if (autoTimer) clearInterval(autoTimer); autoTimer = null; fire(); }
          else tick();
        }, 1000);
        } catch (e) { console.warn('[AX] auto:', e); stopAutoTimer('Ошибка автозапуска — жми ▶ вручную.'); finQ(); }
      });
    }

    panel.querySelector('.ax-btn-insert').onclick = () => {
      try { insertIntoChat('\n```text\n' + lastFormatted + '\n```\n'); } catch {}
      silentCopy(lastFormatted);
    };
    panel.querySelector('.ax-btn-copy-out').onclick = async () => {
      try { await navigator.clipboard.writeText(lastFormatted); toast('Вывод скопирован'); }
      catch { toast('Не удалось скопировать'); }
    };

    const autoHandle = { el: panel, started: false, done: false, finish() { this.done = true; }, start() { startAuto(); }, showQueued(i) { showQueued(i); }, runNow(cb) { runAutoNow(cb); }, retry() { if (!this.done) this.started = false; this.start(); } };
    livePanels.push(autoHandle);
    // Старт автозапуска — только после вставки панели в DOM (вызывает scan, см. ниже):
    // очередь считает disconnected-панели мёртвыми и пропускает их.
    panel._axStart = () => { try { autoHandle.start(); } catch (e) { console.warn('[AX] autostart:', e); } };

    // Быстрое включение автопилота прямо с панели (чтобы не искать попап)
    (function addQuickAuto() {
      const needExec = !settings.autoExecute || (flags.weak && !settings.autoWeak);
      if (!needExec || autoHandle.done) return;
      const q = document.createElement('button');
      q.className = 'ax-btn ax-btn-copy ax-btn-quickauto';
      q.textContent = '🤖 Включить авто';
      q.title = 'Включить полный автопилот (выполнение + вставка + отправка) и сохранить в настройках';
      q.onclick = async () => {
        try {
          if (!ctxAlive()) { handleDeadContext(); return; }
          const patch = { autoExecute: true, autoInsert: true, autoSend: true };
          if (flags.weak) patch.autoWeak = true;
          await chrome.storage.sync.set(patch);
          Object.assign(settings, patch);
          const note = panel.querySelector('.ax-exec-header div');
          if (note && flags.weak) note.textContent = '🔍 находка нестрогая (EXECUTE?) — автозапуск разрешён';
          toast('🤖 Автопилот включён полностью (выполнение + вставка + отправка)');
          q.remove();
          autoHandle.started = false;
          autoCancelled = false;
          forceAutoOnce = true;
          startAuto();
        } catch { toast('Не удалось сохранить настройку'); }
      };
      panel.querySelector('.ax-exec-btns').appendChild(q);
    })();

    return panel;
  }

  // ---------- Сканирование страницы ----------

  function scan(root = document, force = false) {
    const pres = root.querySelectorAll ? root.querySelectorAll('pre') : [];
    // Чистим livePanels от удалённых из DOM (иначе висят мёртвые ссылки + растёт массив)
    for (let i = livePanels.length - 1; i >= 0; i--) {
      if (livePanels[i].el && !livePanels[i].el.isConnected) livePanels.splice(i, 1);
    }
    const now = Date.now();
    for (const pre of pres) {
      if (pre.dataset.axDone) continue; // панель уже добавлена
      // Во время стриминга (Arena/ChatGPT дорисовывают ответ) язык блока может
      // появиться позже — перепроверяем неопознанные блоки не чаще раза в 3 сек.
      if (!force && pre.dataset.axChecked && now - (+pre.dataset.axChecked) < 3000) continue;
      pre.dataset.axChecked = String(now);
      let info = detectRunner(pre);
      let weak = false;
      if (!info && settings.looseSearch !== false) {
        const fb = detectFallback(pre);
        if (fb) {
          info = { lang: 'execute', runner: fb.runner };
          weak = !fb.strong; // strong-маркеры ведут себя как обычные блоки
        }
      }
      if (!info) continue;
      const command = getCodeText(pre);
      // Простой execute + очевидный код на другом языке → правильная среда
      // (суффикс могли потерять ИИ или сайт). Явный суффикс и defaultRunner для
      // нестрогих блоков — важнее, их не трогаем.
      if (!weak && info.runner === 'shell') {
        const sniffed = sniffRunner(command);
        if (sniffed) info = { lang: info.lang, runner: sniffed };
      }
      try {
        const panel = buildPanel(pre, info, command, { weak, forced: force });
        // вставляем панель сразу после pre
        pre.insertAdjacentElement('afterend', panel);
        pre.dataset.axDone = '1';
        // ...и только теперь стартуем автозапуск: панель уже в DOM
        if (settings.autoExecute) panel._axStart();
        if (!foundToastShown) {
          foundToastShown = true;
          toast(settings.autoExecute ? '⚡ execute-блок найден, автозапуск включён' : '⚡ execute-блок найден — кнопка ▶ под кодом');
        }
      } catch (e) { /* ignore */ }
    }
  }

  // ---------- Диагностика (двойной клик по бейджу / AX_debug() в консоли) ----------

  function debugBlocks(verbose) {
    const pres = [...document.querySelectorAll('pre')];
    const rows = pres.map((pre, i) => {
      const info = detectRunner(pre);
      const code = pre.querySelector('code');
      return {
        '#': i,
        verdict: info ? (info.lang + ' → ' + info.runner) : '—',
        codeClass: code ? String(code.className || '').slice(0, 70) : '(no <code>)',
        preClass: String(pre.className || '').slice(0, 70),
        dataLang: (code && (code.dataset.language || code.dataset.lang)) || pre.dataset.language || pre.dataset.lang || '',
        neighbor: pre.previousElementSibling ? String(pre.previousElementSibling.textContent || '').trim().slice(0, 50) : ''
      };
    });
    const found = rows.filter((r) => r.verdict !== '—').length;
    console.log('%c[AX debug]%c <pre>: ' + pres.length + ', execute: ' + found + ' — пришлите это, если кнопки нет',
      'font-weight:bold;color:#7c5cff', 'color:inherit');
    if (rows.length) console.table(rows);
    else console.log('[AX debug] на странице вообще нет <pre> — ответ ещё генерируется или это не страница чата');
    if (verbose) toast('AX: блоков кода: ' + pres.length + ', execute: ' + found + ' (детали — консоль F12)');
    return { total: pres.length, execute: found };
  }
  // Ручные хелперы для консоли: AX_debug() — диагностика, AX_rescan() — перепроверить страницу
  window.AX_debug = () => debugBlocks(true);
  window.AX_rescan = () => { scan(document, true); toast('AX: страница пересканирована'); };

  // ---------- Индикатор сервера ----------

  function ensureDot() {
    if (document.getElementById('ax-server-dot')) return;
    const dot = document.createElement('div');
    dot.id = 'ax-server-dot';
    dot.textContent = '⚡ exec: …';
    dot.title = 'AI Execute Runner: клик — проверить сервер, двойной клик — диагностика блоков';
    dot.onclick = checkServer;
    dot.ondblclick = (e) => { e.preventDefault(); debugBlocks(true); };
    document.body.appendChild(dot);
  }

  let pingFails = 0; // подряд идущие провалы пинга (единичный пропуск бейдж не гасит)
  let oldSrvWarned = false; // тост про старый server.py — раз за загрузку
  function checkServer() {
    if (document.hidden) return; // фоновые вкладки сервер не дёргают
    if (!document.getElementById('ax-server-dot')) { try { ensureDot(); } catch {} }
    const dot = document.getElementById('ax-server-dot');
    if (dot && dot.className !== 'ax-online') dot.textContent = '⚡ exec: …';
    safeSend({ type: 'AX_PING' }, (resp) => {
      const d = document.getElementById('ax-server-dot');
      if (!d) return;
      if (resp && resp.ok) {
        pingFails = 0;
        d.className = 'ax-online';
        d.textContent = '⚡ exec: online';
        d.title = 'Сервер на связи: ' + JSON.stringify(resp.info);
        if (resp.info && !resp.info.version && !oldSrvWarned) {
          oldSrvWarned = true;
          toast('⚠️ server.py старый (не сообщает версию) — обнови файл, иначе часть функций не будет работать');
        }
      } else {
        pingFails++;
        if (pingFails < 2) return; // единичный пропуск (сервер занят командой) — не мигаем
        d.className = 'ax-offline';
        d.textContent = '⚡ exec: offline';
        d.title = 'Сервер недоступен: ' + ((resp && resp.error) || 'нет ответа') + '. Запустите server.py';
      }
    });
  }

  // ---------- Запуск ----------

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') {
        // стримминг дописывает текст в существующий <pre> — перепроверяем родителя
        const el = m.target.parentElement;
        if (el) scan(el.closest('pre') ? el.closest('pre').parentElement || document : el);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) {
          if (node.tagName === 'PRE') scan(node.parentElement || document);
          else scan(node);
        }
      }
    }
  });

  function init() {
    console.log('[AX] AI Execute Runner загружен на ' + location.hostname);
    scan(document);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    ensureDot();
    checkServer();
    serverTimer = setInterval(checkServer, 30000);
    // лёгкий периодический рескан: лечит пропущенные панели (дешёвый из-за троттлинга axChecked)
    scanTimer = setInterval(() => { try { scan(document); } catch {} }, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkServer(); });
    // пересканируем несколько раз — чаты (особенно Arena) долго дорисовывают DOM
    setTimeout(() => scan(document), 1500);
    setTimeout(() => scan(document), 4000);
    setTimeout(() => scan(document), 9000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
