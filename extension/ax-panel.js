/* AI Execute Runner — ax-panel.js
 * Подтверждение запуска, панель под execute-блоком, очередь автозапусков и
 * логика автопилота (дедуп, история, loop-guard, лимиты). Зависит от AX (core)
 * и AXDetector.
 */
(function () {
  'use strict';
  const AX = window.AX;
  const D = window.AXDetector;
  if (!AX || !D || AX.__panelLoaded) return;
  AX.__panelLoaded = true;

  const MSG_WEAK_AUTO_OFF = '🔍 EXECUTE?: автозапуск для таких блоков выключен — жми ▶ вручную (или включи «Автозапуск блоков EXECUTE?» в настройках).';
  const MSG_LOOP_OFF = '🛑 Автопилот остановлен (зацикливание) — дальше вручную.';

  // ---------- модалка подтверждения ----------
  AX.confirmModal = function ({ lang, runner, command }) {
    return new Promise((resolve) => {
      const backdrop = AX.createShadowModal();
      const level = D.dangerLevel(command);
      const dangerous = level !== null;
      backdrop.innerContent.innerHTML =
        '<div class="ax-modal">' +
          '<h3></h3>' +
          '<div class="ax-modal-desc"></div>' +
          '<div class="ax-runner-row">Среда выполнения<select class="ax-runner-select ax-modal-select"></select></div>' +
          '<pre></pre>' +
          '<div class="ax-modal-warn"></div>' +
          '<div class="ax-modal-row">' +
            '<button class="ax-btn ax-btn-cancel">Отмена</button>' +
            '<button class="ax-btn ax-btn-confirm">Выполнить</button>' +
          '</div>' +
        '</div>';

      const heading = backdrop.$('h3');
      heading.textContent = '';
      heading.appendChild(AX.icon('bolt'));
      heading.appendChild(document.createTextNode('Выполнить команду локально?'));
      AX.setBtnLabel(backdrop.$('.ax-btn-cancel'), null, 'Отмена');
      AX.setBtnLabel(backdrop.$('.ax-btn-confirm'), 'play', 'Выполнить');

      backdrop.$('.ax-modal-desc').textContent = 'Блок ' + lang + ' · сервер ' + AX.settings.serverUrl;
      const warnBox = backdrop.$('.ax-modal-warn');
      if (level === 'hard') {
        warnBox.className = 'ax-warn ax-danger';
      } else if (level === 'soft') {
        warnBox.className = 'ax-warn ax-danger';
      } else {
        warnBox.className = 'ax-warn';
      }
      warnBox.textContent = '';
      warnBox.appendChild(AX.icon(level ? 'warn' : 'check'));
      const warnText = document.createElement('span');
      if (level === 'hard') {
        warnText.textContent = 'Команда похожа на необратимо опасную (удаление / форматирование / sudo / pipe в shell). Автопилот её не выполнит — только вручную. Запускайте, только если на 100% понимаете, что она делает.';
      } else if (level === 'soft') {
        warnText.textContent = 'В команде есть динамическое выполнение кода (eval / exec / Invoke-Expression). Часто это легитимный код (тесты, генераторы), но проверьте: команда выполняется с вашими правами.';
      } else {
        warnText.textContent = 'Команда выполнится на вашем компьютере с вашими правами. Проверьте её перед запуском.';
      }
      warnBox.appendChild(warnText);
      const confirmBtn = backdrop.$('.ax-btn-confirm');
      if (!dangerous) confirmBtn.classList.add('safe');
      backdrop.$('pre').textContent = command;
      const sel = backdrop.$('.ax-modal-select');
      AX.fillRunnerSelect(sel, runner);
      const onKey = (e) => {
        if (e.key === 'Escape') { cleanup(); resolve({ ok: false }); }
      };
      const cleanup = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
      backdrop.addEventListener('click', (e) => {
        // Подтверждение — это действие пользователя: синтетический клик из
        // page-JS не должен запускать команду.
        if (!AX.assumeTrustedEvents && e.isTrusted === false) {
          AX.toast('⛔ Подтверждение сгенерировано скриптом — игнорирую');
          return;
        }
        if (e.target === backdrop || e.target.closest('.ax-btn-cancel')) { cleanup(); resolve({ ok: false }); }
        if (e.target.closest('.ax-btn-confirm')) { cleanup(); resolve({ ok: true, runner: sel.value }); }
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(backdrop);
      try { backdrop.$('.ax-btn-confirm').focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    });
  };

  AX.fillRunnerSelect = function (sel, current) {
    sel.innerHTML = '';
    for (const [val, label] of D.RUNNER_OPTIONS) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      if (val === current) o.selected = true;
      sel.appendChild(o);
    }
  };

  // ---------- окно результата (для контекстного меню) ----------
  AX.showResultModal = function (formatted, okExit) {
    const backdrop = AX.createShadowModal();
    backdrop.innerContent.innerHTML =
      '<div class="ax-modal">' +
        '<h3 class="ax-modal-title"></h3>' +
        '<div class="ax-modal-desc"></div>' +
        '<pre></pre>' +
        '<div class="ax-modal-row">' +
          '<button class="ax-btn ax-btn-copy">Копировать</button>' +
          '<button class="ax-btn ax-btn-insert">Вставить в чат</button>' +
          '<button class="ax-btn ax-btn-cancel">Закрыть</button>' +
        '</div>' +
      '</div>';
    AX.setBtnLabel(backdrop.$('.ax-btn-copy'), 'copy', 'Копировать');
    AX.setBtnLabel(backdrop.$('.ax-btn-insert'), 'chat', 'Вставить в чат');
    AX.setBtnLabel(backdrop.$('.ax-btn-cancel'), null, 'Закрыть');

    const title = backdrop.$('.ax-modal-title');
    title.textContent = '';
    title.appendChild(AX.icon(okExit ? 'check' : 'warn'));
    title.appendChild(document.createTextNode(okExit ? 'Команда выполнена' : 'Команда завершилась с ошибкой'));
    title.classList.add(okExit ? 'ax-ok' : 'ax-err');

    backdrop.$('.ax-modal-desc').textContent = 'Вывод команды, выполненной через контекстное меню.';
    backdrop.$('pre').textContent = formatted;
    const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
    const cleanup = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const sure = (e) => !(e && e.isTrusted === false);
    backdrop.$('.ax-btn-copy').onclick = async (e) => {
      if (!sure(e)) return;
      const ok = await AX.copyToClipboard(formatted);
      AX.toast(ok ? 'Вывод скопирован' : 'Не удалось скопировать');
    };
    backdrop.$('.ax-btn-insert').onclick = (e) => {
      if (!sure(e)) return;
      try { AX.insertIntoChat('\n```text\n' + formatted + '\n```\n'); } catch (e2) { /* ignore */ }
      AX.silentCopy(formatted);
      cleanup();
    };
    backdrop.$('.ax-btn-cancel').onclick = (e) => { if (sure(e)) cleanup(); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    try { backdrop.$('.ax-btn-insert').focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  };

  // ---------- запуск произвольного текста (контекстное меню, палитра) ----------
  let arbitraryRunning = false;
  let arbitraryStartedAt = 0;
  /**
   * @param {string} text команда
   * @param {string} [defaultRunner] среда по умолчанию
   * @param {{skipConfirm?: boolean}} [opts] skipConfirm — запустить без диалога
   *        (использует палитра команд по Ctrl+Enter). Опасные команды всё равно
   *        требуют подтверждения — предохранитель не обходится.
   */
  AX.runArbitrary = async function (text, defaultRunner, opts) {
    opts = opts || {};
    const command = (text || '').trim();
    if (!command) { AX.toast('Ничего не выделено'); return; }
    // Флаг ставим ДО модалки: иначе два быстрых вызова контекстного меню
    // показывали два диалога подтверждения, а зависший ответ навсегда
    // блокировал дальнейшие запуски (не было таймаута сброса).
    if (arbitraryRunning && Date.now() - arbitraryStartedAt < 120000) {
      AX.toast('Уже выполняется — дождись результата');
      return;
    }
    arbitraryRunning = true;
    arbitraryStartedAt = Date.now();
    const release = () => { arbitraryRunning = false; };
    let runRunner = defaultRunner || 'shell';
    if (runRunner === 'shell') {
      const sniffed = D.sniffRunner(command);
      if (sniffed) runRunner = sniffed;
    }
    const needConfirm = D.isHardDangerous(command) || (!opts.skipConfirm && AX.settings.requireConfirm);
    if (needConfirm) {
      const res = await AX.confirmModal({ lang: 'selection', runner: runRunner, command });
      if (!res || !res.ok) { release(); return; }
      runRunner = res.runner || runRunner;
    }
    AX.toast('⏳ Выполняется локально…');
    const mySeq = ++AX.axSeq;
    AX.safeSend(
      { type: 'AX_RUN', payload: { command, runner: runRunner, timeout: AX.settings.timeout, cwd: AX.settings.defaultCwd || undefined } },
      (resp) => {
        release();
        if (!resp || !resp.ok) {
          AX.toast('❌ ' + ((resp && resp.error) || 'нет ответа') + ' — запущен ли server.py?');
          return;
        }
        const r = resp.result || {};
        if (r.blocked) {
          AX.toast('\u26d4 Whitelist: ' + (r.error || 'команда не разрешена'));
          return;
        }
        AX.markExecuted(command, r.runner || runRunner);
        // Журнал для палитры команд: текст, среда и код возврата (без вывода —
        // чтобы не раздувать storage и не тащить в историю секреты из вывода).
        try { AX.logCommand(command, r.runner || runRunner, r.exit_code, r.blocked ? 'blocked' : 'done'); } catch (e) { /* ignore */ }
        const formatted = AX.formatRunResult(command, runRunner, r, mySeq, 'full');
        AX.showResultModal(formatted, r.exit_code === 0);
      }
    );
  };

  // ---------- очередь автозапусков ----------
  function updateQueueStatuses() {
    AX.autoQueue.forEach((h, i) => { try { h.showQueued(i); } catch (e) { /* ignore */ } });
  }

  function dequeueAuto(handle) {
    const ix = AX.autoQueue.indexOf(handle);
    if (ix >= 0) AX.autoQueue.splice(ix, 1);
    if (AX.autoActive && AX.currentAuto === handle) { AX.autoActive = false; AX.currentAuto = null; }
    updateQueueStatuses();
    AX.pumpAutoQueue();
  }
  AX.dequeueAuto = dequeueAuto;

  function enqueueAuto(handle) {
    if (!AX.autoQueue.includes(handle)) AX.autoQueue.push(handle);
    updateQueueStatuses();
    AX.pumpAutoQueue();
  }
  AX.enqueueAuto = enqueueAuto;

  AX.pumpAutoQueue = function () {
    if (AX.autoActive) return;
    let h = null;
    while (AX.autoQueue.length) {
      const cand = AX.autoQueue[0];
      const dead = cand.el && !cand.el.isConnected;
      if (dead || cand.claimed) { AX.autoQueue.shift(); updateQueueStatuses(); continue; }
      h = cand;
      break;
    }
    if (!h) return;
    AX.autoActive = true;
    AX.currentAuto = h;
    h.claimed = true;
    try {
      h.runNow(() => {
        const ix = AX.autoQueue.indexOf(h);
        if (ix >= 0) AX.autoQueue.splice(ix, 1);
        if (AX.currentAuto === h) { AX.autoActive = false; AX.currentAuto = null; }
        updateQueueStatuses();
        AX.pumpAutoQueue();
      });
    } catch (e) {
      const ix = AX.autoQueue.indexOf(h);
      if (ix >= 0) AX.autoQueue.splice(ix, 1);
      AX.autoActive = false;
      AX.currentAuto = null;
      updateQueueStatuses();
      AX.pumpAutoQueue();
    }
  };

  // ---------- изоляция UI: shadow DOM ----------
  // Панель — обычный div в DOM страницы, поэтому скрипт сайта чата мог её
  // читать и СИНТЕТИЧЕСКИ КЛИКАТЬ по кнопкам (подтверждение было только
  // визуальным). Закрытый shadow root делает содержимое недоступным для
  // page-JS (`host.shadowRoot === null`), а isTrusted-проверки закрывают
  // клики, сгенерированные из кода.
  const SHADOW_HOSTS = [];
  AX.__shadowHosts = SHADOW_HOSTS;

  // Набор иконок (заменяют эмодзи: премиальнее и одинаково выглядит на всех ОС).
  // Компактная таблица путей: собираем <svg> программно, без innerHTML.
  const ICON_PATHS = {
    bolt: 'M13 2 3 14h9l-1 8 10-12h-9l1-8Z',
    play: 'M6 3.5 19.5 12 6 20.5V3.5Z',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    chat: 'M21 12a8 8 0 0 1-8 8H7l-4 3v-4.5A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8Z',
    robot: 'M12 3v2M7 8h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Zm3 4v2.2m4-2.2v2.2M9 18v2m6-2v2',
    stop: 'M7 7h10v10H7z',
    image: 'M3 5h18v14H3zM3 15l5-5 6 6m0 0 3-3 4 4',
    check: 'M20 6 9 17l-5-5',
    warn: 'M12 9.5v4m0 3.5h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
    chevron: 'M9.5 6l6 6-6 6',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  };

  AX.icon = function (name, extraClass) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ax-ico' + (extraClass ? ' ' + extraClass : ''));
    const d = ICON_PATHS[name];
    if (!d) return svg;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  };

  // Собирает содержимое кнопки: иконка + подпись (подпись остаётся в textContent,
  // чтобы существующий код, меняющий btn.textContent, продолжал работать).
  AX.setBtnLabel = function (btn, iconName, label) {
    btn.textContent = '';
    if (iconName) btn.appendChild(AX.icon(iconName));
    const span = document.createElement('span');
    span.className = 'ax-btn-label';
    span.textContent = label || '';
    btn.appendChild(span);
    return span;
  };

  AX.btnLabel = function (btn) {
    const span = btn && btn.querySelector('.ax-btn-label');
    return span ? span.textContent : (btn ? btn.textContent : '');
  };

  // Полный CSS расширения внутри shadow root. Через @import (файлы объявлены в
  // web_accessible_resources), чтобы не дублировать стили в JS; в средах без
  // chrome.runtime.getURL (юнит-тесты в jsdom) просто пропускаем.
  AX.shadowCssImport = function () {
    try {
      const rt = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime
        : (typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime : null);
      if (!rt || !rt.getURL) return '';
      return '@import url("' + rt.getURL('ax-ui.css') + '");\n' +
             '@import url("' + rt.getURL('content.css') + '");\n';
    } catch (e) { return ''; }
  };

  // Фолбэк-оформление хоста, если внешний CSS не подгрузился (например, тесты
  // в jsdom): берём вычисленные стили с уже стилизованного хоста.
  function panelShadowCss(host) {
    let base = 'display:block;';
    try {
      const cs = window.getComputedStyle(host);
      if (cs) {
        base = 'display:block;color:' + cs.color + ';background:' + cs.backgroundColor +
               ';border:' + cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor +
               ';border-radius:' + cs.borderTopLeftRadius + ';padding:' + cs.padding +
               ';font-size:' + cs.fontSize + ';font-family:' + cs.fontFamily + ';';
      }
    } catch (e) { /* ignore */ }
    return ':host{' + base + '}';
  }

  // Создаёт host + закрытый shadow root и проксирует DOM-запросы, чтобы
  // существующий код панели продолжал работать с `panel.$(...)`.
  /* Токены темы объявлены в ax-ui.css на :root, но :root — это документ, а мы
     внутри shadow root: переменные оттуда не наследуются. Поэтому каждый
     закрытый shadow-хост обязан получить их явно. Забыть про это — значит
     получить модалку с прозрачным фоном (background: var(--ax-surface) → none).
     Ставим токены сразу при создании хоста, а не по месту использования. */
  AX.createShadowPanel = function () {
    const host = document.createElement('div');
    host.className = 'ax-exec-panel';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = AX.shadowCssImport() + panelShadowCss(host);
    const content = document.createElement('div');
    content.className = 'ax-shadow-content';
    shadow.appendChild(style);
    shadow.appendChild(content);
    SHADOW_HOSTS.push(host);
    if (SHADOW_HOSTS.length > 200) SHADOW_HOSTS.shift();
    host.$ = (sel) => content.querySelector(sel);
    host.$$ = (sel) => content.querySelectorAll(sel);
    host.innerContent = content;
    AX.applyPanelAppearance(host);
    return host;
  };

  // Модалка подтверждения: тот же закрытый shadow root. Иначе page-JS мог
  // напрямую «нажать» ▶ Выполнить в диалоге подтверждения.
  AX.createShadowModal = function () {
    const backdrop = document.createElement('div');
    backdrop.className = 'ax-modal-backdrop';
    const shadow = backdrop.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = AX.shadowCssImport();
    const content = document.createElement('div');
    content.className = 'ax-shadow-content';
    shadow.appendChild(style);
    shadow.appendChild(content);
    backdrop.$ = (sel) => content.querySelector(sel);
    backdrop.$$ = (sel) => content.querySelectorAll(sel);
    backdrop.innerContent = content;
    // Токены темы — сразу на хосте (см. комментарий у createShadowPanel).
    AX.applyPanelAppearance(backdrop);
    return backdrop;
  };

  // ---------- панель под блоком ----------
  /* Применяет (или снимает) свёрнутое состояние к блоку вывода.
   * outBox — .ax-exec-output, hint — .ax-noisy-hint. Возвращает true, если
   * вывод признан шумным и свёрнут. */
  AX.collapseNoisyOutput = function (outBox, hint, text) {
    if (!outBox || !hint) return false;
    hint.textContent = '';
    hint.className = 'ax-noisy-hint';
    outBox.classList.remove('ax-noisy');
    outBox.onclick = null;
    if (AX.settings.noisyCollapse === false) return false;

    let info = { noisy: false, total: 0 };
    try { info = AX.isNoisyOutput(text); } catch (e) { /* ignore */ }
    if (!info.noisy) return false;

    const show = (collapsed) => {
      outBox.classList.toggle('ax-noisy', collapsed);
      hint.classList.add('on');
      hint.textContent = '';
      hint.appendChild(AX.icon(collapsed ? 'chevron' : 'check'));
      const label = document.createElement('span');
      label.textContent = collapsed
        ? 'Вывод большой (' + info.total + ' строк) — показать полностью'
        : 'Свернуть вывод (' + info.total + ' строк)';
      hint.appendChild(label);
    };

    let collapsed = true;
    show(true);
    const toggle = () => { collapsed = !collapsed; show(collapsed); };
    hint.onclick = (e) => {
      if (!AX.assumeTrustedEvents && e && e.isTrusted === false) return;
      toggle();
    };
    // Клик по самому блоку тоже раскрывает — привычнее, чем искать кнопку.
    outBox.onclick = () => { if (collapsed) toggle(); };
    return true;
  };

  AX.buildPanel = function (pre, info, command, flags) {
    flags = flags || {};
    const createdCmd = (command || '').trim();
    const panel = AX.createShadowPanel();
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) panel.classList.add('ax-dark');
    // Повторяем применение темы: настройки могли прийти уже после создания
    // хоста (createShadowPanel вызывает applyPanelAppearance сам).
    AX.applyPanelAppearance(panel);

    panel.innerContent.innerHTML =
      '<div class="ax-exec-header">' +
        '<span class="ax-exec-badge"></span>' +
        '<span class="ax-runner-wrap">' +
          '<span class="ax-runner-label">среда</span>' +
          '<select class="ax-runner-select" title="Среда выполнения (можно переключить)"></select>' +
        '</span>' +
        '<button class="ax-btn ax-btn-run"></button>' +
        '<button class="ax-btn ax-btn-copy ax-btn-icon" title="Скопировать команду"></button>' +
      '</div>' +
      '<div class="ax-exec-cmd-preview" role="button" tabindex="0" title="Показать команду полностью">' +
        '<span class="ax-preview-text"></span>' +
        '<span class="ax-preview-hint"></span>' +
      '</div>' +
      '<div class="ax-exec-status"></div>' +
      '<div class="ax-exec-explain"></div>' +
      '<div class="ax-exec-output" style="display:none"></div>' +
      '<div class="ax-noisy-hint"></div>' +
      '<div class="ax-exec-after" style="display:none">' +
        '<button class="ax-btn ax-btn-insert"></button>' +
        '<button class="ax-btn ax-btn-copy ax-btn-copy-out ax-btn-icon" title="Скопировать вывод"></button>' +
      '</div>';

    // Иконки и подписи кнопок собираем программно (без эмодзи — одинаковый вид
    // на Windows/macOS/Linux и аккуратнее смотрится).
    const badge = panel.$('.ax-exec-badge');
    badge.textContent = '';
    badge.appendChild(AX.icon('bolt'));
    const badgeText = document.createElement('span');
    badgeText.textContent = 'EXECUTE';
    badge.appendChild(badgeText);

    AX.setBtnLabel(panel.$('.ax-btn-run'), 'play', 'Выполнить');
    AX.setBtnLabel(panel.$('.ax-btn-copy'), 'copy', '');
    AX.setBtnLabel(panel.$('.ax-btn-insert'), 'chat', 'В чат');
    AX.setBtnLabel(panel.$('.ax-btn-copy-out'), 'copy', '');

    // Структура предпросмотра команды: иконка-состояние, текст и подсказка.
    const previewBox = panel.$('.ax-exec-cmd-preview');
    previewBox.insertBefore(AX.icon('chevron', 'ax-preview-ico'), previewBox.firstChild);

    if (flags.weak) {
      panel.classList.add('ax-weak');
      badgeText.textContent = 'EXECUTE?';
      const note = document.createElement('span');
      note.className = 'ax-chip ax-chip-warn';
      note.textContent = AX.settings.autoWeak
        ? 'нестрогая находка — автозапуск разрешён'
        : 'нестрогая находка — только вручную';
      panel.$('.ax-exec-header').insertBefore(note, panel.$('.ax-runner-wrap'));
    }
    const runnerSelect = panel.$('.ax-runner-select');
    AX.fillRunnerSelect(runnerSelect, AX.memGet(command) || info.runner);
    runnerSelect.onchange = () => AX.memSet(command, runnerSelect.value);
    function panelRunner() {
      try { return (runnerSelect && runnerSelect.value) || info.runner; }
      catch (e) { return info.runner; }
    }
    function maybeResniff(cmd) {
      try {
        if (runnerSelect.value === 'shell' && info.runner === 'shell' && !AX.memGet(cmd)) {
          const sn = D.sniffRunner(cmd);
          if (sn) runnerSelect.value = sn;
        }
      } catch (e) { /* ignore */ }
      return panelRunner();
    }
    let previewExpanded = false;
    let previewCmd = command;
    renderPreview();
    previewBox.onclick = () => { previewExpanded = !previewExpanded; renderPreview(); };
    previewBox.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); previewExpanded = !previewExpanded; renderPreview(); }
    };

    const btnRun = panel.$('.ax-btn-run');
    const btnCopy = panel.$('.ax-btn-copy');
    const status = panel.$('.ax-exec-status');
    const outBox = panel.$('.ax-exec-output');
    const after = panel.$('.ax-exec-after');
    let lastFormatted = '';
    let lastChatFormatted = '';

    function renderPreview() {
      const box = panel.$('.ax-exec-cmd-preview');
      const text = box.querySelector('.ax-preview-text');
      const hint = box.querySelector('.ax-preview-hint');
      if (!text) return;
      const cmd = previewCmd || '';
      const lines = cmd.split('\n');
      const multi = lines.length > 1;
      // Сколько строк показывать в развёрнутом виде: настройка previewLines,
      // 0 = показать всё. Свернуть обратно можно кликом.
      const limit = Math.max(0, Math.min(500, +AX.settings.previewLines || 0));
      if (previewExpanded) {
        let shown = cmd;
        let hidden = 0;
        if (limit > 0 && lines.length > limit) {
          shown = lines.slice(0, limit).join('\n');
          hidden = lines.length - limit;
        }
        text.textContent = shown || '(пустая команда)';
        if (hint) hint.textContent = hidden ? 'свернуть · ещё ' + hidden + ' стр.' : 'свернуть';
        box.classList.add('expanded');
        box.title = 'Свернуть';
      } else {
        text.textContent = lines[0] || '(пустая команда)';
        if (hint) hint.textContent = multi ? 'ещё ' + (lines.length - 1) + ' стр.' : '';
        box.classList.remove('expanded');
        box.title = 'Показать команду полностью' + (limit > 0 && lines.length > limit ? ' (первые ' + limit + ' стр.)' : '');
      }
    }

    btnCopy.onclick = async () => {
      const ok = await AX.copyToClipboard(D.getCodeText(pre) || command);
      AX.toast(ok ? 'Команда скопирована' : 'Не удалось скопировать');
    };

    function refreshPreview(cmd) { previewCmd = cmd; renderPreview(); }

    /* Сворачивание «простыни»: длинные однотипные листинги (npm install дерево
     * файлов) занимают экраны, а нужен обычно только хвост. Оставляем верх
     * блока с градиентом и кнопку «показать все N строк». Логика вынесена в
     * AX.collapseNoisyOutput, чтобы ею пользовались и полигон, и тесты. */
    function applyNoisyCollapse(text) {
      AX.collapseNoisyOutput(panel.$('.ax-exec-output'), panel.$('.ax-noisy-hint'), text);
    }

    /* Понятное объяснение ошибки под статусом: «что случилось + что сделать».
     * Исходный вывод не заменяем — он остаётся в блоке результата. */
    function showExplain(result, okExit) {
      const box = panel.$('.ax-exec-explain');
      if (!box) return;
      box.textContent = '';
      box.className = 'ax-exec-explain';
      if (okExit) return;
      let info = null;
      try { info = D.describeFailure(result); } catch (e) { info = null; }
      if (!info) return;
      box.appendChild(AX.icon('warn'));
      const text = document.createElement('span');
      const title = document.createElement('b');
      title.textContent = info.title;
      text.appendChild(title);
      if (info.hint) {
        text.appendChild(document.createTextNode(' — ' + info.hint));
      }
      box.appendChild(text);
      box.classList.add('on');
      box.setAttribute('data-reason', info.id);
    }

    async function doRun(cmdOverride, isAuto, onDone) {
      const done = () => { try { onDone && onDone(); } catch (e) { /* ignore */ } };
      if (running) { AX.toast('Уже выполняется — дождись результата'); done(); return; }
      running = true;
      const fin = () => { running = false; done(); };
      if (!isAuto) { AX.loopBlocked = false; AX.lastAutoCommands = []; }
      const cmd = ((cmdOverride != null ? cmdOverride : D.getCodeText(pre)) || '').trim();
      if (!cmd) { AX.toast('Пустая команда'); fin(); return; }
      refreshPreview(cmd);
      let runRunner = maybeResniff(cmd);
      const mySeq = ++AX.axSeq;
      if (!isAuto && AX.settings.requireConfirm) {
        const beforeModal = panelRunner();
        const res = await AX.confirmModal({ lang: info.lang, runner: runRunner, command: cmd });
        if (!res || !res.ok) { fin(); return; }
        runRunner = res.runner || runRunner;
        if (runRunner !== beforeModal) { try { AX.memSet(cmd, runRunner); } catch (e) { /* ignore */ } }
        try { runnerSelect.value = runRunner; } catch (e) { /* ignore */ }
      }
      stopAutoTimer();
      btnRun.disabled = true;
      AX.setBtnLabel(btnRun, null, 'Выполняется…');
      status.className = 'ax-exec-status ax-running';
      status.textContent = isAuto ? '🤖 Автопилот: выполняется…' : 'Выполняется локально…';
      outBox.style.display = 'none';
      after.style.display = 'none';

      let runFinished = false;
      let runStatusSent = false;
      const runStatusTimer = AX.settings.autoInsert ? setTimeout(() => {
        if (runFinished || runStatusSent) return;
        runStatusSent = true;
        AX.noteToChat('\n[LOCAL EXEC] seq=' + mySeq + ' status=running runner=' + runRunner + '\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n');
      }, 800) : null;
      AX.safeSend(
        { type: 'AX_RUN', payload: { command: cmd, runner: runRunner, timeout: AX.settings.timeout, cwd: AX.settings.defaultCwd || undefined } },
        (resp) => {
          runFinished = true;
          if (runStatusTimer) clearTimeout(runStatusTimer);
          btnRun.disabled = false;
          AX.setBtnLabel(btnRun, 'play', 'Выполнить');
          if (!resp) {
            AX.noteToChat('\n[LOCAL EXEC RESULT] seq=' + mySeq + ' status=error\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\nнет ответа от расширения\n');
            status.className = 'ax-exec-status ax-err'; status.textContent = '❌ Нет ответа от расширения.'; fin(); return;
          }
          if (!resp.ok) {
            AX.noteToChat('\n[LOCAL EXEC RESULT] seq=' + mySeq + ' status=error\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n' + resp.error + '\n');
            const looksConn = /fetch|abort|network|ожидания|ECONN|Failed/i.test(resp.error || '');
            status.className = 'ax-exec-status ax-err';
            status.textContent = '❌ Ошибка: ' + resp.error + (looksConn ? ' — запущен ли server.py?' : '');
            AX.toast('❌ ' + resp.error);
            fin();
            return;
          }
          autoHandle.finish();
          const r = resp.result || {};
          if (r.blocked) {
            AX.noteToChat('\n[LOCAL EXEC RESULT] seq=' + mySeq + ' status=blocked reason=whitelist\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n' + (r.error || '') + '\n');
            status.className = 'ax-exec-status ax-err';
            status.textContent = '\u26d4 Whitelist: ' + (r.error || 'команда не разрешена');
            AX.toast('\u26d4 ' + (r.error || 'Заблокировано whitelist'));
            fin();
            return;
          }
          AX.markExecuted(cmd, r.runner || runRunner);
          try { AX.logCommand(cmd, r.runner || runRunner, r.exit_code, r.blocked ? 'blocked' : 'done'); } catch (e) { /* ignore */ }
          lastFormatted = AX.formatRunResult(cmd, runRunner, r, mySeq, 'full');
          lastChatFormatted = AX.formatRunResult(cmd, runRunner, r, mySeq, AX.settings.echoMode);
          if (r.view) {
            try { AX.renderView(panel, r.view); } catch (e) { /* ignore */ }
            try { Promise.resolve(AX.insertImageIntoChat(r.view)).catch((e) => console.warn('[AX] view insert:', e)); } catch (e) { /* ignore */ }
          }
          const okExit = r.view ? true : (r.exit_code === 0);
          status.className = 'ax-exec-status ' + (okExit ? 'ax-ok' : 'ax-err');
          if (r.view) {
            status.textContent = '🖼️ view: ' + r.view.path + ' (' + r.view.mime + ', ' + Math.round(r.view.size / 1024) + ' KB) #' + mySeq;
          } else {
            status.textContent = (okExit ? '✅ exit=0' : '⚠️ exit=' + r.exit_code) + ' #' + mySeq + ' • stdout: ' + (r.stdout || '').length + ' симв. • stderr: ' + (r.stderr || '').length + ' симв.';
          }
          outBox.textContent = lastFormatted;
          outBox.style.display = 'block';
          after.style.display = 'flex';
          // Человеческое объяснение провала: сырой stderr понятен не всем, а
          // ИИ в чате видит только текст — поэтому подсказка идёт и на панель.
          showExplain(r, okExit);
          applyNoisyCollapse(lastFormatted);
          AX.playBeep(okExit);
          AX.notifyDone(okExit, cmd);
          if (AX.settings.collapseAfterRun) panel.classList.add('ax-collapsed');
          if (AX.settings.autoInsert && lastChatFormatted) {
            try {
              const input = AX.insertIntoChat('\n```text\n' + lastChatFormatted + '\n```\n');
              if (input && AX.settings.autoSend) { AX.autoSendToChat(input, fin); return; }
            } catch (e) { console.warn('[AX] insert:', e); }
          }
          fin();
        }
      );
    }

    // Страховка от синтетических кликов из page-JS: выполняем/включаем
    // автопилот только по настоящему действию пользователя. Кнопки внутри
    // закрытого shadow root и так недоступны странице, это второй барьер.
    // AX.assumeTrustedEvents — ТОЛЬКО для юнит-тестов: jsdom не умеет
    // выставлять isTrusted=true, и без флага нельзя проверить сам путь запуска.
    function trustedClick(e) {
      if (AX.assumeTrustedEvents) return true;
      if (e && e.isTrusted === false) {
        AX.toast('⛔ Клик сгенерирован скриптом — игнорирую');
        return false;
      }
      return true;
    }

    panel.$('.ax-btn-run').onclick = (e) => {
      if (!trustedClick(e)) return;
      stopAutoTimer(); dequeueAuto(autoHandle); doRun(null, false);
    };

    // ---------- автозапуск этой панели ----------
    let autoTimer = null;
    let settleCancelFn = null;
    let autoCancelled = false;
    let running = false;
    let phase2 = false;
    let forceAutoOnce = false;

    function stopAutoTimer(msg) {
      autoCancelled = true;
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      if (settleCancelFn) { settleCancelFn(); settleCancelFn = null; }
      const cb = panel.$('.ax-btn-cancel-auto');
      if (cb) cb.remove();
      if (msg) { status.className = 'ax-exec-status'; status.textContent = msg; }
    }

    function startAuto() {
      if (autoHandle.started || autoHandle.done || autoCancelled) return;
      autoHandle.started = true;
      if (flags.weak && !AX.settings.autoWeak) {
        status.className = 'ax-exec-status';
        status.textContent = MSG_WEAK_AUTO_OFF;
        return;
      }
      if (!AX.settings.autoExecute) return;
      if (AX.loopBlocked) {
        status.className = 'ax-exec-status';
        status.textContent = MSG_LOOP_OFF;
        return;
      }
      ensureCancelBtn();
      enqueueAuto(autoHandle);
    }

    function ensureCancelBtn() {
      if (panel.$('.ax-btn-cancel-auto')) return;
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ax-btn ax-btn-copy ax-btn-cancel-auto';
      AX.setBtnLabel(cancelBtn, 'stop', 'Отмена авто');
      cancelBtn.onclick = () => { stopAutoTimer('Автозапуск отменён — нажмите ▶ вручную.'); dequeueAuto(autoHandle); };
      panel.$('.ax-exec-header').appendChild(cancelBtn);
    }

    function showQueued(i) {
      if (phase2 || autoHandle.done || autoCancelled) return;
      status.className = 'ax-exec-status ax-running';
      status.textContent = i === 0 ? 'Автопилот: подготовка…' : 'Автопилот: в очереди (#' + (i + 1) + ')…';
    }

    function runAutoNow(onDone) {
      const finQ = () => { try { onDone && onDone(); } catch (e) { /* ignore */ } };
      const bypassChecks = forceAutoOnce;
      forceAutoOnce = false;
      if (autoCancelled || autoHandle.done) { finQ(); return; }
      if (!AX.settings.autoExecute) {
        AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=auto-disabled (выключено в настройках)\n');
        status.className = 'ax-exec-status';
        status.textContent = 'Автовыполнение выключено в настройках — нажмите ▶ вручную.';
        finQ(); return;
      }
      if (flags.weak && !AX.settings.autoWeak) {
        AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=weak-disabled (блок EXECUTE?, автозапуск выключен)\n');
        status.className = 'ax-exec-status';
        status.textContent = MSG_WEAK_AUTO_OFF;
        finQ(); return;
      }
      if (AX.loopBlocked) {
        AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=loop-guard (зацикливание, автопилот остановлен)\n');
        status.className = 'ax-exec-status';
        status.textContent = MSG_LOOP_OFF;
        finQ(); return;
      }
      phase2 = true;
      const runLim = +AX.settings.maxAutoRuns || 0;
      if (runLim > 0 && AX.autoRunCount >= runLim) {
        AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=tab-limit (' + runLim + ')\n');
        status.className = 'ax-exec-status';
        status.textContent = '🛑 Лимит автозапусков (' + runLim + ') на вкладку исчерпан — дальше вручную.';
        finQ(); return;
      }
      status.className = 'ax-exec-status ax-running';
      status.textContent = '🤖 Автопилот: жду конца генерации…';
      settleCancelFn = AX.waitForSettle(pre, (settled) => {
        settleCancelFn = null;
        try {
          if (autoCancelled) { finQ(); return; }
          const cmd = (settled || '').trim();
          if (!cmd) { stopAutoTimer('Пустая команда — пропуск.'); finQ(); return; }
          maybeResniff(cmd);
          if (D.isHardDangerous(cmd)) {
            AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=dangerous-manual-only\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n');
            stopAutoTimer();
            status.className = 'ax-exec-status ax-err';
            status.textContent = '⛔ Опасная команда: только вручную кнопкой ▶.';
            finQ(); return;
          }
          const dup = AX.dupAge(cmd, panelRunner());
          if (dup > 0) {
            AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=duplicate age=' + dup + 's\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n');
            stopAutoTimer('⏭ Дубль: такая команда уже выполнялась ' + dup + 'с назад — пропуск (жми ▶ для повтора).');
            finQ(); return;
          }
          if (!bypassChecks) {
            const hist = AX.historyAge(cmd, panelRunner());
            if (hist > 0) {
              AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=already-executed age=' + hist + 's\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n');
              stopAutoTimer('⏭ Уже выполнялась раньше (' + AX.fmtAge(hist) + ' назад) — пропуск (жми ▶ для повтора).');
              finQ(); return;
            }
            if (!flags.forced && Date.now() - AX.AX_BOOT < AX.BOOT_GRACE_MS && createdCmd && cmd === createdCmd) {
              AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=old-block (был на странице при загрузке)\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n');
              stopAutoTimer('⏭ Блок уже был на странице при загрузке — автозапуск пропущен (жми ▶).');
              finQ(); return;
            }
          }
          refreshPreview(cmd);
          AX.lastAutoCommands.push(cmd);
          if (AX.lastAutoCommands.length > 5) AX.lastAutoCommands.shift();
          if (AX.lastAutoCommands.length >= 3 && AX.lastAutoCommands.slice(-3).every((c) => c === cmd)) {
            AX.loopBlocked = true;
            AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=loop-guard (одна команда 3 раза подряд)\n');
            stopAutoTimer('🛑 Одна и та же команда 3 раза подряд — автопилот остановлен, дальше вручную.');
            AX.toast('🛑 Похоже на зацикливание ИИ — автопилот выключен');
            finQ(); return;
          }
          const d = +AX.settings.autoDelay;
          const left0 = (Number.isFinite(d) ? Math.max(0, Math.min(30, d)) : 3);
          const fireAt = Date.now() + left0 * 1000;
          const tick = () => {
            const rem = Math.max(0, Math.ceil((fireAt - Date.now()) / 1000));
            status.textContent = '🤖 Автозапуск через ' + rem + 'с… (✋ Отмена авто — остановить)';
          };
          const fire = () => {
            AX.autoRunCount++;
            AX.markAutoRun(cmd, panelRunner());
            const cb = panel.$('.ax-btn-cancel-auto');
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

    panel.$('.ax-btn-insert').onclick = () => {
      const forChat = lastChatFormatted || lastFormatted;
      try { AX.insertIntoChat('\n```text\n' + forChat + '\n```\n'); } catch (e) { /* ignore */ }
      AX.silentCopy(forChat);
    };
    panel.$('.ax-btn-copy-out').onclick = async () => {
      const ok = await AX.copyToClipboard(lastFormatted);
      AX.toast(ok ? 'Вывод скопирован' : 'Не удалось скопировать');
    };

    const autoHandle = {
      el: panel, started: false, done: false, claimed: false,
      finish() { this.done = true; },
      start() { startAuto(); },
      showQueued(i) { showQueued(i); },
      runNow(cb) { runAutoNow(cb); },
      /* Возобновление автопилота. Раньше `done` не сбрасывался, поэтому
       * startAuto() выходил на первой строке и повторный запуск (включение
       * автопилота после выполнения, повторный рендер блока) не работал. */
      retry() {
        if (this.done) {
          const wasQueued = AX.autoQueue.indexOf(this) !== -1 || AX.currentAuto === this;
          if (wasQueued) AX.dequeueAuto(this);
          this.done = false;
        }
        this.claimed = false;
        this.started = false;
        autoCancelled = false;
        this.start();
      },
    };
    AX.livePanels.push(autoHandle);
    panel._axStart = () => { try { autoHandle.start(); } catch (e) { console.warn('[AX] autostart:', e); } };

    // Быстрое включение автопилота с панели
    (function addQuickAuto() {
      const needExec = !AX.settings.autoExecute || (flags.weak && !AX.settings.autoWeak);
      if (!needExec || autoHandle.done) return;
      const q = document.createElement('button');
      q.className = 'ax-btn ax-btn-copy ax-btn-quickauto';
      AX.setBtnLabel(q, 'robot', 'Включить авто');
      q.title = 'Включить полный автопилот (выполнение + вставка + отправка) и сохранить в настройках';
      q.onclick = async (e) => {
        // Включение автопилота = разрешение на неавтоматические запуски,
        // поэтому только настоящее действие пользователя.
        if (!trustedClick(e)) return;
        try {
          if (!AX.ctxAlive()) { AX.handleDeadContext(); return; }
          const patch = { autoExecute: true, autoInsert: true, autoSend: true };
          if (flags.weak) patch.autoWeak = true;
          const b = typeof browser !== 'undefined' ? browser : chrome;
          await (b.storage.sync.set ? b.storage.sync.set(patch) : new Promise((res) => chrome.storage.sync.set(patch, res)));
          Object.assign(AX.settings, patch);
          const note = Array.prototype.slice.call(panel.$$('.ax-exec-header div'))
            .filter((el) => el.tagName === 'DIV')[0];
          if (note && flags.weak) note.textContent = '🔍 находка нестрогая (EXECUTE?) — автозапуск разрешён';
          AX.toast('🤖 Автопилот включён полностью (выполнение + вставка + отправка)');
          q.remove();
          AX.loopBlocked = false;
          AX.lastAutoCommands = [];
          autoHandle.started = false;
          autoCancelled = false;
          forceAutoOnce = true;
          startAuto();
        } catch (e) { AX.toast('Не удалось сохранить настройку'); }
      };
      panel.$('.ax-exec-header').appendChild(q);
    })();

    return panel;
  };

  console.log('[AX] panel loaded');
})();
