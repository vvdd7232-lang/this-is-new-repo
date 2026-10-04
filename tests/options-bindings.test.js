/* Тесты страницы настроек (options.js) и попапа в jsdom.
 *
 * Зачем этот файл: в v2.6.0 осиротевший `await` на верхнем уровне options.js
 * «съел» весь блок инициализации внутрь importSettings(), из-за чего молча
 * перестали работать сегменты темы/размера/эхо, кнопки Экспорт/Импорт,
 * индикатор несохранённых изменений и поиск по настройкам. Тесты ниже
 * проверяют именно ПОДКЛЮЧЕНИЕ обработчиков и реальные эффекты, поэтому такую
 * регрессию поймают сразу.
 *
 * Запуск:  cd tests && npm test
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const EXT_DIR = path.join(__dirname, '..', 'extension');

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

// Заглушки WebExtension API: promise-стиль (Firefox) + callback-стиль (Chrome).
function makeChromeStub(store, log) {
  const area = (name) => ({
    get(keys, cb) {
      const out = {};
      const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
      for (const k of list) if (k in store[name]) out[k] = store[name][k];
      if (cb) { cb(out); return undefined; }
      return Promise.resolve(out);
    },
    set(items, cb) {
      Object.assign(store[name], items);
      log.push({ op: 'set', area: name, items });
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    },
    remove(keys, cb) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[name][k];
      log.push({ op: 'remove', area: name, keys });
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    },
  });
  return {
    storage: { sync: area('sync'), local: area('local') },
    runtime: {
      getManifest: () => ({ version: '2.6.0' }),
      sendMessage: (msg) => {
        log.push({ op: 'sendMessage', msg });
        return Promise.resolve({ ok: true, info: { status: 'ok', whitelist_on: false, whitelist_size: 0 } });
      },
      openOptionsPage: () => {},
    },
  };
}

function loadOptionsPage(opts) {
  opts = opts || {};
  const html = fs.readFileSync(path.join(EXT_DIR, 'options.html'), 'utf8');
  const store = {
    sync: Object.assign({ serverUrl: 'http://127.0.0.1:8765', uiTheme: 'auto', echoMode: 'short', panelSize: 'normal' },
      opts.sync || {}),
    local: Object.assign({ authToken: '' }, opts.local || {}),
  };
  const log = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.log('  [jsdom error] ' + (e && e.message)));
  vc.on('error', (...a) => console.log('  [console.error] ' + a.join(' ')));
  const dom = new JSDOM(html, {
    url: opts.url || 'http://127.0.0.1/options.html',
    runScripts: 'dangerously',
    resources: undefined,
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // prompt.js и options.js подключаются тегами <script src>, jsdom их не
      // подгружает — внедряем исходники вручную в правильном порядке.
      window.__AX_STORE__ = store;
      window.__AX_LOG__ = log;
      window.confirm = () => true;
      const stub = makeChromeStub(store, log);
      window.chrome = stub;
      window.browser = undefined; // проверяем chrome-ветку (Chrome/Edge)
    },
  });
  const w = dom.window;
  for (const f of ['theme-boot.js', 'prompt.js', 'options.js']) {
    const code = fs.readFileSync(path.join(EXT_DIR, f), 'utf8');
    const s = w.document.createElement('script');
    s.textContent = code;
    w.document.body.appendChild(s);
  }
  return { dom, w, store, log };
}

function waitFor(fn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try { ok = fn(); } catch (e) { /* ignore */ }
      if (ok) { clearInterval(iv); resolve(true); return; }
      if (Date.now() - t0 > (timeoutMs || 3000)) { clearInterval(iv); reject(new Error('timeout')); }
    }, 25);
  });
}

async function run() {
  console.log('\n[1] options.js: блок инициализации на верхнем уровне');
  const { w, store, log } = loadOptionsPage();
  const $ = (id) => w.document.getElementById(id);
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  // Ждём, пока load() дочитает настройки: он подставляет serverUrl из storage
  // и только потом запускает testConnection() (PING виден в log).
  try {
    await waitFor(() => $('serverUrl').value === 'http://127.0.0.1:8765' && log.some((e) => e.op === 'sendMessage'), 4000);
  } catch (e) {
    console.log('  [debug] status.textContent = ' + JSON.stringify($('status').textContent));
    console.log('  [debug] serverUrl.value = ' + JSON.stringify($('serverUrl').value));
    throw e;
  }
  const loadRan = $('serverUrl').value === 'http://127.0.0.1:8765';
  check('load() реально выполнился', loadRan, $('serverUrl').value);
  check('load() дошёл до проверки сервера (PING)',
    log.some((e) => e.op === 'sendMessage' && e.msg && e.msg.type === 'AX_PING'));

  console.log('\n[2] Сегменты (тема/размер/эхо) действительно подключены');
  const themeDark = $('uiTheme').querySelector('button[data-v="dark"]');
  click(themeDark);
  check('клик по «Тёмная» переключил класс .on',
    themeDark.classList.contains('on'), themeDark.className);
  check('тема применилась к документу',
    w.document.documentElement.getAttribute('data-ax-theme') === 'dark',
    w.document.documentElement.getAttribute('data-ax-theme'));
  check('выбор темы запомнен для следующего открытия (без мигания)',
    (() => { try { return w.localStorage.getItem('axOptionsTheme') === 'dark'; } catch (e) { return false; } })());

  const sizeCompact = $('panelSize').querySelector('button[data-v="compact"]');
  click(sizeCompact);
  check('клик по «Компактный» переключил .on', sizeCompact.classList.contains('on'));

  const echoNone = $('echoMode').querySelector('button[data-v="none"]');
  click(echoNone);
  check('клик по «Скрыть» переключил .on', echoNone.classList.contains('on'));

  console.log('\n[3] Индикатор несохранённых изменений (dirty dot)');
  check('точка «есть несохранённые изменения» появилась', $('dirtyDot').classList.contains('on'));

  console.log('\n[4] Сохранение пишет сегменты и токен в нужные области storage');
  click($('save'));
  await waitFor(() => log.some((e) => e.op === 'set' && e.area === 'sync' && 'echoMode' in (e.items || {})), 3000);
  const syncSet = log.filter((e) => e.op === 'set' && e.area === 'sync').pop();
  check('echoMode ушёл в sync как none', syncSet && syncSet.items.echoMode === 'none', syncSet && syncSet.items.echoMode);
  check('uiTheme ушёл в sync как dark', syncSet && syncSet.items.uiTheme === 'dark', syncSet && syncSet.items.uiTheme);
  check('panelSize ушёл в sync как compact', syncSet && syncSet.items.panelSize === 'compact', syncSet && syncSet.items.panelSize);
  check('collapseAfterRun/soundOnComplete/browserNotify сохраняются',
    syncSet && 'collapseAfterRun' in syncSet.items && 'soundOnComplete' in syncSet.items && 'browserNotify' in syncSet.items,
    syncSet && Object.keys(syncSet.items));
  check('токен НЕ пишется в sync', syncSet && !('authToken' in syncSet.items), syncSet && Object.keys(syncSet.items));
  check('токен пишется в local', log.some((e) => e.op === 'set' && e.area === 'local' && 'authToken' in (e.items || {})));
  check('точка несохранённых изменений очистилась', !$('dirtyDot').classList.contains('on'));

  console.log('\n[5] Кнопки Экспорт/Импорт подключены (раньше были мертвы)');
  const exported = [];
  w.URL.createObjectURL = (blob) => { exported.push(blob); return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  const origCreate = w.document.createElement.bind(w.document);
  let downloadName = null;
  w.document.createElement = (tag) => {
    const el = origCreate(tag);
    if (String(tag).toLowerCase() === 'a') {
      Object.defineProperty(el, 'click', { value: () => { downloadName = el.download; } });
    }
    return el;
  };
  click($('exportBtn'));
  await waitFor(() => downloadName !== null, 2000).catch(() => {});
  check('Экспорт запустил скачивание ai-execute-settings.json',
    downloadName === 'ai-execute-settings.json', downloadName);
  w.document.createElement = origCreate;

  // Реалистичный цикл: экспорт текущих настроек -> сброс -> импорт файла.
  const syncBefore = log.filter((e) => e.op === 'set' && e.area === 'sync').pop().items;
  click($('reset'));                       // сбрасывает к дефолтам (confirm -> true)
  await waitFor(() => $('serverUrl').value === 'http://127.0.0.1:8765', 3000).catch(() => {});
  const settingsFile = new w.File([JSON.stringify({ ...syncBefore, authToken: 'secret-token' })],
    'settings.json', { type: 'application/json' });
  Object.defineProperty($('importFile'), 'files', { value: [settingsFile], configurable: true });
  $('importFile').dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => $('serverUrl').value === 'http://127.0.0.1:8765' &&
    $('echoMode').querySelector('button[data-v="none"]').classList.contains('on'), 3000).catch(() => {});
  check('Импорт применился к полям формы (echoMode=none, тема=dark)',
    $('echoMode').querySelector('button[data-v="none"]').classList.contains('on') &&
    $('uiTheme').querySelector('button[data-v="dark"]').classList.contains('on'),
    $('echoMode').querySelector('button.on') && $('echoMode').querySelector('button.on').dataset.v);
  check('Импортированный токен ушёл в local',
    log.some((e) => e.op === 'set' && e.area === 'local' && (e.items || {}).authToken === 'secret-token'));
  check('Импортированный токен НЕ ушёл в sync',
    !log.some((e) => e.op === 'set' && e.area === 'sync' && 'authToken' in (e.items || {})));

  console.log('\n[6] Биндинги живы после импорта; повторное сохранение пишет выбор');
  const echoShort = $('echoMode').querySelector('button[data-v="short"]');
  const echoNone2 = $('echoMode').querySelector('button[data-v="none"]');
  check('исходное состояние: выбран «Скрыть»',
    echoNone2.classList.contains('on') && !echoShort.classList.contains('on'));
  click(echoShort);
  check('сегмент реагирует на клик после load()',
    echoShort.classList.contains('on') && !echoNone2.classList.contains('on'));
  click($('save'));
  await waitFor(() => log.filter((e) => e.op === 'set' && e.area === 'sync').length >= 3, 3000).catch(() => {});
  const syncSet2 = log.filter((e) => e.op === 'set' && e.area === 'sync').pop();
  check('повторное сохранение записало echoMode=short', syncSet2 && syncSet2.items.echoMode === 'short',
    syncSet2 && syncSet2.items.echoMode);

  console.log('\n[7] Поиск по настройкам фильтрует карточки');
  const search = $('settingsSearch');
  check('поле поиска есть в разметке и найдено', !!search);
  const cards = Array.prototype.slice.call(w.document.querySelectorAll('details.card'));
  check('карточки настроек найдены', cards.length >= 5, cards.length);
  search.value = 'автопилот';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  const visible = cards.filter((c) => c.style.display !== 'none');
  check('после поиска видно меньше карточек, чем всего', visible.length > 0 && visible.length < cards.length,
    visible.length + '/' + cards.length);
  check('карточка про автопилот видна', visible.some((c) => /автопилот/i.test(c.textContent)));
  search.value = '';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  check('пустой запрос возвращает все карточки',
    cards.every((c) => c.style.display !== 'none'));

  console.log('\n[8] Токен: чтение из local, миграции из sync нет');
  check('поле токена не пустое после импорта', $('authToken').value === 'secret-token', $('authToken').value);

  console.log('\n[9] Онбординг: ссылка от сервера (#ax-setup=…) настраивает всё сама');
  const payload = Buffer.from(JSON.stringify({ url: 'http://127.0.0.1:9999', token: 'TOKEN-FROM-LINK' }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const linkEnv = loadOptionsPage({ url: 'http://127.0.0.1/options.html#ax-setup=' + payload });
  const l$ = (id) => linkEnv.w.document.getElementById(id);
  await waitFor(() => l$('serverUrl').value === 'http://127.0.0.1:9999', 4000).catch(() => {});
  check('адрес сервера подставлен из ссылки', l$('serverUrl').value === 'http://127.0.0.1:9999', l$('serverUrl').value);
  check('токен подставлен из ссылки', l$('authToken').value === 'TOKEN-FROM-LINK', l$('authToken').value);
  check('адрес сохранён в sync',
    linkEnv.log.some((e) => e.op === 'set' && e.area === 'sync' && (e.items || {}).serverUrl === 'http://127.0.0.1:9999'));
  check('токен сохранён в local (не в sync)',
    linkEnv.log.some((e) => e.op === 'set' && e.area === 'local' && (e.items || {}).authToken === 'TOKEN-FROM-LINK') &&
    !linkEnv.log.some((e) => e.op === 'set' && e.area === 'sync' && 'authToken' in (e.items || {})));
  check('токен вычищен из адресной строки', linkEnv.w.location.hash === '', linkEnv.w.location.hash);
  check('после применения сразу проверяется связь (PING)',
    linkEnv.log.some((e) => e.op === 'sendMessage' && e.msg && e.msg.type === 'AX_PING'));
  check('статус обновился результатом проверки связи',
    /на связи|недоступен/i.test(l$('status').textContent), l$('status').textContent);
  check('поля не помечены как «несохранённые»', !l$('dirtyDot').classList.contains('on'));

  console.log('\n[10] Битые и чужие ссылки не ломают страницу');
  const badEnv = loadOptionsPage({ url: 'http://127.0.0.1/options.html#ax-setup=!!!not-base64!!!' });
  await waitFor(() => /повреждена/i.test(badEnv.w.document.getElementById('status').textContent), 3000).catch(() => {});
  check('битая ссылка: понятное сообщение, поля не тронуты',
    /повреждена/i.test(badEnv.w.document.getElementById('status').textContent) &&
    badEnv.w.document.getElementById('serverUrl').value === 'http://127.0.0.1:8765',
    badEnv.w.document.getElementById('status').textContent);
  check('битая ссылка ничего не записала в storage',
    !badEnv.log.some((e) => e.op === 'set' && e.area === 'sync' && 'serverUrl' in (e.items || {})));
  const alienEnv = loadOptionsPage({ url: 'http://127.0.0.1/options.html#ax-setup=e30' }); // {} без url/token
  await waitFor(() => alienEnv.log.some((e) => e.op === 'sendMessage'), 3000).catch(() => {});
  check('пустая полезная нагрузка: поля остались прежними',
    alienEnv.w.document.getElementById('serverUrl').value === 'http://127.0.0.1:8765');

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
