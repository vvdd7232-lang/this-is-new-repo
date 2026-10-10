/* AI Execute Runner — content.js (main orchestrator)
 * Точка входа content-script'а. Здесь только: защита от двойной загрузки,
 * сканирование страницы, observer, диагностика, индикатор сервера.
 * Вся логика разложена по модулям:
 *   ax-detector.js — чистые функции детекции (тестируются в Node)
 *   ax-core.js     — namespace AX, утилиты, поле ввода, форматирование, storage
 *   ax-view.js     — вставка картинок (view) + превью
 *   ax-panel.js    — панель под блоком, подтверждение, автопилот
 * Файлы подключаются через manifest.json ДО content.js.
 */
(() => {
  'use strict';

  if (window.__axLoaded && window.__axAlive && window.__axAlive()) return;
  window.__axLoaded = true;
  window.__axAlive = () => AX.ctxAlive();

  const AX = window.AX;
  const D = window.AXDetector;
  if (!AX || !D) {
    console.error('[AX] модули не загружены. Проверь порядок скриптов в manifest.json');
    return;
  }

  // ---------- сканирование страницы ----------
  function scan(root, force) {
    root = root || document;
    force = !!force;
    const pres = [];
    if (root && root.tagName === 'PRE') pres.push(root);
    else if (root && root.querySelectorAll) pres.push(...root.querySelectorAll('pre'));
    for (let i = AX.livePanels.length - 1; i >= 0; i--) {
      if (AX.livePanels[i].el && !AX.livePanels[i].el.isConnected) AX.livePanels.splice(i, 1);
    }
    const now = Date.now();
    for (const pre of pres) {
      if (pre.dataset.axDone) continue;
      if (!force && pre.dataset.axChecked && now - (+pre.dataset.axChecked) < 3000) continue;
      pre.dataset.axChecked = String(now);
      let info = D.detectRunner(pre);
      let weak = false;
      if (!info && AX.settings.looseSearch !== false) {
        const fb = D.detectFallback(pre, AX.settings);
        if (fb) {
          info = { lang: 'execute', runner: fb.runner };
          weak = !fb.strong;
        }
      }
      if (!info) continue;
      const command = D.getCodeText(pre);
      if (!weak && info.runner === 'shell') {
        const sniffed = D.sniffRunner(command);
        if (sniffed) info = { lang: info.lang, runner: sniffed };
      }
      try {
        // Повторный рендер чата создаёт НОВЫЙ <pre> под тот же блок — старая
        // панель оставалась в DOM навсегда. Убираем осиротевшую перед вставкой.
        const stale = pre.nextElementSibling;
        if (stale && stale.classList && stale.classList.contains('ax-exec-panel')) {
          stale.remove();
        }
        const panel = AX.buildPanel(pre, info, command, { weak, forced: force });
        pre.insertAdjacentElement('afterend', panel);
        pre.dataset.axDone = '1';
        if (AX.settings.autoExecute) panel._axStart();
        if (!AX.foundToastShown) {
          AX.foundToastShown = true;
          AX.toast(AX.settings.autoExecute ? '⚡ execute-блок найден, автозапуск включён' : '⚡ execute-блок найден — кнопка ▶ под кодом');
        }
      } catch (e) { /* ignore */ }
    }
  }
  AX.scan = scan;

  // ---------- диагностика ----------
  function debugBlocks(verbose) {
    const pres = [...document.querySelectorAll('pre')];
    const rows = pres.map((pre, i) => {
      const info = D.detectRunner(pre);
      const code = pre.querySelector('code');
      return {
        '#': i,
        verdict: info ? (info.lang + ' → ' + info.runner) : '—',
        codeClass: code ? String(code.className || '').slice(0, 70) : '(no <code>)',
        preClass: String(pre.className || '').slice(0, 70),
        dataLang: (code && (code.dataset.language || code.dataset.lang)) || pre.dataset.language || pre.dataset.lang || '',
        neighbor: pre.previousElementSibling ? String(pre.previousElementSibling.textContent || '').trim().slice(0, 50) : '',
      };
    });
    const found = rows.filter((r) => r.verdict !== '—').length;
    console.log('%c[AX debug]%c <pre>: ' + pres.length + ', execute: ' + found + ' — пришлите это, если кнопки нет',
      'font-weight:bold;color:#7c5cff', 'color:inherit');
    if (rows.length) console.table(rows);
    else console.log('[AX debug] на странице вообще нет <pre> — ответ ещё генерируется или это не страница чата');
    if (verbose) AX.toast('AX: блоков кода: ' + pres.length + ', execute: ' + found + ' (детали — консоль F12)');
    return { total: pres.length, execute: found };
  }
  window.AX_debug = () => debugBlocks(true);
  window.AX_rescan = () => { scan(document, true); AX.toast('AX: страница пересканирована'); };

  // ---------- индикатор сервера ----------
  function ensureDot() {
    if (document.getElementById('ax-server-dot')) return;
    const dot = document.createElement('div');
    dot.id = 'ax-server-dot';
    dot.textContent = '⚡ exec: …';
    dot.title = 'AI Execute Runner: клик — проверить сервер, двойной клик — диагностика блоков';
    dot.onclick = checkServer;
    dot.ondblclick = (e) => { e.preventDefault(); debugBlocks(true); };
    (document.body || document.documentElement).appendChild(dot);
  }

  let pingFails = 0;
  let oldSrvWarned = false;
  function checkServer() {
    if (document.hidden) return;
    if (!document.getElementById('ax-server-dot')) { try { ensureDot(); } catch (e) { /* ignore */ } }
    const dot = document.getElementById('ax-server-dot');
    if (dot && dot.className !== 'ax-online') dot.textContent = '⚡ exec: …';
    AX.safeSend({ type: 'AX_PING' }, (resp) => {
      const d = document.getElementById('ax-server-dot');
      if (!d) return;
      if (resp && resp.ok) {
        pingFails = 0;
        d.className = 'ax-online';
        d.textContent = '⚡ exec: online';
        d.title = 'Сервер на связи: ' + JSON.stringify(resp.info);
        if (resp.info && !resp.info.version && !oldSrvWarned) {
          oldSrvWarned = true;
          AX.toast('⚠️ server.py старый (не сообщает версию) — обнови файл, иначе часть функций не будет работать');
        }
      } else {
        pingFails++;
        if (pingFails < 2) return;
        d.className = 'ax-offline';
        d.textContent = '⚡ exec: offline';
        d.title = 'Сервер недоступен: ' + ((resp && resp.error) || 'нет ответа') + '. Запустите server.py';
      }
    });
  }

  // ---------- observer ----------
  // Дешёвая проверка перед сканом: на каждый токен стрима приходит
  // characterData-мутация, и раньше мы каждый раз гоняли querySelectorAll('pre')
  // + полный detectRunner по всему поддереву. Если блок уже распознан и панель
  // построена (pre.dataset.axDone), пересканировать нечего.
  function needsScan(root) {
    if (!root) return false;
    if (root.tagName === 'PRE') return !root.dataset.axDone;
    if (!root.querySelectorAll) return false;
    const pres = root.querySelectorAll('pre');
    for (const pre of pres) if (!pre.dataset.axDone) return true;
    return false;
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') {
        const el = m.target.parentElement;
        if (!el) continue;
        const pre = el.closest('pre');
        if (pre) { if (!pre.dataset.axDone) scan(pre.parentElement || document); continue; }
        if (needsScan(el)) scan(el);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList && node.classList.contains('ax-exec-panel')) continue;
        const root = node.tagName === 'PRE' ? (node.parentElement || document) : node;
        if (needsScan(root)) scan(root);
      }
    }
  });
  AX.observer = observer;

  // ---------- init ----------
  function applyPendingAuto() {
    if (!AX.settings.autoExecute) return;
    for (let i = AX.livePanels.length - 1; i >= 0; i--) {
      const h = AX.livePanels[i];
      if (h.el && !h.el.isConnected) { AX.livePanels.splice(i, 1); continue; }
      // Трогаем только «свежие» панели, которые ещё ни разу не стартовали.
      // Раньше retry() вызывался для ВСЕХ живых панелей, включая уже
      // выполненные: смена настройки могла перезапустить давно отработавшую
      // команду (дедуп по сессии historyAge возвращает 0, а окно dupAge — 60с).
      if (h.done || h.started || h.claimed) continue;
      try { h.retry(); } catch (e) { /* ignore */ }
    }
  }
  AX.applyPendingAuto = applyPendingAuto;

  // Настройки внешнего вида (палитра, кото-тема и т.п.) приходят из storage
  // асинхронно — панель могла построиться раньше. Перекрашиваем уже созданные
  // панели, когда настройки доехали или изменились на лету.
  const APPEARANCE_KEYS = ['uiTheme', 'uiPalette', 'uiRadius', 'uiBtnStyle', 'uiDensity', 'catMode', 'panelSize'];
  function applyAppearanceToPanels() {
    for (let i = AX.livePanels.length - 1; i >= 0; i--) {
      const h = AX.livePanels[i];
      if (h.el && !h.el.isConnected) { AX.livePanels.splice(i, 1); continue; }
      try { if (h.el) AX.applyPanelAppearance(h.el); } catch (e) { /* ignore */ }
    }
  }

  function init() {
    console.log('[AX] AI Execute Runner загружен на ' + location.hostname);
    window.__axDiag = function () {
      const found = AX.findChatInputDetailed();
      return {
        input: AX.describeChatInput(found),
        shadowRoots: AX.collectShadowRoots().length,
        fileInputs: AX.deepQueryAll('input[type="file"]', AX.collectShadowRoots()).length,
        clipboardApi: !!(navigator.clipboard && navigator.clipboard.write),
        clipboardItem: !!window.ClipboardItem,
        execInsertImage: (function () { try { return !!document.queryCommandSupported('insertImage'); } catch (e) { return false; } })(),
      };
    };
    window.__axDiag.retryView = function () { return AX.getLastViewData() ? AX.insertImageIntoChat(AX.getLastViewData()) : Promise.resolve(false); };
    window.__axDiag.insertView = function (view) { return AX.insertImageIntoChat(view); };
    window.__axDiag.sampleView = function (dataUrl, mime) {
      return { data_url: dataUrl, mime: mime || 'image/png', size: 0, path: 'sample.png' };
    };

    AX.loadStorageState();
    AX.initSettings((changes) => {
      // изменения настроек — обновляем панели
      if (!changes) { applyAppearanceToPanels(); applyPendingAuto(); return; }
      if (APPEARANCE_KEYS.some((k) => k in changes)) applyAppearanceToPanels();
      if ((changes.autoExecute && changes.autoExecute.newValue === true) ||
          (changes.autoWeak && changes.autoWeak.newValue === true) ||
          (changes.maxAutoRuns && (changes.maxAutoRuns.newValue || 0) !== (changes.maxAutoRuns.oldValue || 0))) applyPendingAuto();
    });

    // контекстное меню: "Выполнить выделенное локально"
    try {
      (typeof browser !== 'undefined' ? browser : chrome).runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'AX_RUN_SELECTION') AX.runArbitrary(msg.text, AX.settings.defaultRunner || 'shell');
      });
    } catch (e) { /* ignore */ }

    scan(document);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    ensureDot();
    checkServer();
    AX.serverTimer = setInterval(checkServer, 30000);
    AX.scanTimer = setInterval(() => { try { scan(document); } catch (e) { /* ignore */ } }, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkServer(); });
    setTimeout(() => scan(document), 1500);
    setTimeout(() => scan(document), 4000);
    setTimeout(() => scan(document), 9000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
