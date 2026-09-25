/* Тесты детектора поля ввода чата и вставки картинки (view).
 *
 * Загружают НАСТОЯЩИЙ extension/content.js в jsdom с минимальными заглушками
 * WebExtension API и проверяют:
 *  - DeepSeek: находится textarea[name="search"], а не contenteditable;
 *  - ловушка DeepSeek (textarea[name="user query"]) игнорируется;
 *  - при нескольких contenteditable выбирается самое нижнее;
 *  - активное поле пользователя не перебивается;
 *  - картинка реально доходит до скрытого input[type=file] композера;
 *  - расширение файла нормализовано (svg -> .svg, а не 'image.svg+xml');
 *  - без подтверждения в DOM вставка не объявляется успешной.
 *
 * Запуск:  cd tests && npm install && npm test
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const CONTENT_JS = path.join(__dirname, '..', 'extension', 'content.js');
const code = fs.readFileSync(CONTENT_JS, 'utf8');

// Мини-картинка 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = 'data:image/png;base64,' + PNG_B64;

let passed = 0;
let failed = 0;
const failures = [];
const createdEnvs = [];

function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else {
    failed++;
    failures.push(name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''));
    console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''));
  }
}

/* jsdom не умеет геометрию: getBoundingClientRect всегда 0x0, а детектор
 * отбрасывает невидимые элементы. Геометрию задаём атрибутом data-rect. */
function installGeometrySupport(window) {
  window.Element.prototype.getBoundingClientRect = function () {
    const raw = this.getAttribute && this.getAttribute('data-rect');
    if (!raw) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
    const [x, y, w, h] = raw.split(',').map(Number);
    return { x, y, width: w, height: h, top: y, left: x, bottom: y + h, right: x + w };
  };
}



/* jsdom НЕ реализует: isContentEditable, ClipboardEvent, DataTransfer и
 * сеттер input.files (в Firefox/Chrome всё это есть). Ниже шимы,
 * максимально приближённые к поведению браузера. */
function installBrowserShims(window) {
  // 1) isContentEditable: true, если сам элемент или предок contenteditable
  if (!('isContentEditable' in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, 'isContentEditable', {
      configurable: true,
      get() {
        let node = this;
        while (node && node.nodeType === 1) {
          const v = node.getAttribute && node.getAttribute('contenteditable');
          if (v === 'true' || v === 'plaintext-only') return true;
          if (v === 'false') return false;
          node = node.parentElement;
        }
        return false;
      },
    });
  }

  // 2) DataTransfer с items.add / files (в браузере dt.files — FileList,
  //    а dt.items — DataTransferItemList с getAsFile())
  class FakeDataTransfer {
    constructor() { this._items = []; this.dropEffect = 'none'; this.effectAllowed = 'uninitialized'; }
    get types() { return this._items.map((f) => f.type); }
    get files() { return this._items.slice(); }
    get items() {
      const self = this;
      const list = self._items.map((file) => ({
        kind: 'file',
        type: file.type,
        name: file.name,
        getAsFile: () => file,
      }));
      list.add = (file) => { self._items.push(file); };
      return list;
    }
    clearData() { this._items = []; }
    setData() { throw new Error('setData не поддерживается в тесте'); }
  }
  window.DataTransfer = FakeDataTransfer;

  // 3) input.files: принимаем массив/FileList (браузер требует FileList,
  //    поэтому патчим сеттор на уровне экземпляра через defineProperty)
  const fileDesc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files');
  Object.defineProperty(window.HTMLInputElement.prototype, 'files', {
    configurable: true,
    get() { return this.__axFiles || fileDesc.get.call(this); },
    set(v) {
      if (v && (Array.isArray(v) || typeof v.length === 'number')) {
        this.__axFiles = v;
      } else {
        fileDesc.set.call(this, v);
      }
    },
  });

  // 4) ClipboardEvent, который (как Chrome) сохраняет clipboardData
  window.ClipboardEvent = class ClipboardEvent extends window.Event {
    constructor(type, init) {
      super(type, init);
      this.clipboardData = (init && init.clipboardData) || null;
    }
  };

  // 5) InputEvent с dataTransfer/inputType (часть редакторов это слушает)
  window.InputEvent = class InputEvent extends window.Event {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.inputType = init.inputType || '';
      this.dataTransfer = init.dataTransfer || null;
    }
  };
}

function makeDom(html, opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', {
    url: opts.url || 'https://chat.deepseek.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  installGeometrySupport(window);

  // --- заглушки WebExtension API ---
  window.chrome = {
    runtime: {
      id: 'test-extension',
      sendMessage: (msg, cb) => {
        const resp = { ok: true, settings: {}, result: null };
        if (cb) { try { cb(resp); } catch {} } else return Promise.resolve(resp);
      },
      onMessage: { addListener: () => {} },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    storage: {
      local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() },
      sync: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() },
      onChanged: { addListener: () => {} },
    },
  };
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  }

  // Шимы браузерных API — ставим ДО eval(content.js)
  installBrowserShims(window);

  // Лог тостов — проверяем честность сообщений
  const toasts = [];
  const toastObs = new window.MutationObserver(() => {
    const t = window.document.querySelector('.ax-toast');
    if (t && t.textContent && toasts[toasts.length - 1] !== t.textContent) toasts.push(t.textContent);
  });
  toastObs.observe(window.document.documentElement, { childList: true, subtree: true, characterData: true });

  window.eval(code);

  // init() мог отложиться до DOMContentLoaded (jsdom отдаёт readyState=loading
  // сразу после eval) — дожидаемся, пока расширение выставит диагностический хук.
  if (typeof window.__axDiag !== 'function') {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  }
  if (typeof window.__axDiag !== 'function') {
    throw new Error('content.js не инициализировался: нет window.__axDiag');
  }
  const env = { dom, window, toasts };
  createdEnvs.push(env);
  return env;
}

function diagOf(env) { return env.window.__axDiag(); }
function lastToast(env) { return env.toasts[env.toasts.length - 1] || ''; }

/* ============================ Тесты ============================ */

(async function main() {

console.log('\n[1] DeepSeek: textarea[name="search"] вместо contenteditable');
{
  const env = makeDom(
    '<div data-rect="0,0,900,300">сообщения</div>' +
    '<form class="_1e6od7">' +
    '  <textarea name="search" data-rect="100,600,800,40" placeholder="Message DeepSeek"></textarea>' +
    '  <input type="file" accept=".pdf,.png,.jpg" multiple>' +
    '  <button type="button">Отправить</button>' +
    '</form>'
  );
  const d = diagOf(env);
  check('поле ввода найдено', d.input.found === true, d.input);
  check('это TEXTAREA, а не contenteditable', d.input.tag === 'TEXTAREA', d.input);
  check('name = search', d.input.name === 'search', d.input);
  check('isContentEditable = false (DeepSeek не contenteditable)', d.input.isContentEditable === false, d.input);
  check('найден скрытый input[type=file]', d.fileInputs === 1, d);
}

console.log("\n[2] Ловушка DeepSeek: textarea[name=\"user query\"] игнорируется");
{
  const env = makeDom(
    '<textarea name="user query" data-rect="100,100,800,40"></textarea>' +
    '<form><textarea name="search" data-rect="100,600,800,40"></textarea>' +
    '<input type="file" accept=".png" multiple></form>'
  );
  const d = diagOf(env);
  check('выбран композер, а не поле правки', d.input.name === 'search', d.input);
  check('bottom = 640 (нижнее поле)', d.input.bottom === 640, d.input);
}

console.log('\n[3] Несколько contenteditable: выбирается самое нижнее');
{
  const env = makeDom(
    '<div contenteditable="true" data-rect="100,100,400,30">верхний редактор</div>' +
    '<div contenteditable="true" data-rect="100,500,800,40">средний</div>' +
    '<div contenteditable="true" data-rect="100,700,800,60">нижний композер</div>'
  );
  const d = diagOf(env);
  check('поле найдено', d.input.found === true, d.input);
  check('выбран самый нижний (bottom=760)', d.input.bottom === 760, d.input);
}

console.log("\n[4] В одной нижней полосе выбирается самый большой элемент");
{
  const env = makeDom(
    '<div contenteditable="true" data-rect="100,700,100,40">маленький</div>' +
    '<div contenteditable="true" data-rect="100,690,800,60">большой композер</div>'
  );
  const d = diagOf(env);
  check('выбран широкий композер (width=800)', d.input.width === 800, d.input);
}

console.log('\n[5] Активное поле пользователя не перебивается');
{
  const env = makeDom(
    '<form><textarea name="search" data-rect="100,600,800,40"></textarea>' +
    '<input type="file" accept=".png" multiple></form>' +
    '<div contenteditable="true" data-rect="100,700,800,40">другой редактор ниже</div>'
  );
  env.window.document.querySelector('textarea[name="search"]').focus();
  const d = diagOf(env);
  check('остался на активном textarea', d.input.tag === 'TEXTAREA', d.input);
}

console.log('\n[6] Нет поля ввода — честный тост, без ложного "вставлено"');
{
  const env = makeDom('<div data-rect="0,0,900,300">страница без композера</div>');
  const d = diagOf(env);
  check('поле не найдено', d.input.found === false, d.input);
  check('file input не найдено', d.fileInputs === 0, d);
  const ok = await env.window.__axDiag.insertView({ data_url: PNG_DATA_URL, mime: 'image/png', size: 68, path: 'a.png' });
  check('вставка вернула false', ok === false);
  check('тост НЕ содержит "вставлена в чат"', !/вставлена в чат/i.test(lastToast(env)), lastToast(env));
}

console.log('\n[7] DeepSeek: картинка реально доходит до скрытого input[type=file]');
{
  const env = makeDom(
    '<form id="composer">' +
    '  <textarea name="search" data-rect="100,600,800,40"></textarea>' +
    '  <input type="file" id="uploader" accept=".pdf,.png,.jpg" multiple>' +
    '</form>'
  );
  const { window } = env;
  const fi = window.document.getElementById('uploader');
  const seen = { changes: 0, inputs: 0, name: null, type: null, size: 0 };
  fi.addEventListener('change', () => {
    seen.changes++;
    if (fi.files && fi.files[0]) { seen.name = fi.files[0].name; seen.type = fi.files[0].type; seen.size = fi.files[0].size; }
    // Имитируем реакцию сайта: чат рисует чип превью
    const chip = window.document.createElement('div');
    chip.className = 'attachment-chip';
    window.document.getElementById('composer').appendChild(chip);
  });
  fi.addEventListener('input', () => { seen.inputs++; });

  const ok = await window.__axDiag.insertView({
    data_url: PNG_DATA_URL, mime: 'image/png', size: 68, path: 'C:\\Users\\me\\screen.png',
  });
  check('вставка вернула true', ok === true);
  check('событие change отправлено ровно один раз', seen.changes === 1, seen);
  check('input тоже отправлен (React читает change)', seen.inputs === 1, seen);
  check('имя файла = screen.png', seen.name === 'screen.png', seen);
  check('mime = image/png', seen.type === 'image/png', seen);
  check('размер файла > 0', seen.size > 0, seen);
  check('в DOM появился чип превью', !!window.document.querySelector('.attachment-chip'));
  check('тост сообщает о вставке', /вставлена в чат/i.test(lastToast(env)), lastToast(env));
}

console.log("\n[8] Нормализация mime: 'image/svg+xml' -> файл logo.svg");
{
  const env = makeDom(
    '<form id="composer"><textarea name="search" data-rect="100,600,800,40"></textarea>' +
    '<input type="file" id="uploader" accept=".png,.jpg,.svg" multiple></form>'
  );
  const { window } = env;
  const fi = window.document.getElementById('uploader');
  let got = null;
  fi.addEventListener('change', () => { if (fi.files && fi.files[0]) got = { name: fi.files[0].name, type: fi.files[0].type }; });
  const svgUrl = 'data:image/svg+xml;base64,' +
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>').toString('base64');
  await window.__axDiag.insertView({ data_url: svgUrl, mime: 'image/svg+xml', size: 60, path: 'logo.svg' });
  check('файл назван logo.svg, а не logo.image.svg+xml', got && got.name === 'logo.svg', got);
  check('mime сохранён как image/svg+xml', got && got.type === 'image/svg+xml', got);
}

console.log('\n[9] jpeg -> .jpg (DeepSeek ждёт расширения в accept)');
{
  const env = makeDom(
    '<form id="composer"><textarea name="search" data-rect="100,600,800,40"></textarea>' +
    '<input type="file" id="uploader" accept=".jpg" multiple></form>'
  );
  const { window } = env;
  const fi = window.document.getElementById('uploader');
  let gotName = null;
  fi.addEventListener('change', () => { if (fi.files && fi.files[0]) gotName = fi.files[0].name; });
  const jpgUrl = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  await window.__axDiag.insertView({ data_url: jpgUrl, mime: 'image/jpeg', size: 4, path: 'photo.jpeg' });
  check('имя оканчивается на .jpg', gotName && /\.jpg$/.test(gotName), gotName);
  check('нет ".image." в имени', gotName && !gotName.includes('.image.'), gotName);
}

console.log('\n[10] Contenteditable без file-input и без onPaste: вставка честно проваливается');
{
  const env = makeDom(
    '<div class="composer"><div contenteditable="true" role="textbox" class="ProseMirror" data-rect="100,600,800,40"></div></div>'
  );
  const { window } = env;
  const ok = await window.__axDiag.insertView({
    data_url: PNG_DATA_URL, mime: 'image/png', size: 68, path: 'shot.png',
  });
  check('вставка НЕ объявлена успешной', ok === false, ok);
  check('тост не содержит "вставлена в чат"', !/вставлена в чат/i.test(lastToast(env)), lastToast(env));
  check('тост предлагает ручной вариант', /Ctrl\+V|вручную/i.test(lastToast(env)), lastToast(env));
}

console.log('\n[11] Contenteditable с onPaste-обработчиком: paste-путь работает');
{
  const env = makeDom(
    '<div class="composer"><div contenteditable="true" data-rect="100,600,800,40"></div></div>'
  );
  const { window } = env;
  const ce = window.document.querySelector('[contenteditable="true"]');
  ce.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt || !dt.items || !dt.items.length) return;
    const chip = window.document.createElement('div');
    chip.className = 'attachment-chip';
    chip.textContent = dt.items[0].name;
    ce.parentElement.appendChild(chip);
    e.preventDefault();
  });
  const ok = await window.__axDiag.insertView({
    data_url: PNG_DATA_URL, mime: 'image/png', size: 68, path: 'shot.png',
  });
  check('вставка вернула true', ok === true, ok);
  const chip = window.document.querySelector('.attachment-chip');
  check('сайт получил файл с правильным именем', !!chip && chip.textContent === 'shot.png', chip && chip.textContent);
}

console.log('\n[12] Повторный вызов: lastViewData и ретрай');
{
  const env = makeDom(
    '<form id="composer"><textarea name="search" data-rect="100,600,800,40"></textarea>' +
    '<input type="file" id="uploader" accept=".png" multiple></form>'
  );
  const { window } = env;
  const fi = window.document.getElementById('uploader');
  let count = 0;
  fi.addEventListener('change', () => { count++; });

  const r1 = await window.__axDiag.retryView();
  check('retryView без предыдущей картинки = false', r1 === false);

  await window.__axDiag.insertView({ data_url: PNG_DATA_URL, mime: 'image/png', size: 68, path: 'a.png' });
  check('первая вставка дошла до file-input', count === 1, count);
  const r2 = await window.__axDiag.retryView();
  check('retryView повторяет вставку', count === 2, count);
  check('retryView вернул true', r2 === true, r2);
}

console.log('\n[13] Arena: ProseMirror contenteditable c role="textbox"');
{
  const env = makeDom(
    // Arena/lmarena: редактор — contenteditable с role=textbox (ProseMirror),
    // плюс присутствуют посты с contenteditable=false (перехватывать нельзя)
    '<div class="message" contenteditable="false" data-rect="0,0,800,100">ответ модели</div>' +
    '<div class="input-area">' +
    '  <div contenteditable="true" role="textbox" class="ProseMirror" ' +
    '       data-placeholder="Ask anything..." data-rect="0,700,1200,60"></div>' +
    '</div>',
    { url: 'https://lmarena.ai/' }
  );
  const d = diagOf(env);
  check('поле найдено', d.input.found === true, d.input);
  check('это DIV (contenteditable)', d.input.tag === 'DIV', d.input);
  check('isContentEditable = true', d.input.isContentEditable === true, d.input);
  check('выбран композер, а не contenteditable=false', d.input.bottom === 760, d.input);
  check('class = ProseMirror', /ProseMirror/.test(d.input.className), d.input);
}

console.log('\n[14] Arena: два contenteditable (правка поста + композер) — берём нижний');
{
  const env = makeDom(
    '<div contenteditable="true" role="textbox" data-rect="0,100,800,40">правка сообщения</div>' +
    '<div contenteditable="true" role="textbox" class="ProseMirror" data-rect="0,700,1200,60">композер</div>',
    { url: 'https://arena.ai/' }
  );
  const d = diagOf(env);
  check('выбран нижний композер (bottom=760)', d.input.bottom === 760, d.input);
  check('width = 1200 (широкий композер)', d.input.width === 1200, d.input);
}

console.log('\n[15] Arena: картинка уходит в paste-путь (onPaste с файлами)');
{
  const env = makeDom(
    '<div class="input-area"><div contenteditable="true" role="textbox" class="ProseMirror" ' +
    'data-rect="0,700,1200,60"></div></div>',
    { url: 'https://lmarena.ai/' }
  );
  const { window } = env;
  const ce = window.document.querySelector('.ProseMirror');
  ce.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt || !dt.items || !dt.items.length) return;
    const chip = window.document.createElement('div');
    chip.className = 'attachment-chip';
    ce.parentElement.appendChild(chip);
    e.preventDefault();
  });
  const ok = await window.__axDiag.insertView({
    data_url: PNG_DATA_URL, mime: 'image/png', size: 68, path: 'arena.png',
  });
  check('вставка вернула true', ok === true, ok);
  check('чип превью появился', !!window.document.querySelector('.attachment-chip'));
  check('тост сообщает о вставке', /вставлена в чат/i.test(lastToast(env)), lastToast(env));
}

console.log('\n' + '='.repeat(54));
console.log('Итог: ' + passed + ' ok, ' + failed + ' fail');
if (failed) {
  console.log('\nПровалы:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('Все проверки прошли.');
// content.js поднимает setInterval(checkServer, 30000) — закрываем окна jsdom
// и завершаем процесс явно, иначе node не выйдет.
for (const env of createdEnvs) { try { env.window.close(); } catch {} }
process.exit(0);
})().catch((e) => { console.error('Тесты упали с ошибкой:', e); process.exit(1); });