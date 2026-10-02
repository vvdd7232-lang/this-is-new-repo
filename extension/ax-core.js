/* AI Execute Runner — ax-core.js
 * Ядро content-script: namespace AX, настройки, безопасная отправка сообщений,
 * работа с полем ввода чата, тосты, форматирование результата, память выбора
 * среды, история выполнения. Без автопилота и без панели (они в ax-panel.js).
 *
 * Все модули content-script'а разделяют один namespace: window.AX.
 */
(function () {
  'use strict';

  if (window.AX && window.AX.__coreLoaded) return; // защита от двойной загрузки

  const D = window.AXDetector;
  if (!D) {
    console.error('[AX] ax-detector.js не загружен — core не может стартовать');
    return;
  }

  const AX = window.AX = window.AX || {};
  AX.__coreLoaded = true;

  AX.DEFAULTS = {
    serverUrl: 'http://127.0.0.1:8765',
    timeout: 30,
    requireConfirm: true,
    maxOutputChars: 32000,
    autoExecute: false,
    autoInsert: false,
    autoSend: false,
    autoDelay: 3,
    looseSearch: true,
    autoWeak: false,
    maxAutoRuns: 0,
    defaultRunner: 'shell',
    showToasts: true,
    defaultCwd: '',
    authToken: '',
    uiTheme: 'auto',
    panelSize: 'normal',
    collapseAfterRun: false,
    soundOnComplete: false,
    browserNotify: false,
    echoMode: 'short',
  };
  AX.settings = { ...AX.DEFAULTS };

  // --- сквозное состояние (одно на вкладку) ---
  AX.axSeq = 0;
  AX.livePanels = [];
  AX.foundToastShown = false;
  AX.autoRunCount = 0;
  AX.lastAutoCommands = [];
  AX.loopBlocked = false;
  AX.AX_SESSION = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  AX.AX_BOOT = Date.now();
  AX.BOOT_GRACE_MS = 15000;
  AX.autoQueue = [];
  AX.autoActive = false;
  AX.currentAuto = null;
  AX.observer = null;
  AX.serverTimer = null;
  AX.scanTimer = null;
  AX.deadNotified = false;

  // --- утилиты, зависящие от chrome.* ---
  AX.ctxAlive = function () {
    try {
      const b = typeof browser !== 'undefined' ? browser.runtime : (window.chrome && chrome.runtime);
      return !!(b && b.id);
    } catch (e) { return false; }
  };

  AX.handleDeadContext = function () {
    try { if (AX.observer) AX.observer.disconnect(); } catch (e) { /* ignore */ }
    try { if (AX.serverTimer) { clearInterval(AX.serverTimer); AX.serverTimer = null; } } catch (e) { /* ignore */ }
    try { if (AX.scanTimer) { clearInterval(AX.scanTimer); AX.scanTimer = null; } } catch (e) { /* ignore */ }
    if (AX.deadNotified) return;
    AX.deadNotified = true;
    try {
      const dot = document.getElementById('ax-server-dot');
      if (dot) {
        dot.className = 'ax-offline';
        dot.textContent = '⚡ exec: обнови страницу (F5)';
        dot.title = 'Расширение было обновлено/перезагружено — нажми F5';
        dot.onclick = () => location.reload();
        dot.ondblclick = null;
      }
    } catch (e) { /* ignore */ }
    try { AX.toast('⚡ Расширение обновлено — обнови вкладку (F5)', 3000, true); } catch (e) { /* ignore */ }
  };

  AX.safeSend = function (msg, cb) {
    if (!AX.ctxAlive()) {
      if (cb) { try { cb(null); } catch (e) { /* ignore */ } }
      AX.handleDeadContext();
      return;
    }
    try {
      const b = typeof browser !== 'undefined' ? browser : chrome;
      const pr = b.runtime.sendMessage(msg);
      if (pr && pr.then) {
        pr.then((resp) => {
          if (cb) { try { cb(resp); } catch (e) { console.warn('[AX]', e); } }
        }).catch(() => {
          if (cb) { try { cb(null); } catch (e) { /* ignore */ } }
        });
      } else {
        chrome.runtime.sendMessage(msg, (resp) => {
          try { if (chrome.runtime.lastError) { if (cb) cb(null); return; } } catch (e) { /* ignore */ }
          if (cb) { try { cb(resp); } catch (e) { console.warn('[AX]', e); } }
        });
      }
    } catch (e) {
      if (cb) { try { cb(null); } catch (e2) { /* ignore */ } }
      AX.handleDeadContext();
    }
  };

  // --- тост ---
  AX.toast = function (text, ms, force) {
    ms = ms || 2200;
    if (!force && AX.settings && AX.settings.showToasts === false) return;
    let el = document.querySelector('.ax-toast');
    if (!el) { el = document.createElement('div'); el.className = 'ax-toast'; document.body.appendChild(el); }
    el.textContent = text;
    el.classList.add('ax-show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('ax-show'), ms);
  };

  // --- геометрия ---
  AX.isVisibleEl = function (el) {
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  };

  // --- shadow DOM ---
  const SHADOW_NODE_BUDGET = 20000;
  AX.collectShadowRoots = function () {
    const roots = [];
    let seen = 0;
    const walk = (root) => {
      let all = null;
      try { all = root.querySelectorAll('*'); } catch (e) { return; }
      for (const el of all) {
        if (++seen > SHADOW_NODE_BUDGET) return;
        if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); }
      }
    };
    try { walk(document); } catch (e) { /* ignore */ }
    return roots;
  };

  AX.deepQueryAll = function (selector, shadowRoots) {
    const out = [];
    try { for (const el of document.querySelectorAll(selector)) out.push(el); } catch (e) { return out; }
    if (shadowRoots) {
      for (const root of shadowRoots) {
        try { for (const el of root.querySelectorAll(selector)) out.push(el); } catch (e) { /* ignore */ }
      }
    }
    return out;
  };

  // --- детектор поля ввода чата ---
  AX.CHAT_INPUT_TIERS = [
    { site: 'DeepSeek',        sel: 'textarea[name="search"]' },
    { site: 'ChatGPT',         sel: 'textarea#prompt-textarea' },
    { site: 'ChatGPT',         sel: 'div#prompt-textarea[contenteditable="true"]' },
    { site: 'Claude',          sel: 'div.ProseMirror[contenteditable="true"]' },
    { site: 'Gemini',          sel: 'rich-textarea textarea' },
    { site: 'Copilot',         sel: 'textarea[data-testid="user-input"], #user-input-textbox' },
    { site: 'contenteditable', sel: 'div[contenteditable="true"][role="textbox"]' },
    { site: 'textarea',        sel: 'textarea[placeholder]' },
    { site: 'contenteditable', sel: 'div[contenteditable="true"]' },
    { site: 'textarea',        sel: 'textarea' },
  ];
  const AX_OWN_SEL = '.ax-exec-panel, .ax-modal, .ax-toast, .ax-view-wrap';

  AX.isOurNode = function (el) {
    try { return !!(el.closest && el.closest(AX_OWN_SEL)); } catch (e) { return false; }
  };

  AX.isChatInputCandidate = function (el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    const ceAttr = el.getAttribute ? el.getAttribute('contenteditable') : null;
    const isEditableHost = !!ceAttr && ceAttr !== 'false';
    if (tag !== 'TEXTAREA' && tag !== 'INPUT' && !isEditableHost) return false;
    if (tag === 'INPUT' && !/^(text|search|)$/i.test(el.type || 'text')) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (AX.isOurNode(el)) return false;
    const nm = (el.getAttribute('name') || '').toLowerCase();
    if (nm === 'user query' || nm === 'user_query') return false;
    if (!AX.isVisibleEl(el)) return false;
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || r.width < 60 || r.height < 12) return false;
    return true;
  };

  AX.pickLowestInput = function (list) {
    if (!list || !list.length) return null;
    let best = null, bestBottom = -Infinity, bestArea = 0;
    for (const el of list) {
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!r) continue;
      const area = r.width * r.height;
      if (r.bottom > bestBottom || (Math.abs(r.bottom - bestBottom) <= 60 && area > bestArea)) {
        best = el; bestBottom = Math.max(bestBottom, r.bottom); bestArea = Math.max(bestArea, area);
      }
    }
    return best;
  };

  AX.findChatInputDetailed = function () {
    const seen = new Set();
    const active = document.activeElement;
    const shadowRoots = AX.collectShadowRoots();
    for (const tier of AX.CHAT_INPUT_TIERS) {
      const found = [];
      for (const el of AX.deepQueryAll(tier.sel, shadowRoots)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (AX.isChatInputCandidate(el)) found.push(el);
      }
      if (!found.length) continue;
      let focused = null;
      for (const el of found) {
        if (el === active) { focused = el; break; }
        try { if (el.contains && el.contains(active)) { focused = el; break; } } catch (e) { /* ignore */ }
      }
      return { el: focused || AX.pickLowestInput(found), site: tier.site, tier: tier, candidates: found };
    }
    return { el: null, site: null, tier: null, candidates: [] };
  };

  AX.findChatInput = function () { return AX.findChatInputDetailed().el; };

  AX.describeChatInput = function (found) {
    if (!found || !found.el) return { found: false, url: location.href };
    const el = found.el;
    let r = {};
    try { r = el.getBoundingClientRect(); } catch (e) { /* ignore */ }
    return {
      found: true, site: found.site, selector: found.tier ? found.tier.sel : null,
      tag: el.tagName, id: el.id || '', name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      contenteditable: el.getAttribute('contenteditable'),
      isContentEditable: !!el.isContentEditable,
      className: el.className ? String(el.className).slice(0, 100) : '',
      bottom: Math.round(r.bottom || 0), width: Math.round(r.width || 0), height: Math.round(r.height || 0),
      candidates: (found.candidates || []).length,
    };
  };

  AX.setTextareaReactSafe = function (input, text) {
    try {
      const proto = window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const start = input.selectionStart != null ? input.selectionStart : input.value.length;
      const end = input.selectionEnd != null ? input.selectionEnd : input.value.length;
      setter.call(input, input.value.slice(0, start) + text + input.value.slice(end));
      try { input.selectionStart = input.selectionEnd = start + text.length; } catch (e) { /* ignore */ }
    } catch (e) {
      input.value += text;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  AX.insertIntoChat = function (text, toastText) {
    const input = AX.findChatInput();
    if (!input) { AX.silentCopy(text); if (toastText !== null) AX.toast('Поле ввода чата не найдено — результат скопирован в буфер'); return null; }
    try {
      input.focus();
      if (input.tagName === 'TEXTAREA') {
        AX.setTextareaReactSafe(input, text);
      } else {
        let ok = false;
        try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
        if (!ok) {
          const sel = window.getSelection();
          if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(document.createTextNode(text));
            range.collapse(false);
          } else {
            input.textContent += text;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    } catch (e) {
      AX.silentCopy(text);
      if (toastText !== null) AX.toast('Не удалось вставить в поле чата — текст скопирован');
      return null;
    }
    if (toastText === undefined) AX.toast('Результат вставлен в чат — нажмите Enter чтобы отправить ИИ');
    else if (toastText) AX.toast(toastText);
    return input;
  };

  AX.copyToClipboard = async function (text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* ignore */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      (document.body || document.documentElement).appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return true;
    } catch (e) { /* ignore */ }
    return false;
  };

  AX.silentCopy = function (text) {
    try { AX.copyToClipboard(text); } catch (e) { /* ignore */ }
  };

  AX.noteToChat = function (text) {
    if (!AX.settings.autoInsert) return;
    AX.insertIntoChat(text, null);
  };

  // --- отправка сообщения в чат ---
  AX.findSendButton = function (input) {
    const scopes = [];
    try { if (input && input.closest) { const f = input.closest('form'); if (f) scopes.push(f); } } catch (e) { /* ignore */ }
    scopes.push(document);
    const sels = [
      'button[data-testid*="send" i]',
      'button[aria-label*="send" i]',
      'button[aria-label*="отправить" i]',
      '[role="button"][data-testid*="send" i]',
      '[role="button"][aria-label*="send" i]',
      '[role="button"][aria-label*="отправить" i]',
      'button[type="submit"]',
      'button.send-button'
    ];
    for (const scope of scopes) {
      for (const sel of sels) {
        try {
          const b = scope.querySelector(sel);
          if (b && AX.isVisibleEl(b) && !b.disabled) return b;
        } catch (e) { /* ignore */ }
      }
    }
    return null;
  };

  AX.autoSendToChat = function (input, onSent) {
    const done = () => { try { onSent && onSent(); } catch (e) { /* ignore */ } };
    setTimeout(() => {
      if (!input || !input.isConnected) { AX.toast('Поле ввода исчезло — отправь сам'); done(); return; }
      const btn = AX.findSendButton(input);
      if (btn) { btn.click(); AX.toast('🤖 Результат отправлен ИИ'); done(); return; }
      try {
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        AX.toast('⚠️ Кнопка не найдена: Enter отправлен, но чат мог его проигнорировать');
      } catch (e) { AX.toast('Не нашёл кнопку отправки — нажми Enter сам'); }
      done();
    }, 700);
  };

  // --- форматирование результата ---
  AX.echoCommand = function (cmd, mode) {
    const c = cmd || '';
    if (mode === 'none') return '(команда скрыта: ' + c.split('\n').length + ' стр., ' + c.length + ' симв.)';
    if (mode === 'full') return c;
    const lines = c.split('\n');
    if (lines.length <= 1 && c.length <= 240) return c;
    const first = (lines[0] || '').slice(0, 200);
    return first + '\n…(команда скрыта: ' + lines.length + ' стр., ' + c.length + ' симв.)';
  };

  AX.formatResult = function (o) {
    const max = +AX.settings.maxOutputChars || 0;
    const so = o.stdout || '', se = o.stderr || '';
    let out = max > 0 ? so.slice(0, max) : so;
    let err = max > 0 ? se.slice(0, Math.floor(max / 2)) : se;
    const clipIns = max > 0 && so.length > max;
    let txt = '[LOCAL EXEC RESULT] seq=' + (o.seq || 0) + ' status=done' +
      ' runner=' + o.runner + ' exit=' + (o.exit_code == null ? '?' : o.exit_code) +
      ' executed=' + (o.executed === false ? 'no' : 'yes') +
      ' cwd="' + (o.cwd || '?') + '"' +
      ' stdout_bytes=' + (o.stdoutBytes != null ? o.stdoutBytes : so.length) +
      ' stderr_bytes=' + (o.stderrBytes != null ? o.stderrBytes : se.length) +
      (o.durationMs != null ? ' dur=' + (o.durationMs < 1000 ? o.durationMs + 'ms' : (o.durationMs / 1000).toFixed(1) + 's') : '') +
      (clipIns ? ' insert_truncated=yes shown_chars=' + out.length + '/' + so.length : '') +
      '\n$ ' + AX.echoCommand(o.command, o.echoMode) + '\n';
    if (out) txt += '--- stdout ---\n' + out + (max > 0 && so.length > max ? '\n…(обрезано вставкой: лимит ' + max + ' симв.)' : '') + '\n';
    const clipErr = max > 0 && se.length > Math.floor(max / 2);
    if (err) txt += '--- stderr ---\n' + err + (clipErr ? '\n…(обрезано вставкой: лимит ' + Math.floor(max / 2) + ' симв.)' : '') + '\n';
    if (!out && !err) txt += '(пустой вывод)\n';
    if (o.truncated) txt += o.timedOut
      ? '(команда убита по таймауту — вывод частичный, см. [TIMEOUT] в stderr)\n'
      : '(stdout/stderr обрезаны сервером: лимит ' + (o.limitBytes || '?') + ' байт)\n';
    return txt;
  };

  AX.formatRunResult = function (cmd, runRunner, r, seq, echoMode) {
    r = r || {};
    if (r.view) {
      const v = r.view;
      const head = '[LOCAL EXEC RESULT] seq=' + (seq || 0) + ' status=done view=' + v.path + '\n$ ' + AX.echoCommand(cmd, echoMode) + '\n';
      const body = '--- view ---\n\ud83d\uddbc\ufe0f ' + v.path + ' (' + v.mime + ', ' + v.size + ' B)\n';
      return head + body;
    }
    return AX.formatResult({
      command: cmd, runner: r.runner || runRunner, exit_code: r.exit_code,
      stdout: r.stdout || '', stderr: r.stderr || '', truncated: r.truncated, cwd: r.cwd,
      stdoutBytes: r.stdout_bytes, stderrBytes: r.stderr_bytes, limitBytes: r.limit_bytes,
      executed: r.executed, seq: seq, durationMs: r.duration_ms, timedOut: r.timed_out,
      echoMode: echoMode,
    });
  };

  // --- ожидание конца стриминга блока ---
  // Возвращает функцию отмены. cb('') если блок исчез из DOM.
  AX.waitForSettle = function (pre, cb) {
    let last = '';
    try { last = window.AXDetector.getCodeText(pre); } catch (e) { /* ignore */ }
    const t0 = Date.now();
    let lastChange = t0, goneSince = 0;
    const iv = setInterval(() => {
      const now = Date.now();
      if (pre && !pre.isConnected) {
        if (!goneSince) goneSince = now;
        if (now - goneSince >= 1500) { clearInterval(iv); cb(''); return; }
      } else goneSince = 0;
      let cur = '';
      try { cur = window.AXDetector.getCodeText(pre); } catch (e) { /* ignore */ }
      if (cur !== last) { last = cur; lastChange = now; }
      if (now - lastChange >= 2500 || now - t0 >= 120000) { clearInterval(iv); cb(last); }
    }, 500);
    return () => clearInterval(iv);
  };

  // --- история выполнения (переживает F5) ---
  const EXEC_HIST_KEY = 'axExecutedHistory';
  AX.execHistory = new Map();
  AX.autoRunKey = function (cmd, runner) { return runner + '\n' + (cmd || '').trim().slice(0, 4000); };
  AX.loadExecHistory = function (o) {
    AX.execHistory.clear();
    if (o) for (const [k, v] of Object.entries(o)) {
      if (v && typeof v.t === 'number') AX.execHistory.set(k, { t: v.t, s: typeof v.s === 'string' ? v.s : '' });
    }
  };
  AX.saveExecHistory = function () {
    try {
      const b = typeof browser !== 'undefined' ? browser : chrome;
      b.storage.local.set({ [EXEC_HIST_KEY]: Object.fromEntries(AX.execHistory) });
    } catch (e) { /* ignore */ }
  };
  AX.markExecuted = function (cmd, runner) {
    AX.execHistory.delete(AX.autoRunKey(cmd, runner));
    AX.execHistory.set(AX.autoRunKey(cmd, runner), { t: Date.now(), s: AX.AX_SESSION });
    while (AX.execHistory.size > 200) AX.execHistory.delete(AX.execHistory.keys().next().value);
    AX.saveExecHistory();
  };
  AX.historyAge = function (cmd, runner) {
    const e = AX.execHistory.get(AX.autoRunKey(cmd, runner));
    if (!e || e.s === AX.AX_SESSION) return 0;
    return Math.max(1, Math.round((Date.now() - e.t) / 1000));
  };
  AX.fmtAge = function (sec) {
    if (sec < 120) return sec + 'с';
    if (sec < 7200) return Math.round(sec / 60) + 'м';
    if (sec < 172800) return Math.round(sec / 3600) + 'ч';
    return Math.round(sec / 86400) + 'д';
  };
  AX.EXEC_HIST_KEY = EXEC_HIST_KEY;

  // --- память выбора среды (начало текста -> runner) ---
  const RUNNER_MEM_KEY = 'axRunnerMemory';
  AX.runnerMemory = new Map();
  AX.memKey = function (code) { return (code || '').trim().replace(/\s+/g, ' ').slice(0, 200); };
  AX.memGet = function (code) { return D.runnerValid(AX.runnerMemory.get(AX.memKey(code))); };
  AX.memSet = function (code, runner) {
    runner = D.runnerValid(runner);
    if (!runner || !AX.memKey(code)) return;
    AX.runnerMemory.delete(AX.memKey(code));
    AX.runnerMemory.set(AX.memKey(code), runner);
    while (AX.runnerMemory.size > 100) AX.runnerMemory.delete(AX.runnerMemory.keys().next().value);
    try {
      const b = typeof browser !== 'undefined' ? browser : chrome;
      b.storage.local.set({ [RUNNER_MEM_KEY]: Object.fromEntries(AX.runnerMemory) });
    } catch (e) { /* ignore */ }
  };

  // --- загрузка состояния из storage ---
  AX.loadStorageState = function () {
    try {
      const b = typeof browser !== 'undefined' ? browser : chrome;
      const onHist = (d) => AX.loadExecHistory(d && d[EXEC_HIST_KEY]);
      const onMem = (d) => {
        const o = d && d[RUNNER_MEM_KEY];
        let pruned = false;
        if (o) for (const [k, v] of Object.entries(o)) {
          const r = D.runnerValid(v);
          if (!r) continue;
          if (r === 'shell') {
            try {
              if (D.sniffRunner(k) || D.sniffRunner(k.replace(/^(#|\/\/)\s*\S+\s+/, ''))) { pruned = true; continue; }
            } catch (e) { /* ignore */ }
          }
          AX.runnerMemory.set(k, r);
        }
        if (pruned) {
          try { b.storage.local.set({ [RUNNER_MEM_KEY]: Object.fromEntries(AX.runnerMemory) }); } catch (e) { /* ignore */ }
        }
      };
      const pr1 = b.storage.local.get([EXEC_HIST_KEY]);
      if (pr1 && pr1.then) pr1.then(onHist);
      else chrome.storage.local.get([EXEC_HIST_KEY], onHist);
      const pr2 = b.storage.local.get([RUNNER_MEM_KEY]);
      if (pr2 && pr2.then) pr2.then(onMem);
      else chrome.storage.local.get([RUNNER_MEM_KEY], onMem);
    } catch (e) { /* ignore */ }
  };

  // --- подписка на изменения настроек ---
  AX.initSettings = function (onAfterChange) {
    AX.safeSend({ type: 'AX_GET_SETTINGS' }, (resp) => {
      if (resp && resp.ok) {
        AX.settings = { ...AX.settings, ...resp.settings };
        try { onAfterChange && onAfterChange(null); } catch (e) { console.warn('[AX]', e); }
      }
    });
    try {
      (typeof browser !== 'undefined' ? browser : chrome).storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
          if (changes[EXEC_HIST_KEY]) AX.loadExecHistory(changes[EXEC_HIST_KEY].newValue);
          return;
        }
        if (area !== 'sync') return;
        for (const [k, v] of Object.entries(changes)) AX.settings[k] = v.newValue;
        if (changes.autoExecute && changes.autoExecute.newValue === true) {
          AX.loopBlocked = false;
          AX.lastAutoCommands = [];
        }
        try { onAfterChange && onAfterChange(changes); } catch (e) { console.warn('[AX]', e); }
      });
    } catch (e) { /* ignore */ }
  };

  // --- дедуп автозапусков в пределах сессии ---
  const DEDUP_WINDOW_MS = 60000;
  AX.recentAutoRuns = new Map();
  AX.dupAge = function (cmd, runner) {
    const now = Date.now();
    for (const [k, t] of AX.recentAutoRuns) if (now - t > DEDUP_WINDOW_MS) AX.recentAutoRuns.delete(k);
    const t = AX.recentAutoRuns.get(AX.autoRunKey(cmd, runner));
    return t ? Math.max(1, Math.round((now - t) / 1000)) : 0;
  };
  AX.markAutoRun = function (cmd, runner) {
    AX.recentAutoRuns.delete(AX.autoRunKey(cmd, runner));
    AX.recentAutoRuns.set(AX.autoRunKey(cmd, runner), Date.now());
    while (AX.recentAutoRuns.size > 200) AX.recentAutoRuns.delete(AX.recentAutoRuns.keys().next().value);
  };

  // --- индикатор звуком / notify ---
  AX.playBeep = function (ok) {
    try {
      if (!AX.settings.soundOnComplete) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = ok ? 880 : 220;
      gain.gain.value = 0.06;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
      setTimeout(() => { try { ctx.close(); } catch (e) { /* ignore */ } }, 300);
    } catch (e) { /* ignore */ }
  };

  AX.notifyDone = function (ok, cmd) {
    try {
      if (!AX.settings.browserNotify) return;
      if (typeof Notification === 'undefined') return;
      if (document.visibilityState === 'visible') return;
      if (Notification.permission !== 'granted') {
        try { Notification.requestPermission(); } catch (e) { /* ignore */ }
        return;
      }
      const title = ok ? '\u2705 Команда выполнена' : '\u26a0\ufe0f Команда с ошибкой';
      const body = (cmd || '').slice(0, 120);
      new Notification(title, { body, silent: true });
    } catch (e) { /* ignore */ }
  };

  // --- реакция на сеттлы ---
  AX.applyPanelAppearance = function (panel) {
    try {
      const size = AX.settings.panelSize || 'normal';
      panel.classList.remove('ax-size-compact', 'ax-size-large');
      if (size === 'compact') panel.classList.add('ax-size-compact');
      else if (size === 'large') panel.classList.add('ax-size-large');
      const theme = AX.settings.uiTheme || 'auto';
      panel.classList.remove('ax-theme-light', 'ax-theme-dark');
      if (theme === 'light') panel.classList.add('ax-theme-light');
      else if (theme === 'dark') panel.classList.add('ax-theme-dark');
    } catch (e) { /* ignore */ }
  };

  console.log('[AX] core loaded');
})();
