// AI Execute Runner — background service worker (MV3)
// Мост между content-script и локальным сервером http://127.0.0.1:8765

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8765',
  timeout: 30,          // секунд, дефолтный таймаут выполнения
  requireConfirm: true, // спрашивать подтверждение перед ручным запуском (можно отключить в настройках)
  maxOutputChars: 32000, // сколько символов вывода показывать/вставлять (0 = без лимита)
  autoExecute: false,   // автопилот: автовыполнение execute-блоков
  autoInsert: false,    // автопилот: автовставка вывода в чат
  autoSend: false,      // автопилот: автоотправка результата ИИ
  autoDelay: 3,         // задержка перед автозапуском (окно отмены), сек
  looseSearch: true,    // нестрогий поиск блоков по слову execute рядом
  autoWeak: false,  // автозапуск нестрого найденных блоков (EXECUTE?)
  maxAutoRuns: 0,  // лимит автозапусков на вкладку (0 = без лимита)
  defaultRunner: 'shell',      // среда по умолчанию (выделенный текст, EXECUTE?)
  showToasts: true,           // всплывающие уведомления-тосты
  defaultCwd: '',               // рабочая папка для команд (пусто = папка сервера)
  authToken: ''                 // токен доступа (если задан --token на сервере)
};

const axApi = typeof browser !== 'undefined' ? browser : chrome;

async function getSettings() {
  if (typeof browser !== 'undefined' && browser.storage && browser.storage.sync) {
    const stored = await browser.storage.sync.get(Object.keys(DEFAULTS));
    return { ...DEFAULTS, ...stored };
  }
  return new Promise((resolve) => {
    chrome.storage.sync.get(Object.keys(DEFAULTS), (stored) => {
      resolve({ ...DEFAULTS, ...stored });
    });
  });
}

// Нормализация адреса сервера: без схемы добавляем http://, режем хвостовые слеши.
function normUrl(u) {
  u = (u || '').trim().replace(/\/+$/, '');
  if (u && !/^[a-z]+:\/\//i.test(u)) u = 'http://' + u;
  return u || DEFAULTS.serverUrl;
}

async function pingServer(serverUrl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(normUrl(serverUrl) + '/ping', { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function runCommand({ command, runner, timeout, cwd }) {
  const s = await getSettings();
  const base = normUrl(s.serverUrl);
  const ctrl = new AbortController();
  // таймаут запроса = таймаут команды + 8 сек запаса
  const t = setTimeout(() => ctrl.abort(), ((timeout || s.timeout || 30) + 8) * 1000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (s.authToken) headers['X-Auth-Token'] = s.authToken;
    const res = await fetch(base + '/run', {
      method: 'POST',
      headers,
      body: JSON.stringify({ command, runner, timeout: timeout || s.timeout, cwd }),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    // blocked=true (whitelist) - это НЕ ошибка транспорта, пропускаем дальше,
    // чтобы content.js мог показать статус blocked вместо error
    if (!res.ok && !data.blocked) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  } finally {
    clearTimeout(t);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'AX_GET_SETTINGS') {
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (msg.type === 'AX_PING') {
        const s = await getSettings();
        const info = await pingServer(msg.serverUrl || s.serverUrl);
        sendResponse({ ok: true, info });
      } else if (msg.type === 'AX_RUN') {
        const data = await runCommand(msg.payload || {});
        sendResponse({ ok: true, result: data });
      } else {
        sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
      }
    } catch (e) {
      let errText = String((e && e.message) || e);
      // Fetch-abort по таймауту даёт техническое "signal is aborted without reason" —
      // показываем человеческий текст вместо него.
      if (e && e.name === 'AbortError') errText = 'превышено время ожидания ответа от сервера (возможно, сервер занят долгой командой)';
      sendResponse({ ok: false, error: errText });
    }
  })();
  return true; // async response
});

// --- Контекстное меню: выполнить выделенный текст (запасной путь) ---
function axCreateMenu() {
  try {
    const b = typeof browser !== 'undefined' ? browser : chrome;
    const create = () => {
      try {
        b.contextMenus.create({
          id: 'ax-run-selection',
          title: '⚡ Выполнить выделенное локально',
          contexts: ['selection']
        }, () => {
          if (b.runtime && b.runtime.lastError) { /* ignore */ }
        });
      } catch {}
    };
    if (typeof browser !== 'undefined' && b.contextMenus && b.contextMenus.removeAll) {
      const p = b.contextMenus.removeAll();
      if (p && p.then) p.then(create).catch(create);
      else create();
    } else if (chrome.contextMenus && chrome.contextMenus.removeAll) {
      chrome.contextMenus.removeAll(() => create());
    } else {
      create();
    }
  } catch {}
}

const bRuntime = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime : chrome.runtime;
bRuntime.onInstalled.addListener(axCreateMenu);
bRuntime.onStartup.addListener(axCreateMenu);

const bMenus = (typeof browser !== 'undefined' && browser.contextMenus) ? browser.contextMenus : chrome.contextMenus;
bMenus.onClicked.addListener((info, tab) => {
  if (!info || info.menuItemId !== 'ax-run-selection' || !tab || tab.id == null) return;
  const text = (info.selectionText || '').trim();
  if (!text) return;
  const payload = { type: 'AX_RUN_SELECTION', text };
  const b = typeof browser !== 'undefined' ? browser : chrome;
  try {
    const pr = b.tabs.sendMessage(tab.id, payload);
    if (pr && pr.catch) pr.catch(() => axInjectAndRetry(tab.id, payload));
  } catch (e) {
    axInjectAndRetry(tab.id, payload);
  }
});

// Если content-script ещё не внедрён (вкладка открыта до установки) — внедряем и повторяем
function axInjectAndRetry(tabId, payload) {
  try {
    const b = typeof browser !== 'undefined' ? browser : chrome;
    try {
      const cssPr = b.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      if (cssPr && cssPr.catch) cssPr.catch(() => {});
    } catch (e) { /* ignore */ }
    const scrPr = b.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    if (scrPr && scrPr.then) {
      scrPr.then(() => {
        setTimeout(() => {
          try {
            const pr = b.tabs.sendMessage(tabId, payload);
            if (pr && pr.catch) pr.catch(() => {});
          } catch (e) { /* ignore */ }
        }, 600);
      }).catch(() => {});
    }
  } catch (e) { /* ignore */ }
}
