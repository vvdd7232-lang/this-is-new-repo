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
  mcpEnabled: false,            // MCP (экспериментально): показывать инструменты MCP-серверов
  uiPalette: 'indigo',          // внешний вид: indigo | ocean | emerald | sunset
  uiRadius: 'soft',             // скругление: none | sharp | soft | round | pill
  uiBtnStyle: 'soft',           // кнопки: soft | solid | outline | flat | tile
  uiDensity: 'normal',          // плотность: compact | normal | spacious
  catMode: false,               // кото-тема: ушки на кнопках, лапки у панели, хвостик у модалок
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
  // authToken ЗДЕСЬ НЕ ОТДАЁТСЯ. Раньше он уходил в content-script, то есть
  // лежал в памяти на каждой из 20+ страниц чата. Страница его не прочитает
  // (content-script в изолированном мире), но секрету не место там, где он
  // не нужен: маскирование команд делает сам background (см. maskCmd).
  return { ...DEFAULTS, ...s, authToken: '' };
}

// Маскирует токен в тексте команды/вывода. Живёт в background, потому что
// только он знает секрет — благодаря этому токен вообще не покидает его.
function maskCmd(text, token) {
  let out = String(text == null ? '' : text);
  if (token) {
    while (out.includes(token)) out = out.split(token).join('«скрыто»');
  }
  return out;
}

// Нормализация адреса сервера: без схемы добавляем http://, режем хвостовые слеши.
function normUrl(u) {
  u = (u || '').trim().replace(/\/+$/, '');
  if (u && !/^[a-z]+:\/\//i.test(u)) u = 'http://' + u;
  return u || DEFAULTS.serverUrl;
}

// Zero-touch токен: расширение само забирает актуальный токен с локального
// сервера (GET /ax-token). Сервер отдаёт его только запросам, прошедшим
// проверку Origin/Host (_allowed): чужие сайты и DNS-rebinding отсекаются,
// локальный клиент — нет. Это лечит 401 после перезапуска сервера: раньше
// токен генерировался заново и сохранённое значение протухало.
async function fetchTokenFromServer(serverUrl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(normUrl(serverUrl) + '/ax-token', { signal: ctrl.signal });
    if (!res.ok) return '';
    const data = await res.json().catch(() => ({}));
    const token = data && typeof data.token === 'string' ? data.token : '';
    if (token) {
      await axStorageSet('local', { authToken: token });
      try { await axStorageRemove('sync', ['authToken']); } catch (e) { /* ignore */ }
    }
    return token;
  } catch (e) {
    return '';  // сервер офлайн/старая версия без /ax-token — не мешаем основному пути
  } finally {
    clearTimeout(t);
  }
}

// fetch к серверу с токеном и однократным авто-повтором при 401: сначала
// подставляем сохранённый токен; если сервер его отверг (например, перезапуск
// сменил токен), подтягиваем актуальный через /ax-token и повторяем запрос.
async function authFetch(base, path, init) {
  const url = base + path;
  const token = await getAuthToken();
  const withToken = (tk) => {
    const headers = Object.assign({}, (init && init.headers) || {});
    if (tk) headers['X-Auth-Token'] = tk; else delete headers['X-Auth-Token'];
    return Object.assign({}, init, { headers });
  };
  let res = await fetch(url, withToken(token));
  if (res.status === 401) {
    const fresh = await fetchTokenFromServer(base);
    if (fresh && fresh !== token) res = await fetch(url, withToken(fresh));
  }
  return res;
}

// Одноразовая миграция: старые установки держали токен в storage.sync,
// который уезжает в облако вендора. Раньше миграцию запускал getSettings(),
// но токен оттуда убрали — поэтому переезд теперь делаем явно на старте
// service worker. Неблокирующе: ответ не ждёт.
getAuthToken();

async function pingServer(serverUrl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    // Токен здесь нужен, чтобы сервер честно вернул auth_ok: без заголовка
    // /ping всегда отвечает auth_ok=false, и попап зря писал «токен не принят».
    const res = await authFetch(normUrl(serverUrl), '/ping', { signal: ctrl.signal });
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
    // Токен и его автомиграция — в authFetch: он же повторит запрос с
    // актуальным токеном, если сервер ответил 401 (например, после рестарта).
    const res = await authFetch(base, '/run', {
      method: 'POST',
      headers,
      body: JSON.stringify({ command, runner, timeout: timeout || s.timeout, cwd }),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    // blocked=true (whitelist) - это НЕ ошибка транспорта, пропускаем дальше,
    // чтобы content.js мог показать статус blocked вместо error
    if (!res.ok && !data.blocked) throw new Error(data.error || ('HTTP ' + res.status));
    return maskResult(data, command, await getAuthToken());
  } finally {
    clearTimeout(t);
  }
}

// Маскирует токен в команде и выводе до того, как они попадут в content-script:
// журнал, чат и экспорт в .md берут именно эти строки.
function maskResult(data, command, token) {
  if (!data || typeof data !== 'object') return data;
  const out = {};
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (typeof v === 'string' && v.indexOf('«скрыто»') === -1) out[k] = maskCmd(v, token);
    else out[k] = v;
  }
  if (typeof out.stdout === 'string' || typeof out.stderr === 'string') {
    out.stdout = maskCmd(out.stdout, token);
    out.stderr = maskCmd(out.stderr, token);
  }
  if (command && typeof out.command !== 'string') out.command = maskCmd(command, token);
  return out;
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
    const res = await authFetch(base, path, {
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
    const res = await authFetch(base, '/mcp/servers', { signal: ctrl.signal });
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
  const token = await getAuthToken();
  const data = await serverRequest('/mcp/call', {
    method: 'POST',
    body: { server, tool, arguments: args || {} },
    timeout
  });
  // Ответ инструмента — это тоже пользовательские данные: в нём может
  // оказаться токен (например, инструмент читает файл с настройками).
  return maskResult(data, '', token);
}

// Отчёт по инструментам для ИИ. Файл на рабочий стол пишет сервер — он
// единственный, кто умеет ходить на диск, а не в браузер.
async function mcpReport(save) {
  const data = await serverRequest('/mcp/report', { method: 'POST', body: { save: !!save }, timeout: 120 });
  return maskResult(data, '', await getAuthToken());
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
        const url = msg.serverUrl || s.serverUrl;
        let info = await pingServer(url);
        // Сервер требует токен, а наш не подошёл — подтягиваем актуальный
        // (zero-touch) и проверяем связь ещё раз, чтобы попап не пугал «401».
        if (info && info.auth_required && info.auth_ok === false) {
          const got = await fetchTokenFromServer(url);
          if (got) info = await pingServer(url);
        }
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
      } else if (msg.type === 'AX_MCP_REPORT') {
        sendResponse({ ok: true, result: await mcpReport(!!(msg.payload && msg.payload.save)) });
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
