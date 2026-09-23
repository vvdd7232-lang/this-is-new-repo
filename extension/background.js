// AI Execute Runner — background service worker (MV3)
// Мост между content-script и локальным сервером http://127.0.0.1:8765

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8765',
  timeout: 30,          // секунд, дефолтный таймаут выполнения
  requireConfirm: true, // ВСЕГДА спрашивать подтверждение перед выполнением
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
  defaultCwd: ''                // рабочая папка для команд (пусто = папка сервера)
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
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
    const res = await fetch(base + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, runner, timeout: timeout || s.timeout, cwd }),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
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
    chrome.contextMenus.removeAll(() => {
      try {
        chrome.contextMenus.create({
          id: 'ax-run-selection',
          title: '⚡ Выполнить выделенное локально',
          contexts: ['selection']
        });
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
}
chrome.runtime.onInstalled.addListener(axCreateMenu);
chrome.runtime.onStartup.addListener(axCreateMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info || info.menuItemId !== 'ax-run-selection' || !tab || tab.id == null) return;
  const text = (info.selectionText || '').trim();
  if (!text) return;
  const payload = { type: 'AX_RUN_SELECTION', text };
  try {
    const pr = chrome.tabs.sendMessage(tab.id, payload);
    if (pr && pr.catch) pr.catch(() => axInjectAndRetry(tab.id, payload));
  } catch (e) {
    axInjectAndRetry(tab.id, payload);
  }
});

// Если content-script ещё не внедрён (вкладка открыта до установки) — внедряем и повторяем
function axInjectAndRetry(tabId, payload) {
  try {
    try {
      const cssPr = chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      if (cssPr && cssPr.catch) cssPr.catch(() => {});
    } catch (e) { /* ignore */ }
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).then(() => {
      setTimeout(() => {
        try {
          const pr = chrome.tabs.sendMessage(tabId, payload);
          if (pr && pr.catch) pr.catch(() => {});
        } catch (e) { /* ignore */ }
      }, 600);
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}
