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
  authToken: '',                // токен доступа (если задан --token на сервере)
  uiTheme: 'auto',              // auto | light | dark (влияет на панели и options)
  panelSize: 'normal',          // compact | normal | large
  collapseAfterRun: false,      // сворачивать вывод после выполнения
  soundOnComplete: false,       // звук при завершении
  browserNotify: false,         // browser notification если вкладка не в фокусе
  echoMode: 'short',            // эхо-репликация команды в чат: full | short | none
  previewLines: 12,             // строк команды в развёрнутом предпросмотре (0 = все)
  paletteEnabled: true,         // палитра команд по Ctrl+Shift+E
  noisyCollapse: true,          // сворачивать длинные листинги в выводе
  mcpEnabled: false             // MCP (экспериментально): показывать инструменты MCP-серверов
};

const axApi = typeof browser !== 'undefined' ? browser : chrome;

// --- storage-обёртки (promise для Firefox, callback для Chrome) ---
function axStorageGet(area, keys) {
  const b = axApi;
  if (typeof browser !== 'undefined' && browser.storage && browser.storage[area]) {
    return browser.storage[area].get(keys);
  }
  return new Promise((resolve) => {
    b.storage[area].get(keys, (res) => resolve(res || {}));
  });
}

function axStorageSet(area, items) {
  const b = axApi;
  if (typeof browser !== 'undefined' && browser.storage && browser.storage[area]) {
    return browser.storage[area].set(items);
  }
  return new Promise((resolve) => {
    b.storage[area].set(items, () => resolve());
  });
}

function axStorageRemove(area, keys) {
  const b = axApi;
  if (typeof browser !== 'undefined' && browser.storage && browser.storage[area]) {
    return browser.storage[area].remove(keys);
  }
  return new Promise((resolve) => {
    b.storage[area].remove(keys, () => resolve());
  });
}

/* Токен доступа НЕ храним в storage.sync: sync уезжает в облако вендора
 * (Chrome Sync / Firefox Sync аккаунт), а токен — секрет локального сервера.
 * Читаем из local; один раз мигрируем старое значение из sync и удаляем его. */
async function getAuthToken() {
  try {
    const local = await axStorageGet('local', ['authToken']);
    if (local && typeof local.authToken === 'string' && local.authToken) return local.authToken;
    const old = await axStorageGet('sync', ['authToken']);
    const legacy = old && typeof old.authToken === 'string' ? old.authToken : '';
    if (legacy) {
      await axStorageSet('local', { authToken: legacy });
      await axStorageRemove('sync', ['authToken']);
      return legacy;
    }
  } catch (e) { /* ignore: без токена сервер вернёт 401 — это видно пользователю */ }
  return '';
}

async function getSettings() {
  const s = await axStorageGet('sync', Object.keys(DEFAULTS));
  const merged = { ...DEFAULTS, ...s, authToken: '' };
  merged.authToken = await getAuthToken();
  return merged;
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

// --- MCP (экспериментально) --------------------------------------------------
// Прямо из content-script ходить на сервер нельзя: токен лежит в local-хранилище,
// а CORS/Origin-проверка сервера ждёт chrome-extension://. Поэтому все MCP-запросы
// идут через background — он же единственный, кто знает токен.

// Общий помощник для запросов к серверу с токеном и таймаутом.
async function serverRequest(path, { method = 'GET', body, timeout } = {}) {
  const s = await getSettings();
  const base = normUrl(s.serverUrl);
  const ctrl = new AbortController();
  const limit = (timeout || s.timeout || 30) + 8;
  const t = setTimeout(() => ctrl.abort(), limit * 1000);
  try {
    const headers = {};
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (s.authToken) headers['X-Auth-Token'] = s.authToken;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  } finally {
    clearTimeout(t);
  }
}

// Статус MCP: включён ли сервер, какие серверы настроены и с какими ошибками.
async function mcpStatus() {
  const s = await getSettings();
  const base = normUrl(s.serverUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const headers = {};
    if (s.authToken) headers['X-Auth-Token'] = s.authToken;
    const res = await fetch(base + '/mcp/servers', { headers, signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { reachable: true, enabled: false, servers: [], error: data.error || ('HTTP ' + res.status) };
    return { reachable: true, enabled: !!data.enabled, servers: data.servers || [], config: data.config || '', configError: data.config_error || '' };
  } catch (e) {
    // Сервер не отвечает — это не поломка MCP, а обычный офлайн: UI должен
    // показать «сервер недоступен», а не пугать ошибкой.
    return { reachable: false, enabled: false, servers: [], error: e && e.name === 'AbortError' ? 'сервер не ответил' : String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

// Список инструментов всех включённых MCP-серверов.
async function mcpListTools() {
  const data = await serverRequest('/mcp/tools', { method: 'POST', body: {} });
  return data;
}

// Вызов инструмента MCP.
async function mcpCallTool({ server, tool, args, timeout }) {
  return await serverRequest('/mcp/call', {
    method: 'POST',
    body: { server, tool, arguments: args || {} },
    timeout
  });
}

// Перечитывание конфига MCP без перезапуска сервера.
async function mcpReload() {
  const data = await serverRequest('/mcp/reload', { method: 'POST', body: {} });
  return data;
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
      } else if (msg.type === 'AX_MCP_STATUS') {
        sendResponse({ ok: true, status: await mcpStatus() });
      } else if (msg.type === 'AX_MCP_TOOLS') {
        sendResponse({ ok: true, result: await mcpListTools() });
      } else if (msg.type === 'AX_MCP_CALL') {
        sendResponse({ ok: true, result: await mcpCallTool(msg.payload || {}) });
      } else if (msg.type === 'AX_MCP_RELOAD') {
        sendResponse({ ok: true, result: await mcpReload() });
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
// Порядок файлов важен: детектор -> ядро -> view -> panel -> палитра -> main.
const AX_CONTENT_FILES = ['ax-detector.js', 'ax-core.js', 'ax-view.js', 'ax-panel.js', 'ax-palette.js', 'content.js'];
function axInjectAndRetry(tabId, payload) {
  try {
    const b = typeof browser !== 'undefined' ? browser : chrome;
    try {
      const cssPr = b.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      if (cssPr && cssPr.catch) cssPr.catch(() => {});
    } catch (e) { /* ignore */ }
    const scrPr = b.scripting.executeScript({ target: { tabId }, files: AX_CONTENT_FILES });
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
