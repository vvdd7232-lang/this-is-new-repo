/* Тесты новых возможностей: палитра команд, сворачивание шумного вывода, журнал.
 *
 * Запуск:  cd tests && npm test
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT_DIR = path.join(__dirname, '..', 'extension');
const AX_FILES = ['ax-detector.js', 'ax-core.js', 'ax-view.js', 'ax-panel.js', 'ax-palette.js', 'content.js'];

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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeEnv(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html><body><div id="chat">' +
    '<pre data-language="execute"><code>echo hello</code></pre>' +
    '</div><textarea id="prompt" data-rect="40,760,700,56" placeholder="Сообщение"></textarea>' +
    '</body></html>',
  { url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  // jsdom не умеет геометрию: getBoundingClientRect всегда 0x0, а детектор поля
  // ввода отбрасывает невидимые элементы. Геометрию задаём атрибутом data-rect.
  w.Element.prototype.getBoundingClientRect = function () {
    const raw = this.getAttribute && this.getAttribute('data-rect');
    if (!raw) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
    const [x, y, bw, bh] = raw.split(',').map(Number);
    return { x, y, width: bw, height: bh, top: y, left: x, bottom: y + bh, right: x + bw };
  };
  const store = {
    sync: Object.assign({
      serverUrl: 'http://127.0.0.1:8765', timeout: 30, requireConfirm: false, maxOutputChars: 32000,
      autoExecute: false, autoInsert: false, autoSend: false, autoDelay: 0, looseSearch: true, autoWeak: false,
      maxAutoRuns: 0, defaultRunner: 'shell', showToasts: false, defaultCwd: '', uiTheme: 'auto',
      panelSize: 'normal', collapseAfterRun: false, soundOnComplete: false, browserNotify: false,
      echoMode: 'short', previewLines: 12, paletteEnabled: true, noisyCollapse: true,
    }, opts.sync || {}),
    local: Object.assign({}, opts.local || {}),
  };
  const runs = [];
  const area = (name) => ({
    get: (keys, cb) => {
      const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
      const out = {};
      for (const k of list) if (k in store[name]) out[k] = store[name][k];
      if (cb) { cb(out); return undefined; }
      return Promise.resolve(out);
    },
    set: (items, cb) => { Object.assign(store[name], items); if (cb) cb(); return Promise.resolve(); },
    remove: (keys, cb) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[name][k];
      if (cb) cb();
      return Promise.resolve();
    },
  });
  w.chrome = {
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener() {} } },
    runtime: {
      id: 'test-id',
      getManifest: () => ({ version: '2.6.1' }),
      getURL: (p) => 'chrome-extension://test/' + p,
      sendMessage: (msg, cb) => {
        let resp = { ok: false, error: 'unknown' };
        if (msg && msg.type === 'AX_GET_SETTINGS') resp = { ok: true, settings: store.sync };
        else if (msg && msg.type === 'AX_PING') resp = { ok: true, info: { status: 'ok' } };
        else if (msg && msg.type === 'AX_RUN') {
          runs.push(msg.payload);
          resp = { ok: true, result: { ok: true, executed: true, runner: msg.payload.runner, exit_code: 0, stdout: 'ok\n', stderr: '', duration_ms: 5 } };
        }
        if (cb) { setTimeout(() => cb(resp), 0); return undefined; }
        return Promise.resolve(resp);
      },
      onMessage: { addListener() {} },
    },
  };
  w.browser = undefined;
  if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  w.__realKey = (key, init) => {
    w.AX.assumeTrustedEvents = true;
    try {
      const ev = new w.KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, init || {}));
      w.document.dispatchEvent(ev);
      return ev;
    } finally {
      w.AX.assumeTrustedEvents = false;
    }
  };
  w.__realClick = (el) => {
    w.AX.assumeTrustedEvents = true;
    try { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); }
    finally { w.AX.assumeTrustedEvents = false; }
  };
  for (const f of AX_FILES) w.eval(fs.readFileSync(path.join(EXT_DIR, f), 'utf8'));
  return { dom, w, store, runs };
}

async function run() {
  // ---------------------------------------------------------------- палитра
  console.log('\n[1] Палитра команд: открытие, поиск, список');
  const env = makeEnv({
    local: {
      axCommandLog: [
        { cmd: 'npm run build', runner: 'shell', t: Date.now() - 60000, exit: 0, status: 'done' },
        { cmd: 'git status -s', runner: 'shell', t: Date.now() - 120000, exit: 0, status: 'done' },
        { cmd: 'python -m pytest', runner: 'python', t: Date.now() - 300000, exit: 1, status: 'done' },
      ],
    },
    sync: { axPinnedCommands: [{ cmd: 'npm test', runner: 'shell', t: Date.now() }] },
  });
  const { w } = env;
  await sleep(80);
  check('журнал команд загружен из storage', w.AX.cmdLog.length === 3, w.AX.cmdLog.length);
  check('закреплённые загружены из sync', w.AX.pinned.length === 1, w.AX.pinned.length);

  check('палитра закрыта по умолчанию', w.AX.isPaletteOpen() === false);
  w.__realKey('e', { ctrlKey: true, shiftKey: true });
  check('Ctrl+Shift+E открывает палитру', w.AX.isPaletteOpen() === true);
  const host = w.document.querySelector('.ax-palette-host');
  check('хост палитры в документе', !!host);
  check('содержимое закрыто от page-JS', host.shadowRoot === null && host.querySelector('.ax-palette') === null);
  check('внутри доступно расширению', !!host.$('.ax-palette-list'));

  const rows = () => Array.from(host.$$('.ax-palette-item'));
  check('закреплённая команда идёт первой', rows()[0] && /npm test/.test(rows()[0].textContent), rows()[0] && rows()[0].textContent);
  check('всего строк = закреплённая + 3 из истории', rows().length === 4, rows().length);
  check('видно код возврата прошлого запуска', /exit=1/.test(rows().map((r) => r.textContent).join(' ')));
  check('видно среду', /python/.test(rows().map((r) => r.textContent).join(' ')));

  console.log('\n[2] Палитра: поиск и «новая команда»');
  const input = host.$('.ax-palette-input');
  input.value = 'pytest';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  check('поиск оставляет только совпадение', rows().length === 1 && /pytest/.test(rows()[0].textContent), rows().length);
  input.value = 'git';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  check('поиск по слову находит git status', rows().length === 1 && /git status/.test(rows()[0].textContent));
  input.value = 'echo новая';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  const customRow = rows().find((r) => r.classList.contains('ax-palette-custom'));
  check('неизвестный текст предлагается как новая команда', !!customRow, rows().map((r) => r.className));
  input.value = '';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));

  console.log('\n[3] Палитра: запуск и предохранители');
  w.AX.settings.requireConfirm = false;
  const target = rows().find((r) => /git status/.test(r.textContent));
  w.__realClick(target);
  await sleep(60);
  check('клик по строке запускает команду', env.runs.length === 1, env.runs);
  check('ушла именно выбранная команда', env.runs[0] && env.runs[0].command === 'git status -s', env.runs[0]);
  check('после запуска палитра закрылась', w.AX.isPaletteOpen() === false);

  w.__realKey('e', { ctrlKey: true, shiftKey: true });
  check('палитра открывается повторно', w.AX.isPaletteOpen() === true);
  w.__realKey('Escape');
  check('Esc закрывает палитру', w.AX.isPaletteOpen() === false);

  console.log('\n[4] Палитра: закрепление и вставка в чат');
  w.__realKey('e', { ctrlKey: true, shiftKey: true });
  check('первой идёт уже закреплённая команда', w.AX.isPinned('npm test') === true);
  // Закрепляем обычную (не закреплённую) команду — она должна подняться наверх.
  const unpinnedRow = rows().find((r) => /git status/.test(r.textContent));
  check('в списке есть незакреплённая команда', !!unpinnedRow);
  w.__realClick(unpinnedRow.querySelector('[data-act="pin"]'));
  await sleep(30);
  check('закрепление изменило список', w.AX.pinned.length === 2, w.AX.pinned);
  check('закреплённая команда поднялась наверх', /git status/.test(rows()[0].textContent), rows()[0].textContent);
  check('звёздочка стала заполненной', rows()[0].querySelector('[data-act="pin"]').textContent === '★');
  // Повторное нажатие снимает закрепление.
  w.__realClick(rows()[0].querySelector('[data-act="pin"]'));
  await sleep(30);
  check('повторное нажатие снимает закрепление', w.AX.pinned.length === 1 && w.AX.isPinned('git status -s') === false);

  const insBtn = rows().find((r) => /npm test/.test(r.textContent)).querySelector('[data-act="insert"]');
  w.__realClick(insBtn);
  await sleep(30);
  check('вставка в чат положила execute-блок',
    /```execute\nnpm test\n```/.test(w.document.getElementById('prompt').value), w.document.getElementById('prompt').value);
  check('после вставки палитра закрылась', w.AX.isPaletteOpen() === false);
  // Вставка для другой среды даёт соответствующий суффикс execute-*.
  w.__realKey('e', { ctrlKey: true, shiftKey: true });
  input.value = 'python -m pytest';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.__realClick(rows()[0].querySelector('[data-act="insert"]'));
  await sleep(30);
  check('для python вставляется execute-python',
    /```execute-python/.test(w.document.getElementById('prompt').value), w.document.getElementById('prompt').value);

  console.log('\n[5] Палитра: опасное не запускается без подтверждения');
  const env2 = makeEnv({ sync: { requireConfirm: false } });
  await sleep(60);
  const w2 = env2.w;
  w2.AX.logCommand('rm -rf /', 'shell', 0, 'done');
  w2.__realKey('e', { ctrlKey: true, shiftKey: true });
  const host2 = w2.document.querySelector('.ax-palette-host');
  const dangerRow = Array.from(host2.$$('.ax-palette-item')).find((r) => /rm -rf/.test(r.textContent));
  check('опасная команда есть в списке', !!dangerRow);
  if (dangerRow) {
    w2.__realClick(dangerRow);
    await sleep(60);
    check('опасная команда НЕ выполнилась сразу — показана модалка',
      env2.runs.length === 0 && !!w2.document.querySelector('.ax-modal-backdrop'),
      { runs: env2.runs.length, modal: !!w2.document.querySelector('.ax-modal-backdrop') });
  }

  console.log('\n[6] Палитра: горячая клавиша уважает настройку и isTrusted');
  const env3 = makeEnv({ sync: { paletteEnabled: false } });
  await sleep(60);
  env3.w.__realKey('e', { ctrlKey: true, shiftKey: true });
  check('при paletteEnabled=false палитра не открывается', env3.w.AX.isPaletteOpen() === false);
  const env4 = makeEnv();
  await sleep(60);
  env4.w.document.dispatchEvent(new env4.w.KeyboardEvent('keydown', { key: 'e', ctrlKey: true, shiftKey: true, bubbles: true }));
  check('синтетическая клавиша из page-JS игнорируется', env4.w.AX.isPaletteOpen() === false);

  console.log('\n[7] Палитра: открытие не дёргает ленту чата');
  // Реальный баг: scrollIntoView прокручивал всех предков, включая страницу
  // чата, — Ctrl+Shift+E прыгал в конец переписки. Проверяем на scrollTop.
  const env5b = makeEnv();
  await sleep(60);
  const w3 = env5b.w;
  w3.document.documentElement.scrollTop = 500;
  w3.document.body.scrollTop = 500;
  const scrollBefore = w3.document.documentElement.scrollTop || w3.document.body.scrollTop;
  let scrolledInto = 0;
  w3.Element.prototype.scrollIntoView = function () { scrolledInto++; };
  w3.__realKey('e', { ctrlKey: true, shiftKey: true });
  await sleep(30);
  const scrollAfter = w3.document.documentElement.scrollTop || w3.document.body.scrollTop;
  check('позиция прокрутки страницы не изменилась', scrollAfter === scrollBefore, { scrollBefore, scrollAfter });
  check('scrollIntoView не вызывается вовсе', scrolledInto === 0, scrolledInto);
  check('палитра при этом открылась', w3.AX.isPaletteOpen() === true);
  w3.__realKey('Escape');
  await sleep(20);
  check('закрытие тоже не прокручивает страницу',
    (w3.document.documentElement.scrollTop || w3.document.body.scrollTop) === scrollBefore);

  console.log('\n[3] Палитра: фильтр (AX.paletteFilter)');
  const list = [
    { cmd: 'npm run build', runner: 'shell', t: 1, pinned: false },
    { cmd: 'npm test', runner: 'shell', t: 2, pinned: true },
    { cmd: 'python -m pytest', runner: 'python', t: 3, pinned: false },
  ];
  const f1 = w.AX.paletteFilter(list, 'npm');
  check('поиск по npm находит две', f1.length === 2, f1.map((i) => i.cmd));
  check('закреплённая выше при равном совпадении', f1[0] && f1[0].cmd === 'npm test', f1[0] && f1[0].cmd);
  check('поиск по среде находит python', w.AX.paletteFilter(list, 'python').length === 1);
  check('пустой запрос возвращает всё', w.AX.paletteFilter(list, '').length === 3);
  check('несовпадение даёт пусто', w.AX.paletteFilter(list, 'docker').length === 0);

  // ------------------------------------------------------- шумный вывод
  console.log('\n[8] Сворачивание шумного вывода (AX.isNoisyOutput)');
  const longListing = Array.from({ length: 300 }, (_, i) => 'added package-' + i + '@1.0.' + i).join('\n');
  const shortOut = 'готово\n2 файла';
  const codeOut = Array.from({ length: 60 }, (_, i) => '  ' + i + ': ' + 'x'.repeat(140) + ' очень длинная строка кода').join('\n');
  check('длинный листинг считается шумным', w.AX.isNoisyOutput(longListing).noisy === true);
  check('короткий вывод — не шумный', w.AX.isNoisyOutput(shortOut).noisy === false);
  check('длинные строки кода не сворачиваем', w.AX.isNoisyOutput(codeOut).noisy === false);
  check('пустой вывод — не шумный', w.AX.isNoisyOutput('').noisy === false);
  check('граница: 39 строк не шумно', w.AX.isNoisyOutput(Array.from({ length: 39 }, () => 'x').join('\n')).noisy === false);
  check('граница: 40 строк шумно', w.AX.isNoisyOutput(Array.from({ length: 40 }, () => 'x').join('\n')).noisy === true);
  check('возвращает общее число строк', w.AX.isNoisyOutput(longListing).total === 300);

  // ------------------------------------------------------------ журнал
  console.log('\n[9] Журнал команд: запись, дедуп, лимит, закрепление');
  const env5 = makeEnv();
  await sleep(60);
  const A = env5.w.AX;
  A.clearCmdLog();
  A.logCommand('npm test', 'shell', 0, 'done');
  A.logCommand('npm run build', 'shell', 0, 'done');
  check('записи добавляются в начало (свежие сверху)', A.cmdLog[0].cmd === 'npm run build', A.cmdLog.map((e) => e.cmd));
  A.logCommand('npm test', 'shell', 1, 'done');
  check('повтор не дублируется, а поднимается', A.cmdLog.length === 2 && A.cmdLog[0].cmd === 'npm test', A.cmdLog.map((e) => e.cmd));
  check('код возврата обновился', A.cmdLog[0].exit === 1, A.cmdLog[0]);
  for (let i = 0; i < 40; i++) A.logCommand('cmd-' + i, 'shell', 0, 'done');
  check('лимит журнала соблюдается (30)', A.cmdLog.length === 30, A.cmdLog.length);
  check('самая старая запись вытеснена', !A.cmdLog.some((e) => e.cmd === 'npm run build'));
  check('пустую команду не пишем', (() => { const n = A.cmdLog.length; A.logCommand('   ', 'shell', 0, 'done'); return A.cmdLog.length === n; })());

  A.clearCmdLog();
  check('очистка журнала работает', A.cmdLog.length === 0);
  check('togglePin закрепляет', A.togglePin('npm ci', 'shell') === true && A.isPinned('npm ci') === true);
  check('togglePin снимает закрепление', A.togglePin('npm ci', 'shell') === false && A.isPinned('npm ci') === false);
  A.togglePin('npm ci', 'shell');
  A.togglePin('git log', 'shell');
  const items = A.paletteItems();
  check('paletteItems: закреплённые первыми', items[0].pinned === true && items[1].pinned === true, items.map((i) => i.cmd));
  check('paletteItems: без дублей', new Set(items.map((i) => i.cmd)).size === items.length);

  console.log('\n[10] Журнал: markdown-экспорт');
  const optionsJs = fs.readFileSync(path.join(EXT_DIR, 'options.js'), 'utf8');
  check('в options.js есть генератор markdown', /function journalLines/.test(optionsJs));
  check('экспорт пишет имя файла .md', /ai-execute-journal\.md/.test(optionsJs));
  check('в шапке журнала предупреждение о секретах', /секреты \(токен доступа\) в командах не сохраняются/.test(optionsJs));
  check('markdown-таблица формируется', /\|---\|---/.test(optionsJs.replace(/\|/g, '|')) && /\| # \| Когда \|/.test(optionsJs));
  check('в options.html есть кнопки журнала', /id="exportJournal"/.test(fs.readFileSync(path.join(EXT_DIR, 'options.html'), 'utf8')) &&
    /id="clearJournal"/.test(fs.readFileSync(path.join(EXT_DIR, 'options.html'), 'utf8')));

  console.log('\n[11] Журнал пишется без секретов');
  const D = w.AXDetector;
  const TOKEN = 's3cr3t-token-value-9876';
  w.AX.settings.authToken = TOKEN;
  check('маскируется --token', !/hunter2/.test(D.redactSecrets('server.py --token hunter2')), D.redactSecrets('server.py --token hunter2'));
  check('маскируется --token=…', !/abc123/.test(D.redactSecrets('curl -H "X-Auth-Token: abc123"')));
  check('маскируется Bearer', /Bearer «скрыто»/.test(D.redactSecrets('curl -H "Authorization: Bearer eyJhbGciOi.X9"')));
  check('маскируется password=', !/p@ssw0rd/.test(D.redactSecrets('PGPASSWORD=p@ssw0rd psql')));
  check('маскируется api_key', !/key-12345678/.test(D.redactSecrets('curl https://api/?api_key=key-12345678')));
  check('настроенный токен маскируется', !D.redactSecrets('curl -H "X-Auth-Token: ' + TOKEN + '"', [TOKEN]).includes(TOKEN));
  check('обычная команда не меняется', D.redactSecrets('npm test') === 'npm test', D.redactSecrets('npm test'));
  check('короткое значение не маскируется (ложных срабатываний нет)',
    D.redactSecrets('git log', ['abc']) === 'git log', D.redactSecrets('git log', ['abc']));

  A.clearCmdLog();
  A.logCommand('curl -H "X-Auth-Token: ' + TOKEN + '" https://api', 'shell', 0, 'done');
  check('в журнале нет значения токена', !A.cmdLog[0].cmd.includes(TOKEN), A.cmdLog[0].cmd);
  check('запись помечена как содержащая секрет', A.cmdLog[0].secret === true, A.cmdLog[0]);
  check('в paletteItems флаг secret доезжает',
    A.paletteItems().find((i) => /api/.test(i.cmd)).secret === true, A.paletteItems()[0]);
  check('в сохранённый storage уходит маскированный текст', (() => {
    A.clearCmdLog();
    A.logCommand('psql --password pa55word', 'shell', 0, 'done');
    return !JSON.stringify(env5.store.local.axCommandLog).includes('pa55word');
  })(), env5.store.local.axCommandLog);
  A.clearCmdLog();
  A.logCommand('npm test', 'shell', 0, 'done');
  check('обычная команда пишется как есть', A.cmdLog[0].cmd === 'npm test' && A.cmdLog[0].secret === false, A.cmdLog[0]);
  check('закрепление тоже маскирует', (() => {
    A.togglePin('curl -H "X-Auth-Token: ' + TOKEN + '"', 'shell');
    return !A.pinned[0].cmd.includes(TOKEN);
  })(), A.pinned[0]);

  console.log('\n[12] Палитра: команда со скрытым секретом не запускается как есть');
  w.__realKey('e', { ctrlKey: true, shiftKey: true });
  w.AX.logCommand('curl -H "X-Auth-Token: ' + TOKEN + '" https://api', 'shell', 0, 'done');
  const secretInput = host.$('.ax-palette-input');
  secretInput.value = 'api';
  secretInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  const runsBefore = env.runs.length;
  w.__realClick(rows().find((r) => /api/.test(r.textContent)));
  await sleep(40);
  check('команда со скрытым секретом не выполнена', env.runs.length === runsBefore, env.runs.length);
  check('текст подставлен в поиск для правки', /«скрыто»/.test(secretInput.value), secretInput.value);
  check('значение токена в палитре не показывается', !rows().map((r) => r.textContent).join(' ').includes(TOKEN));
  w.__realKey('Escape');

  console.log('\n[13] Тема shadow-хостов: токены приходят из CSS, а не из JS');
  // Реальный баг: токены отступов/радиусов/теней (--ax-s-*, --ax-r-*, --ax-shadow-*)
  // жили только на :root, а :root не действует внутри shadow root. Панель и
  // модалки теряли padding/радиус/тень. Теперь токены объявлены на :host.
  const w6 = makeEnv().w;
  await sleep(60);
  const uiCss = fs.readFileSync(path.join(EXT_DIR, 'ax-ui.css'), 'utf8');
  const coreJs6 = fs.readFileSync(path.join(EXT_DIR, 'ax-core.js'), 'utf8');
  // Комментарии вырезаем: объясняющий текст не должен ломать проверки.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const uiCode6 = strip(uiCss);
  const coreCode6 = strip(coreJs6);
  const rootAt = uiCode6.indexOf(':root');
  const tokenDecl = uiCode6.slice(rootAt, uiCode6.indexOf('\n}', rootAt));
  check('токены объявлены на :host', /(^|,)\s*:host\s*,/m.test(tokenDecl), tokenDecl.slice(0, 60));
  for (const t of ['--ax-s-5:', '--ax-r-lg:', '--ax-shadow-3:', '--ax-font-mono:', '--ax-surface:']) {
    check('токен ' + t + ' объявлен в CSS', tokenDecl.includes(t));
  }
  check('в JS нет дубля токенов', !/PANEL_THEME_VARS/.test(coreCode6) && !/setProperty\('--ax-/.test(coreCode6));
  check('тёмная тема есть и для :host', /:host\(\[data-ax-theme="dark"\]\)/.test(uiCode6));

  // Хосты получают атрибут темы — по нему выбирается блок :host([data-ax-theme]).
  const modal6 = w6.AX.createShadowModal();
  const panel6 = w6.AX.createShadowPanel();
  for (const [name, host] of [['createShadowModal', modal6], ['createShadowPanel', panel6]]) {
    check(name + ': data-ax-theme выставлен',
      host.getAttribute('data-ax-theme') === 'light' || host.getAttribute('data-ax-theme') === 'dark',
      host.getAttribute('data-ax-theme'));
    check(name + ': токены НЕ задаются inline (иначе снова разъедутся с CSS)',
      !/--ax-/.test(host.getAttribute('style') || ''), host.getAttribute('style'));
  }
  w6.AX.settings.uiTheme = 'dark';
  const darkModal = w6.AX.createShadowModal();
  check('тёмная тема доезжает до нового хоста', darkModal.getAttribute('data-ax-theme') === 'dark', darkModal.getAttribute('data-ax-theme'));
  w6.AX.settings.uiTheme = 'light';
  w6.AX.applyPanelAppearance(darkModal);
  check('applyPanelAppearance обновляет существующий хост',
    darkModal.getAttribute('data-ax-theme') === 'light', darkModal.getAttribute('data-ax-theme'));

  console.log('\n[14] Настройки новых функций сохраняются и читаются');
  const optHtml = fs.readFileSync(path.join(EXT_DIR, 'options.html'), 'utf8');
  const optJs = fs.readFileSync(path.join(EXT_DIR, 'options.js'), 'utf8');
  const bgJs = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
  check('в разметке есть paletteEnabled', /id="paletteEnabled"/.test(optHtml));
  check('в разметке есть noisyCollapse', /id="noisyCollapse"/.test(optHtml));
  check('save() сохраняет paletteEnabled', /paletteEnabled: \$\('paletteEnabled'\)\.checked/.test(optJs));
  check('save() сохраняет noisyCollapse', /noisyCollapse: \$\('noisyCollapse'\)\.checked/.test(optJs));
  check('load() подставляет оба значения', /\$\('noisyCollapse'\)\.checked = d\.noisyCollapse !== false/.test(optJs));
  check('DEFAULTS в background.js дополнены', /paletteEnabled: true/.test(bgJs) && /noisyCollapse: true/.test(bgJs));
  check('манифест подключает ax-palette.js',
    /ax-palette\.js/.test(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')) &&
    /ax-palette\.js/.test(fs.readFileSync(path.join(EXT_DIR, 'manifest.chrome.json'), 'utf8')));

  console.log('\n[15] Статистика и достижения: движок и виджет');
  const w7 = makeEnv().w;
  await sleep(30);
  w7.AX.resetStats();
  w7.AX.recordRun('shell', true, 'done', {});
  check('recordRun считает запуск', w7.AX.stats.runs === 1 && w7.AX.stats.ok === 1, w7.AX.stats.runs);
  check('достижение «Первый запуск» разблокировано',
    w7.AX.stats.unlocked.some((u) => (u.id || u) === 'first_run'), w7.AX.stats.unlocked);
  for (let i = 0; i < 5; i++) w7.AX.recordRun('shell', true, 'done', {});
  check('серия успехов растёт', w7.AX.stats.bestStreak >= 5, w7.AX.stats.bestStreak);
  check('достижение «Пять подряд» есть',
    w7.AX.stats.unlocked.some((u) => (u.id || u) === 'streak_5'));
  const before = w7.AX.stats.streak;
  w7.AX.recordRun('shell', false, 'done', {});
  check('ошибка рвёт текущую серию', before > 0 && w7.AX.stats.streak === 0, w7.AX.stats.streak);
  w7.AX.recordRun('shell', true, 'done', { auto: true, palette: true });
  check('счётчики auto/palette раздельно', w7.AX.stats.auto === 1 && w7.AX.stats.palette === 1, w7.AX.stats);
  w7.AX.recordView();
  check('recordView считает картинку', w7.AX.stats.view === 1, w7.AX.stats.view);
  ['python', 'node', 'powershell', 'shell'].forEach((r) => w7.AX.recordRun(r, true, 'done', {}));
  check('достижение «Полиглот» (4 среды)',
    w7.AX.stats.unlocked.some((u) => (u.id || u) === 'polyglot'));
  const nUnlocked = w7.AX.stats.unlocked.length;
  w7.AX.checkAchievements();
  check('повторная проверка не дублирует достижения', w7.AX.stats.unlocked.length === nUnlocked);
  const state = w7.AXDetector.achievementState(w7.AX.stats);
  check('achievementState отдаёт прогресс', state.length >= 10 &&
    state.every((a) => typeof a.have === 'number' && typeof a.goal === 'number'), state.length);
  check('first_run в состоянии виджета отмечен открытым',
    state.find((a) => a.id === 'first_run').unlocked === true);

  const lvl0 = w7.AXDetector.levelFor({});
  check('levelFor на пустой статистике = 1 уровень', lvl0.level === 1 && lvl0.xp === 0, lvl0.level);
  const lvl1 = w7.AXDetector.levelFor(w7.AX.stats);
  check('XP растёт с запусками и достижениями', lvl1.xp > 0, lvl1.xp);
  check('levelFor отдаёт прогресс до следующего уровня',
    lvl1.pct >= 0 && lvl1.pct <= 100 && lvl1.need > 0, lvl1);
  const lvlBig = w7.AXDetector.levelFor({ ok: 5000, view: 200, auto: 100, unlocked: new Array(12).fill(0) });
  check('много XP даёт высокий уровень', lvlBig.level > 8, lvlBig.level);

  check('карточка статистики есть в options', /id="sec-stats"/.test(optHtml) && /id="achGrid"/.test(optHtml));
  check('раздел статистики есть в навигации', /data-nav="sec-stats"/.test(optHtml));
  check('виджет достижений рендерится из общего списка',
    /function renderStats/.test(optJs) && /AXDetector\.achievementState/.test(optJs));
  check('сброс статистики подключён',
    /id="resetStats"/.test(optHtml) && /\$\('resetStats'\)\.onclick/.test(optJs));
  check('экспорт PDF: кнопка, обработчик и печать через iframe',
    /id="exportPdf"/.test(optHtml) && /function exportJournalPdf/.test(optJs) &&
    /\$\('exportPdf'\)\.onclick/.test(optJs) && /win\.print\(\)/.test(optJs));
  check('PDF-экспорт маскирует секреты',
    /function journalHtml/.test(optJs) && /redactSecrets/.test(optJs));

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
