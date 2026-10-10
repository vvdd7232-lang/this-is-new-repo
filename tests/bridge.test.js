/* Тесты моста к серверу: background.js (fetch, токен, маршрутизация сообщений)
 * и popup.js (чтение/запись настроек, проверка связи).
 *
 * Зачем: background.js — путь, по которому реально выполняются команды, и до
 * сих пор он не был покрыт ни одним тестом. Ошибка здесь не видна на полигоне
 * и ломает всё сразу: команды не запускаются, в попапе «сервер недоступен».
 *
 * Запуск:  cd tests && npm test
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT_DIR = path.join(__dirname, '..', 'extension');
const read = (f) => fs.readFileSync(path.join(EXT_DIR, f), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else {
    failed++;
    failures.push(name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''));
    console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- окружение для background.js ----------
function makeBgEnv(opts) {
  opts = opts || {};
  const store = { sync: Object.assign({}, opts.sync || {}), local: Object.assign({}, opts.local || {}) };
  const calls = { fetch: [], set: [], remove: [], menus: [] };

  const area = (name) => ({
    get: (keys, cb) => {
      const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
      const out = {};
      for (const k of list) if (k in store[name]) out[k] = store[name][k];
      if (cb) { cb(out); return undefined; }
      return Promise.resolve(out);
    },
    set: (items, cb) => { Object.assign(store[name], items); calls.set.push({ area: name, items }); if (cb) cb(); return Promise.resolve(); },
    remove: (keys, cb) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[name][k];
      calls.remove.push({ area: name, keys });
      if (cb) cb();
      return Promise.resolve();
    },
  });

  let msgListener = null;
  // runScripts обязателен: без него w.eval — это Node-eval, и глобалы окна
  // (chrome, fetch) в скрипте не видны.
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://chatgpt.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.chrome = {
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener() {} } },
    runtime: {
      id: 'test',
      getManifest: () => ({ version: '2.6.1' }),
      getURL: (p) => 'chrome-extension://test/' + p,
      onMessage: { addListener: (fn) => { msgListener = fn; } },
      // Регистрируем создание меню: иначе axCreateMenu не вызовется и пункт
      // меню не появится (в бою его создаёт onInstalled/onStartup).
      onInstalled: { addListener: (fn) => { calls.onInstalled = fn; } },
      onStartup: { addListener() {} },
    },
    contextMenus: {
      create: (opts, cb) => { calls.menus.push(opts); if (cb) cb(); },
      removeAll: (cb) => { if (cb) cb(); },
      onClicked: { addListener() {} },
    },
    tabs: { sendMessage() { return Promise.resolve({}); } },
    scripting: { insertCSS: () => Promise.resolve(), executeScript: () => Promise.resolve() },
  };
  if (!w.AbortController) w.AbortController = AbortController;
  w.fetch = (url, init) => {
    calls.fetch.push({ url: String(url), init: init || {} });
    if (opts.fetchImpl) return opts.fetchImpl(String(url), init || {}, calls);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: 'ok', version: '2.6.1' }) });
  };

  w.eval(read('background.js'));
  // Событие установки — как при реальной установке расширения.
  try { if (calls.onInstalled) calls.onInstalled({}); } catch (e) { /* ignore */ }

  // Отправляем сообщение так же, как это делает content-script.
  const send = (msg) => new Promise((resolve) => {
    let settled = false;
    const keep = msgListener(msg, { id: 1 }, (resp) => { settled = true; resolve(resp); });
    if (keep === true) return;
    setTimeout(() => { if (!settled) resolve({ ok: false, error: 'no-response' }); }, 400);
  });

  return { w, store, calls, send };
}

// ---------- проверки popup.js ----------
function makePopupEnv(pingOk) {
  const dom = new JSDOM(read('popup.html'), {
    url: 'https://chrome-extension://test/popup.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const store = { sync: {}, local: {} };
  const area = (name) => ({
    get: (keys, cb) => {
      const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
      const out = {};
      for (const k of list) if (k in store[name]) out[k] = store[name][k];
      if (cb) { cb(out); return undefined; }
      return Promise.resolve(out);
    },
    set: (items, cb) => { Object.assign(store[name], items); if (cb) cb(); return Promise.resolve(); },
    remove: (keys, cb) => { if (cb) cb(); return Promise.resolve(); },
  });
  const sent = [];
  w.chrome = {
    storage: { sync: area('sync'), local: area('local') },
    runtime: {
      getManifest: () => ({ version: '2.6.1' }),
      sendMessage: (msg, cb) => {
        sent.push(msg);
        const resp = pingOk ? { ok: true, info: { status: 'ok', version: '2.6.1' } } : { ok: false, error: 'connection refused' };
        if (cb) { setTimeout(() => cb(resp), 0); return undefined; }
        return Promise.resolve(resp);
      },
    },
  };
  if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  for (const f of ['theme-boot.js', 'prompt.js', 'popup.js']) w.eval(read(f));
  return { w, store, sent };
}

async function runPopupChecks() {
  console.log('\n[9] popup: читает настройки и проверяет связь');
  const env = makePopupEnv(true);
  Object.assign(env.store.sync, {
    serverUrl: 'http://127.0.0.1:8765', timeout: 45, requireConfirm: false,
    autoExecute: true, autoInsert: true, autoSend: false, autoDelay: 5,
  });
  env.store.local.authToken = 'POPUP-TOK';
  await env.w.load();
  await sleep(200);
  const g = (id) => env.w.document.getElementById(id);
  check('адрес сервера в поле', g('serverUrl').value === 'http://127.0.0.1:8765', g('serverUrl').value);
  check('таймаут в поле', String(g('timeout').value) === '45', g('timeout').value);
  check('поля токена в попапе больше нет', !g('authToken'));
  check('токен остаётся в local (background его знает)', env.store.local.authToken === 'POPUP-TOK');
  check('«требовать подтверждение» снято', g('requireConfirm').checked === false);
  check('автовыполнение включено', g('autoExecute').checked === true);
  check('задержка автозапуска', String(g('autoDelay').value) === '5', g('autoDelay').value);
  check('проверка связи выполнена', env.sent.some((m) => m.type === 'AX_PING'), env.sent.map((m) => m.type));
  check('статус «на связи»', /связи/i.test(g('status').textContent), g('status').textContent);
  check('версия показана', /2\.6\.1/.test(g('ver').textContent), g('ver').textContent);

  console.log('\n[10] popup: сохранение и недоступный сервер');
  g('timeout').value = '120';
  g('requireConfirm').checked = true;
  // save — анонимный обработчик на кнопке, глобальной функции нет: жмём кнопку.
  g('save').click();
  await sleep(200);
  check('таймаут записан в sync', Number(env.store.sync.timeout) === 120, env.store.sync.timeout);
  check('подтверждение записано в sync', env.store.sync.requireConfirm === true, env.store.sync.requireConfirm);

  const down = makePopupEnv(false);
  await down.w.load();
  await sleep(200);
  const st = down.w.document.getElementById('status');
  check('недоступный сервер показан понятно', /[Нн]едоступен/.test(st.textContent), st.textContent);
  check('статус помечен как ошибка', /err/.test(st.className), st.className);
}

async function run() {
  console.log('\n[1] background: нормализация адреса сервера');
  const e1 = makeBgEnv();
  const norm = (v) => { e1.w.__v = null; e1.w.eval('window.__v = normUrl(' + JSON.stringify(v) + ')'); return e1.w.__v; };
  check('добавляет схему', norm('127.0.0.1:9999') === 'http://127.0.0.1:9999', norm('127.0.0.1:9999'));
  check('убирает хвостовые слеши', norm('http://127.0.0.1:8765///') === 'http://127.0.0.1:8765', norm('http://127.0.0.1:8765///'));
  check('пустое значение → дефолт', norm('') === 'http://127.0.0.1:8765', norm(''));

  console.log('\n[2] background: PING ходит на /ping');
  const r1 = await e1.send({ type: 'AX_PING' });
  check('ответ ok', !!(r1 && r1.ok), r1);
  check('запрошен /ping', e1.calls.fetch.length === 1 && e1.calls.fetch[0].url.endsWith('/ping'), e1.calls.fetch.map((c) => c.url));

  console.log('\n[3] background: настройки и токен');
  const e2 = makeBgEnv({ sync: { serverUrl: 'http://127.0.0.1:9999', timeout: 77 }, local: { authToken: 'SECRET-TOK' } });
  const r2 = await e2.send({ type: 'AX_GET_SETTINGS' });
  check('настройки отдаются', !!(r2 && r2.ok && r2.settings), r2);
  check('пользовательские настройки на месте',
    r2.settings.serverUrl === 'http://127.0.0.1:9999' && r2.settings.timeout === 77, r2.settings);
  check('дефолты дополнены (палитра, свёрнутый вывод)',
    r2.settings.paletteEnabled === true && r2.settings.noisyCollapse === true, r2.settings);
  check('токен НЕ отдаётся в content-script', r2.settings.authToken === '', r2.settings.authToken);
  check('токен остаётся в local (background его знает)', e2.store.local.authToken === 'SECRET-TOK', e2.store.local);
  check('в sync токен не попал', !('authToken' in e2.store.sync), Object.keys(e2.store.sync));

  console.log('\n[4] background: старый токен из sync мигрируется в local');
  const e3 = makeBgEnv({ sync: { authToken: 'LEGACY' } });
  await e3.send({ type: 'AX_PING' });   // миграция срабатывает при чтении токена
  const e3r = await e3.send({ type: 'AX_GET_SETTINGS' });
  check('токен не утёк в настройки', e3r.settings.authToken === '', e3r.settings.authToken);
  check('перенесён в local', e3.store.local.authToken === 'LEGACY', e3.store.local);
  check('удалён из sync', !('authToken' in e3.store.sync), Object.keys(e3.store.sync));

  console.log('\n[5] background: RUN отправляет команду с токеном');
  const e4 = makeBgEnv({
    sync: { serverUrl: 'http://127.0.0.1:8765', timeout: 30 },
    local: { authToken: 'SECRET-TOK' },
    fetchImpl: (url) => (url.endsWith('/run')
      ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, executed: true, exit_code: 0 }) })
      : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: 'ok' }) })),
  });
  const r4 = await e4.send({ type: 'AX_RUN', payload: { command: 'ls -la', runner: 'shell' } });
  check('команда выполнена', !!(r4 && r4.ok && r4.result && r4.result.executed), r4);
  const run4 = e4.calls.fetch.find((c) => c.url.endsWith('/run'));
  check('POST на /run', !!run4 && run4.init.method === 'POST', run4 && run4.init.method);
  check('токен в заголовке X-Auth-Token', !!run4 && run4.init.headers['X-Auth-Token'] === 'SECRET-TOK', run4 && run4.init.headers);
  check('тело — JSON с командой и средой', (() => {
    if (!run4) return false;
    const b = JSON.parse(run4.init.body);
    return b.command === 'ls -la' && b.runner === 'shell';
  })(), run4 && run4.init.body);

  console.log('\n[6] background: без токена заголовок не добавляется');
  const e5 = makeBgEnv({ fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }) });
  await e5.send({ type: 'AX_RUN', payload: { command: 'ls', runner: 'shell' } });
console.log('\n[6b] background: токен маскируется в команде и выводе');
  const TOK = 'super-secret-token-abc';
  const e5b = makeBgEnv({
    sync: { serverUrl: 'http://127.0.0.1:8765' },
    local: { authToken: TOK },
    fetchImpl: () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        ok: true, executed: true, exit_code: 0,
        stdout: 'вывод с токеном ' + TOK + ' и мусором',
        stderr: 'err ' + TOK,
      }),
    }),
  });
  const r5b = await e5b.send({ type: 'AX_RUN', payload: { command: 'echo ' + TOK, runner: 'shell' } });
  const so5 = (r5b && r5b.result && r5b.result.stdout) || '';
  const se5 = (r5b && r5b.result && r5b.result.stderr) || '';
  check('токен не попал в stdout ответа', so5.indexOf(TOK) === -1, so5);
  check('токен не попал в stderr ответа', se5.indexOf(TOK) === -1, se5);
  check('маска на месте', so5.indexOf('«скрыто»') >= 0, so5);
  const c5 = e5.calls.fetch.find((c) => c.url.endsWith('/run'));
  check('заголовка токена нет', !!c5 && !c5.init.headers['X-Auth-Token'], c5 && c5.init.headers);

  console.log('\n[7] background: ошибки не роняют расширение, а объясняются');
  const e6 = makeBgEnv({ fetchImpl: () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'invalid token' }) }) });
  const r6 = await e6.send({ type: 'AX_RUN', payload: { command: 'ls', runner: 'shell' } });
  check('401 не роняет ответ', !!(r6 && r6.ok === false), r6);
  check('причина пробросена', /invalid token/.test(String(r6 && r6.error)), r6 && r6.error);

  const e7 = makeBgEnv({ fetchImpl: () => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ blocked: true, error: 'not whitelisted' }) }) });
  const r7 = await e7.send({ type: 'AX_RUN', payload: { command: 'rm -rf /', runner: 'shell' } });
  check('blocked=true — не ошибка транспорта', !!(r7 && r7.ok === true && r7.result && r7.result.blocked), r7);

  const e8 = makeBgEnv({ fetchImpl: () => { const err = new Error('aborted'); err.name = 'AbortError'; return Promise.reject(err); } });
  const r8 = await e8.send({ type: 'AX_RUN', payload: { command: 'sleep 999', runner: 'shell' } });
  check('таймаут объяснён по-человечески', /превышено время ожидания/.test(String(r8 && r8.error)), r8 && r8.error);

  const r9 = await e1.send({ type: 'AX_ЧТО_ТО', payload: {} });
  check('неизвестное сообщение не ломает', !!(r9 && r9.ok === false && /unknown message/.test(r9.error)), r9);

  console.log('\n[8] background: контекстное меню создаётся при старте');
  check('пункт меню зарегистрирован', e1.calls.menus.some((m) => m.id === 'ax-run-selection'), e1.calls.menus);

  console.log('\n[11] background: авто-синхронизация токена при 401 (zero-touch)');
  let runCalls = 0;
  const eTok = makeBgEnv({
    sync: { serverUrl: 'http://127.0.0.1:8765', timeout: 30 },
    local: { authToken: 'STALE-TOK' },
    fetchImpl: (url, init) => {
      if (url.endsWith('/ax-token')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, auth_required: true, token: 'FRESH-TOK' }) });
      }
      if (url.endsWith('/run')) {
        runCalls++;
        const tk = (init.headers || {})['X-Auth-Token'];
        if (tk === 'FRESH-TOK') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, executed: true }) });
        return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'invalid or missing token (X-Auth-Token)' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    },
  });
  const rTok = await eTok.send({ type: 'AX_RUN', payload: { command: 'cd', runner: 'shell' } });
  check('401 после перезапуска вылечен авто-синхронизацией', !!(rTok && rTok.ok && rTok.result && rTok.result.executed), rTok);
  check('токен обновлён в local', eTok.store.local.authToken === 'FRESH-TOK', eTok.store.local);
  check('повтор /run был со свежим токеном', runCalls === 2, runCalls);

  console.log('\n[12] background: AX_PING подтягивает токен при auth_ok=false');
  let pingCalls = 0;
  const ePing = makeBgEnv({
    sync: { serverUrl: 'http://127.0.0.1:8765' },
    local: {},
    fetchImpl: (url, init) => {
      if (url.endsWith('/ax-token')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, auth_required: true, token: 'PING-TOK' }) });
      }
      if (url.endsWith('/ping')) {
        pingCalls++;
        const tk = (init.headers || {})['X-Auth-Token'];
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: 'ok', auth_required: true, auth_ok: tk === 'PING-TOK' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    },
  });
  const rPing = await ePing.send({ type: 'AX_PING' });
  check('ping сообщил auth_ok=true после синхронизации', !!(rPing && rPing.ok && rPing.info && rPing.info.auth_ok === true), rPing && rPing.info);
  check('токен сохранён из /ax-token', ePing.store.local.authToken === 'PING-TOK', ePing.store.local);
  check('ping опрошен дважды (до и после синхронизации)', pingCalls === 2, pingCalls);

  await runPopupChecks();

  console.log('\n======================================================');
  console.log('Итог: ' + passed + ' ok, ' + failed + ' fail');
  if (failed) {
    console.log('Провалы:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('Все проверки прошли.');
  process.exit(0);
}

run().catch((e) => {
  console.log('FAIL (исключение): ' + (e && e.stack || e));
  process.exit(1);
});