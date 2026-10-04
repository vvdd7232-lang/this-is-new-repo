/* Тесты дизайн-системы: интерфейс собирается из ax-ui.css, а не из «магических»
 * цветов, и все поверхности (панель, страница настроек, попап) действительно
 * подключают токены.
 *
 * Зачем: редизайн легко «разъезжается» — кто-то поправит content.css и забудет
 * про ax-ui.css, или добавит в разметку цвет мимо переменных, и тёмная тема
 * сломается. Эти проверки дешёвые и ловят именно такие расхождения.
 *
 * Запуск:  cd tests && npm test
 */
'use strict';

const fs = require('fs');
const path = require('path');

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

const ui = read('ax-ui.css');
const content = read('content.css');
const optionsHtml = read('options.html');
const popupHtml = read('popup.html');
const panelJs = read('ax-panel.js');
const coreJs = read('ax-core.js');
const manifest = JSON.parse(read('manifest.json'));
const manifestChrome = JSON.parse(read('manifest.chrome.json'));
// Комментарии не должны влиять на проверки: иначе упоминание «PANEL_THEME_VARS»
// в объясняющем комментарии выдаёт себя за остатки удалённого кода.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const uiCode = stripComments(ui);
const coreCode = stripComments(coreJs);

console.log('\n[1] Токены дизайн-системы объявлены');
const tokens = ['--ax-accent', '--ax-surface', '--ax-text', '--ax-border', '--ax-r-md',
  '--ax-success', '--ax-danger', '--ax-warn', '--ax-font', '--ax-font-mono', '--ax-shadow-1', '--ax-ease',
  '--ax-on-accent', '--ax-knob'];
for (const t of tokens) {
  check('токен ' + t, ui.includes(t + ':'));
}
check('есть тёмная тема через data-ax-theme', ui.includes('[data-ax-theme="dark"]'));
check('есть авто-тема по prefers-color-scheme', ui.includes('prefers-color-scheme: dark'));

console.log('\n[2] Каждая переменная, используемая в content.css, объявлена в дизайн-системе');
const used = new Set();
for (const m of content.matchAll(/var\((--ax-[a-z0-9-]+)/g)) used.add(m[1]);
const declared = new Set();
for (const m of ui.matchAll(/(--ax-[a-z0-9-]+)\s*:/g)) declared.add(m[1]);
const missing = [...used].filter((v) => !declared.has(v));
check('нет «висячих» переменных', missing.length === 0, missing);
check('content.css реально использует токены (не хардкод)', used.size >= 20, used.size);

console.log('\n[3] Страницы расширения подключают дизайн-систему');
for (const [name, html] of [['options.html', optionsHtml], ['popup.html', popupHtml]]) {
  check(name + ': подключён ax-ui.css', /<link rel="stylesheet" href="ax-ui\.css">/.test(html));
  check(name + ': есть класс ax-ui для базовых стилей', /<body class="ax-ui/.test(html));
  check(name + ': используется var(--ax-…) в собственных стилях', /var\(--ax-/.test(html));
  check(name + ': нет «жёстких» hex-цветов в разметке стилей',
    !/(color|background)\s*:\s*#[0-9a-f]{3,6}\s*;/i.test(html), 'найден hex в inline-стилях');
}

console.log('\n[4] Панель и модалка получают токены из shadow root');
check('ax-panel.js импортирует ax-ui.css', /getURL\('ax-ui\.css'\)/.test(panelJs));
check('ax-panel.js импортирует content.css', /getURL\('content\.css'\)/.test(panelJs));
check('есть программные иконки (без эмодзи в кнопках)', /AX\.icon = function/.test(panelJs) && /ICON_PATHS/.test(panelJs));
check('applyPanelAppearance ставит data-ax-theme на хосте', /setAttribute\('data-ax-theme'/.test(coreCode));
// Токены обязаны быть объявлены и на :host — иначе внутри shadow root
// не работают отступы/радиусы/тени (padding: var(--ax-s-5) → 0).
const tokenBlock = uiCode.match(/:root[\s\S]*?\{[\s\S]*?\n\}/);
check('токены объявлены на :host, а не только на :root',
  /(^|,)\s*:host\s*,/.test(tokenBlock ? tokenBlock[0].slice(0, 80) : ''), tokenBlock && tokenBlock[0].slice(0, 60));
for (const group of ['radii', 'spacing', 'shadow', 'fonts']) {
  const probe = { radii: '--ax-r-lg:', spacing: '--ax-s-5:', shadow: '--ax-shadow-3:', fonts: '--ax-font-mono:' }[group];
  check('в ax-ui.css есть токены группы ' + group, uiCode.includes(probe), probe);
}
check('тёмная тема продублирована на :host для shadow root',
  /:host\(\[data-ax-theme="dark"\]\)/.test(uiCode));
check('в JS больше нет дубля токенов (источник правды — CSS)',
  !/PANEL_THEME_VARS/.test(coreCode) && !/setProperty\('--ax-/.test(coreCode));

console.log('\n[5] Манифесты отдают новые файлы контент-скрипту');
for (const [name, mf] of [['manifest.json', manifest], ['manifest.chrome.json', manifestChrome]]) {
  const res = (mf.web_accessible_resources && mf.web_accessible_resources[0] &&
    mf.web_accessible_resources[0].resources) || [];
  check(name + ': ax-ui.css доступен', res.includes('ax-ui.css'), res);
  check(name + ': content.css доступен', res.includes('content.css'), res);
}

console.log('\n[6] Контракт классов, на который завязан JS, не переименован');
const contractClasses = ['.ax-exec-panel', '.ax-exec-header', '.ax-exec-badge', '.ax-btn-run', '.ax-btn-copy',
  '.ax-exec-status', '.ax-exec-output', '.ax-exec-after', '.ax-exec-cmd-preview', '.ax-runner-select',
  '.ax-modal', '.ax-modal-backdrop', '.ax-modal-row', '.ax-btn-confirm', '.ax-btn-cancel', '.ax-toast',
  '#ax-server-dot', '.ax-view-wrap', '.ax-view-img', '.ax-view-meta'];
// Базовые кнопки описаны в дизайн-системе, остальное — в стилях контент-скрипта.
const allCss = ui + '\n' + content;
for (const cls of contractClasses) {
  check('стиль для ' + cls, allCss.includes(cls));
}

console.log('\n[7] Доступность и мелочи премиального уровня');
check('есть видимый фокус (:focus-visible)', ui.includes(':focus-visible') && content.includes(':focus-visible'));
check('анимации уважают prefers-reduced-motion', content.includes('prefers-reduced-motion'));
check('статус панели использует цветной индикатор, а не только текст', content.includes('.ax-exec-status::before'));
check('превью команды доступно с клавиатуры (tabindex/role)', /role="button" tabindex="0"/.test(panelJs));
check('сегмент-контрол в настройках — настоящие кнопки', /data-v="(light|dark|auto)"/.test(optionsHtml));
check('переключатели в попапе — label+checkbox (клик по всей строке)',
  /<label class="check" for="requireConfirm">/.test(popupHtml));

console.log('\n======================================================');
console.log('Итог: ' + passed + ' ok, ' + failed + ' fail');
if (failed) {
  console.log('Провалы:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('Все проверки прошли.');
