const axApi = typeof browser !== 'undefined' ? browser : chrome;

async function axStorageGet(area, keys) {
  if (typeof browser !== 'undefined' && browser.storage && browser.storage[area]) {
    return await browser.storage[area].get(keys);
  }
  return new Promise((resolve) => {
    chrome.storage[area].get(keys, (res) => resolve(res || {}));
  });
}

async function axStorageSet(area, items) {
  if (typeof browser !== 'undefined' && browser.storage && browser.storage[area]) {
    return await browser.storage[area].set(items);
  }
  return new Promise((resolve) => {
    chrome.storage[area].set(items, () => resolve());
  });
}

async function axStorageRemove(area, keys) {
  if (typeof browser !== 'undefined' && browser.storage && browser.storage[area]) {
    return await browser.storage[area].remove(keys);
  }
  return new Promise((resolve) => {
    chrome.storage[area].remove(keys, () => resolve());
  });
}
// Страница настроек AI Execute Runner (все параметры в одном месте)

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8765',
  timeout: 30,
  requireConfirm: true,
  autoExecute: false,
  autoInsert: false,
  autoSend: false,
  autoDelay: 3,
  maxAutoRuns: 0,
  autoWeak: false,
  defaultRunner: 'shell',
  looseSearch: true,
  maxOutputChars: 32000,
  showToasts: true,
  defaultCwd: '',
  authToken: '',
  uiTheme: 'auto',
  panelSize: 'normal',
  collapseAfterRun: false,
  soundOnComplete: false,
  browserNotify: false,
  echoMode: 'short',
  previewLines: 12,
    paletteEnabled: true,
    catMode: false,
  noisyCollapse: true,
  // MCP — экспериментальная функция, поэтому выключена по умолчанию.
  mcpEnabled: false,
  // Внешний вид (экспериментально)
  uiPalette: 'indigo',
  uiRadius: 'soft',
  uiBtnStyle: 'soft',
  uiDensity: 'normal',
};

const $ = (id) => document.getElementById(id);
let loaded = false; // save блокируется, пока настройки не прочитаны

function statusMsg(text, kind) {
  const el = $('status');
  // «Липкое» сообщение (например, о повреждённой ссылке настройки) не должно
  // затираться служебными статусами — иначе пользователь не увидит проблему.
  // Снимается явным действием пользователя: save/testConnection/reset/export.
  if (el.dataset && el.dataset.sticky === '1') return;
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

function clearSticky() {
  const el = $('status');
  if (el && el.dataset) el.dataset.sticky = '';
}

function updateWarn() {
  $('autoWarn').style.display = $('autoExecute').checked ? 'block' : 'none';
}

function clampNum(v, lo, hi, fb) {
  v = parseInt(v, 10);
  if (!Number.isFinite(v)) return fb;
  return Math.max(lo, Math.min(hi, v));
}

async function load() {
  let d;
  try {
    d = await axStorageGet('sync', Object.keys(DEFAULTS));
  } catch {
    statusMsg('❌ Не удалось прочитать настройки (расширение обновляется? закрой страницу и открой заново)', 'err');
    return;
  }
  $('serverUrl').value = d.serverUrl || DEFAULTS.serverUrl;
  $('timeout').value = d.timeout != null ? d.timeout : DEFAULTS.timeout;
  $('requireConfirm').checked = d.requireConfirm !== false;
  $('autoExecute').checked = d.autoExecute === true;
  $('autoInsert').checked = d.autoInsert === true;
  $('autoSend').checked = d.autoSend === true;
  $('autoDelay').value = d.autoDelay != null ? d.autoDelay : DEFAULTS.autoDelay;
  $('maxAutoRuns').value = d.maxAutoRuns != null ? d.maxAutoRuns : DEFAULTS.maxAutoRuns;
  $('autoWeak').checked = d.autoWeak === true;
  $('defaultRunner').value = d.defaultRunner || DEFAULTS.defaultRunner;
  $('looseSearch').checked = d.looseSearch !== false;
  $('maxOutputChars').value = d.maxOutputChars != null ? d.maxOutputChars : DEFAULTS.maxOutputChars;
  $('showToasts').checked = d.showToasts !== false;
  $('defaultCwd').value = d.defaultCwd || '';
  setSeg('uiTheme', d.uiTheme || 'auto');
  setSeg('panelSize', d.panelSize || 'normal');
  $('collapseAfterRun').checked = d.collapseAfterRun === true;
  $('soundOnComplete').checked = d.soundOnComplete === true;
  $('catMode').checked = d.catMode === true;
  $('browserNotify').checked = d.browserNotify === true;
  setSeg('echoMode', d.echoMode || 'short');
  setSeg('uiPalette', d.uiPalette || 'indigo');
  setSeg('uiRadius', d.uiRadius || 'soft');
  setSeg('uiBtnStyle', d.uiBtnStyle || 'soft');
  setSeg('uiDensity', d.uiDensity || 'normal');
  applyUiTuningToHtml(d);
  $('previewLines').value = d.previewLines != null ? d.previewLines : DEFAULTS.previewLines;
  $('noisyCollapse').checked = d.noisyCollapse !== false;
  $('mcpEnabled').checked = d.mcpEnabled === true;   // opt-in: включается только явно
  updateMcpBox();
  applyTheme(d.uiTheme || 'auto');
  updateWarn();
  try {
    const v = 'v' + axApi.runtime.getManifest().version;
    $('ver').textContent = v;
    $('ver2').textContent = v;
  } catch {}
  loaded = true;
  try {
    const h = await axStorageGet('local', ['axExecutedHistory']);
    const n = h && h.axExecutedHistory ? Object.keys(h.axExecutedHistory).length : 0;
    $('histCount').textContent = n;
  } catch {}
  statusMsg('Настройки загружены. Меняй и жми «Сохранить».', '');
  try { await showJournalCount(); } catch (e) { /* ignore */ }
  try { await renderStats(); } catch (e) { /* ignore */ }
  try { await renderProfiles(); } catch (e) { /* ignore */ }
  // Сигнал для обработчика ссылки #ax-setup=: поля уже заполнены из storage,
  // можно безопасно применять значения из ссылки.
  try { document.dispatchEvent(new Event('ax-settings-loaded')); } catch (e) { /* ignore */ }
  try { await testConnection(); } catch (e) {}
}

function updateWhitelistInfo(info) {
  const el = document.getElementById('whitelistInfo');
  if (!el) return;
  if (!info) { el.textContent = 'Проверка не выполнена.'; return; }
  if (info.whitelist_on) {
    el.textContent = '\u2705 Whitelist включён: ' + info.whitelist_size + ' префиксов. Автопилот ограничен списком.';
    el.style.color = '';
  } else {
    el.textContent = '\u26a0\ufe0f Whitelist выключен. Все команды (кроме явно опасных) проходят. Рекомендуется: --whitelist whitelist.txt';
    el.style.color = '#b45309';
  }
}


// --- UI helpers ---

function setSeg(id, value) {
  const seg = document.getElementById(id);
  if (!seg) return;
  seg.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === value);
  });
  seg._value = value;
}

function getSeg(id) {
  const seg = document.getElementById(id);
  if (!seg) return null;
  const on = seg.querySelector('button.on');
  return on ? on.dataset.v : (seg._value || null);
}

function applyTheme(theme) {
  const html = document.documentElement;
  // Дизайн-система (ax-ui.css) читает тему из data-ax-theme на <html>.
  if (!theme || theme === 'auto') html.removeAttribute('data-ax-theme');
  else html.setAttribute('data-ax-theme', theme);
  // Запоминаем выбор, чтобы страница не «мигала» светлым при следующем открытии
  // (ранний инлайн-скрипт в options.html читает это значение до отрисовки).
  try {
    if (!theme || theme === 'auto') localStorage.removeItem('axOptionsTheme');
    else localStorage.setItem('axOptionsTheme', theme);
  } catch (e) { /* приватный режим — не критично */ }
}

function markDirty() {
  const d = document.getElementById('dirtyDot');
  if (d) d.classList.add('on');
}

function clearDirty() {
  const d = document.getElementById('dirtyDot');
  if (d) d.classList.remove('on');
}

function bindSeg(id, onChange) {
  const seg = document.getElementById(id);
  if (!seg) return;
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset.v) return;
    setSeg(id, btn.dataset.v);
    if (onChange) onChange(btn.dataset.v);
    markDirty();
  });
}

// ---------- оформление (палитра, скругление, кнопки, плотность) ----------
// Здесь ax-core.js нет (он грузится только в content-script), поэтому список
// допустимых значений продублирован. Расхождение ловит тест согласованности.
const UI_PALETTES = ['indigo', 'ocean', 'emerald', 'sunset', 'amethyst'];
const UI_RADII = ['none', 'sharp', 'soft', 'round', 'pill'];
const UI_BTN_STYLES = ['soft', 'solid', 'outline', 'flat', 'tile'];
const UI_DENSITIES = ['compact', 'normal', 'spacious'];
const UI_TUNING = [
  { key: 'uiPalette', attr: 'data-ax-palette', allowed: UI_PALETTES, def: 'indigo' },
  { key: 'uiRadius', attr: 'data-ax-radius', allowed: UI_RADII, def: 'soft' },
  { key: 'uiBtnStyle', attr: 'data-ax-btn', allowed: UI_BTN_STYLES, def: 'soft' },
  { key: 'uiDensity', attr: 'data-ax-density', allowed: UI_DENSITIES, def: 'normal' },
];

// Ставит атрибуты на <html>, чтобы страница настроек сразу показывала выбранное.
function applyUiTuningToHtml(values) {
  const html = document.documentElement;
  const v = values || {};
  UI_TUNING.forEach((t) => {
    let val = v[t.key];
    if (t.allowed.indexOf(val) === -1) val = t.def;
    if (val && val !== t.def) html.setAttribute(t.attr, val);
    else html.removeAttribute(t.attr);
  });
  // Кото-тема — не выбор из списка, поэтому отдельно: атрибут на <html>
  // даёт живое превью ушек/лапок прямо на странице настроек.
  const cat = ('catMode' in v) ? v.catMode === true
    : ($('catMode') ? $('catMode').checked : false);
  if (cat) html.setAttribute('data-ax-cat', 'on');
  else html.removeAttribute('data-ax-cat');
}

function initUiTuning() {
  UI_TUNING.forEach((t) => {
    bindSeg(t.key, () => applyUiTuningToHtml(readUiTuning()));
  });
  // Палитра — такие же кнопки с data-v, но подсветка своя.
  bindSeg('uiPalette', () => applyUiTuningToHtml(readUiTuning()));
  // Кото-тема — это чекбокс, а не сегмент: обновляем превью сразу.
  const catToggle = $('catMode');
  if (catToggle) catToggle.addEventListener('change', () => applyUiTuningToHtml(readUiTuning()));
  const moreBtn = $('uiMoreBtn');
  const more = $('uiMore');
  if (moreBtn && more) {
    moreBtn.addEventListener('click', () => {
      const show = more.hidden;
      more.hidden = !show;
      moreBtn.setAttribute('aria-expanded', String(show));
      moreBtn.classList.toggle('on', show);
    });
  }
  const reset = $('uiMoreReset');
  if (reset) {
    reset.addEventListener('click', async () => {
      await axStorageSet('sync', { uiPalette: 'indigo', uiRadius: 'soft', uiBtnStyle: 'soft', uiDensity: 'normal' });
      applyUiTuningToHtml(readUiTuning());
      await load();
      statusMsg('🎨 Оформление сброшено к умолчанию', 'ok');
      clearDirty();
    });
  }
}

// Текущие значения оформления из формы (без чтения storage — оттуда lag при клике).
function readUiTuning() {
  return {
    uiPalette: getSeg('uiPalette') || 'indigo',
    uiRadius: getSeg('uiRadius') || 'soft',
    uiBtnStyle: getSeg('uiBtnStyle') || 'soft',
    uiDensity: getSeg('uiDensity') || 'normal',
    catMode: $('catMode') ? $('catMode').checked : false,
  };
}

async function exportSettings() {
  clearSticky();
  try {
    const all = await axStorageGet('sync', Object.keys(DEFAULTS));
    // Токен не выгружаем в файл: он может уехать в облако/тикет вместе с бэкапом.
    delete all.authToken;
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ai-execute-settings.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    statusMsg('Экспортировано', 'ok');
  } catch (e) { statusMsg('Ошибка экспорта: ' + e, 'err'); }
}

async function importSettings(file) {
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    const clean = {};
    let importedToken = null;
    for (const k of Object.keys(DEFAULTS)) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      // Токен — секрет: он не в sync, а в local (см. background.js).
      if (k === 'authToken') { importedToken = String(obj[k] || ''); continue; }
      clean[k] = obj[k];
    }
    await axStorageSet('sync', clean);
    if (importedToken !== null) await axStorageSet('local', { authToken: importedToken });
    // Импортированные значения должны попасть в поля формы, а не только в storage.
    await load();
    statusMsg('Импортировано', 'ok');
    clearDirty();
  } catch (e) { statusMsg('Ошибка импорта: ' + e, 'err'); }
}

// --- Init UI (сегменты, экспорт/импорт, dirty, поиск) ---
// ВАЖНО: этот блок обязан быть на верхнем уровне. Раньше он случайно оказался
// внутри importSettings() (осиротевший `await` на предыдущей строке съедал
// остаток функции), из-за чего кнопки Экспорт/Импорт, сегменты темы/размера/
// эхо и индикатор несохранённых изменений не подключались вообще.
bindSeg('uiTheme', (v) => applyTheme(v));
bindSeg('panelSize');
bindSeg('echoMode');
// Палитра, скругление, стиль кнопок, плотность + кнопка «Все настройки».
try { initUiTuning(); } catch (e) { console.warn('[AX] ui tuning:', e); }

const _expBtn = document.getElementById('exportBtn');
if (_expBtn) _expBtn.onclick = exportSettings;
const _impBtn = document.getElementById('importBtn');
const _impFile = document.getElementById('importFile');
if (_impBtn && _impFile) {
  _impBtn.onclick = () => _impFile.click();
  _impFile.onchange = (e) => { if (e.target.files[0]) importSettings(e.target.files[0]); };
}
document.addEventListener('input', (e) => {
  if (e.target && e.target.id !== 'importFile') markDirty();
});
document.addEventListener('change', (e) => {
  if (e.target && e.target.id !== 'importFile') markDirty();
  // MCP: переключатель только показывает/скрывает блок, реальное включение
  // происходит по «Сохранить всё» — как и все остальные настройки.
  if (e.target && e.target.id === 'mcpEnabled' && e.target.checked) {
    mcpLoadStatus();
  }
});

// Слушатели секции MCP (экспериментально). Проверки на null нужны: на старых
// страницах/в тестах разметки может не быть — тогда расширение не должно падать.
(function initMcpUi() {
  const reload = $('mcpReload');
  const refresh = $('mcpRefresh');
  const report = $('mcpReport');
  const reportSave = $('mcpReportSave');
  if (reload) reload.addEventListener('click', () => mcpReloadConfig());
  if (refresh) refresh.addEventListener('click', () => mcpLoadTools());
  if (report) report.addEventListener('click', () => mcpReport(false));
  if (reportSave) reportSave.addEventListener('click', () => mcpReport(true));
})();

// Поиск по настройкам + навигация по разделам + горячие клавиши.
// Поле #settingsSearch и боковое меню .sidenav были в разметке, но ни к чему не
// подключены: поиск отфильтровывает карточки, навигация подсвечивает текущий
// раздел, а Ctrl+S / «/» убирают лишние движения мышью.
(function initSettingsUI() {
  const box = document.getElementById('settingsSearch');
  const cards = Array.prototype.slice.call(document.querySelectorAll('details.card'));
  const empty = document.getElementById('searchEmpty');
  const navLinks = Array.prototype.slice.call(document.querySelectorAll('.sidenav a[data-nav]'));
  const content = document.querySelector('.content');

  // --- поиск ---
  const applySearch = () => {
    const q = box ? (box.value || '').trim().toLowerCase() : '';
    let visible = 0;
    for (const card of cards) {
      const hit = !q || (card.textContent || '').toLowerCase().indexOf(q) !== -1;
      card.style.display = hit ? '' : 'none';
      if (hit) {
        visible++;
        if (q) card.open = true;
      }
    }
    if (empty) empty.classList.toggle('on', !!q && visible === 0);
    if (content) content.classList.toggle('searching', !!q);
    // В режиме поиска боковое меню только мешает — прячем ссылки без совпадений
    for (const link of navLinks) {
      const card = document.getElementById(link.dataset.nav);
      const hit = !q || !card || card.style.display !== 'none';
      link.style.display = hit ? '' : 'none';
    }
  };
  if (box) {
    box.addEventListener('input', applySearch);
    box.addEventListener('search', applySearch);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { box.value = ''; applySearch(); box.blur(); }
    });
  }

  // --- подсветка активного раздела при прокрутке ---
  if (navLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map();
    for (const link of navLinks) byId.set(link.dataset.nav, link);
    const setActive = (id) => {
      for (const link of navLinks) link.classList.toggle('on', link.dataset.nav === id);
    };
    const io = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((en) => en.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length) setActive(visible[0].target.id);
    }, { rootMargin: '-84px 0px -60% 0px', threshold: 0 });
    for (const card of cards) io.observe(card);
    // Клик по ссылке — сразу подсветить (плавная прокрутка средствами CSS)
    for (const link of navLinks) {
      link.addEventListener('click', () => setActive(link.dataset.nav));
    }
  }

  // --- горячие клавиши ---
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      save();
      return;
    }
    if (e.key === '/' && !typing) {
      e.preventDefault();
      if (box) box.focus();
    }
  });

  // Плавная прокрутка к разделам (учитывая высоту липкой шапки — через scroll-margin)
  document.documentElement.style.scrollBehavior = 'smooth';
  applySearch();
})();

// --- Онбординг: приём настроек по ссылке от сервера -------------------------
// `python server.py` печатает готовую ссылку вида
//   chrome-extension://<id>/options.html#ax-setup=<base64url(url + токен)>
// Это убирает ручное копирование адреса и токена — самая частая причина
// «бейдж offline / 401 invalid token» на первом запуске.
// Ссылку обрабатываем только при явном #ax-setup= и сразу вычищаем из адреса,
// чтобы токен не оставался в истории и не попал в скриншот.
(function initSetupLink() {
  const hash = String(location.hash || '');
  if (hash.indexOf('ax-setup=') === -1) return;

  let payload = null;
  try {
    const raw = hash.slice(hash.indexOf('ax-setup=') + 'ax-setup='.length);
    // base64url → base64, добавляем padding, декодируем как UTF-8
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    payload = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch (e) {
    // Сообщение показываем после load(): иначе его затрёт проверка связи.
    // Помечаем «липким», чтобы последующий statusMsg без вида его не сбил.
    const warn = () => {
      statusMsg('Ссылка настройки повреждена — настрой сервер вручную', 'err');
      const el = $('status');
      if (el.dataset) el.dataset.sticky = '1';
    };
    document.addEventListener('ax-settings-loaded', warn, { once: true });
    if (loaded) warn();
    return;
  }

  // Гигиена: убираем токен из адресной строки
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }

  const apply = async () => {
    const patch = {};
    if (payload && typeof payload.url === 'string' && /^https?:\/\//i.test(payload.url)) patch.serverUrl = payload.url;
    if (payload && typeof payload.token === 'string' && payload.token) patch.authToken = payload.token;
    if (!Object.keys(patch).length) return;

    if (patch.serverUrl) {
      $('serverUrl').value = patch.serverUrl;
      await axStorageSet('sync', { serverUrl: patch.serverUrl });
    }
    // Токен из ссылки кладём сразу в storage.local и нигде не показываем:
    // пользователю не нужно ни видеть его, ни вводить руками.
    if (patch.authToken) {
      await axStorageSet('local', { authToken: patch.authToken });
      try { await axStorageRemove('sync', ['authToken']); } catch (e) { /* старые версии */ }
    }
    statusMsg('✅ Настройки применены из ссылки сервера — проверяю связь…', 'ok');
    clearDirty();
    await testConnection();
  };

  // Порядок важен: load() асинхронный и при чтении storage перезаписывает поля
  // формы. Поэтому ждём события «настройки загружены» (его шлёт load()) и только
  // затем применяем значения из ссылки — иначе они будут затёрты.
  document.addEventListener('ax-settings-loaded', () => {
    apply().catch((e) => statusMsg('Не удалось применить ссылку: ' + e, 'err'));
  }, { once: true });
  if (loaded) {
    apply().catch((e) => statusMsg('Не удалось применить ссылку: ' + e, 'err'));
  }
})();

// --- Журнал выполнений ------------------------------------------------------
// Отчёт для аудита и для себя: «что вообще запускалось на этой машине».
// Данные лежат локально (axCommandLog), вывод команд не сохраняем — только
// текст команды, среду, код возврата и время.
function journalLines(entries, secrets) {
  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (t) => {
    const d = new Date(t || Date.now());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  };
  // Повторное маскирование перед выгрузкой: записи могли остаться от версии
  // расширения, которая ещё не маскировала секреты при записи.
  const safe = (v) => {
    const text = String(v == null ? '' : v);
    if (!text) return text;
    try { return AXDetector.redactSecrets(text, secrets); } catch (e) { return text; }
  };
  const list = Array.isArray(entries) ? entries : [];
  const out = [];
  out.push('# Журнал выполнений — AI Execute Runner');
  out.push('');
  out.push('Всего записей: **' + list.length + '** · выгружено: ' + fmtTime(Date.now()) +
    ' · версия расширения: ' + (() => { try { return axApi.runtime.getManifest().version; } catch (e) { return '?'; } })());
  out.push('');
  out.push('> Команды выполнялись локально на этом ПК. Вывод команд в журнал не пишется,');
  out.push('> секреты (токен доступа) в командах не сохраняются.');
  out.push('');
  if (!list.length) {
    out.push('_Записей пока нет._');
    return out.join('\n') + '\n';
  }
  out.push('| # | Когда | Среда | Код | Команда |');
  out.push('|---|-------|-------|-----|---------|');
  list.forEach((e, i) => {
    const cmd = safe(e.cmd).replace(/\|/g, '\\|').replace(/\n/g, ' ↵ ').slice(0, 200);
    const code = (typeof e.exit === 'number') ? String(e.exit) : (e.status || '');
    out.push('| ' + (i + 1) + ' | ' + fmtTime(e.t) + ' | `' + (e.runner || 'shell') + '` | ' + code + ' | `' + cmd + '` |');
  });
  out.push('');
  out.push('## Полные тексты команд');
  out.push('');
  list.forEach((e, i) => {
    out.push('### ' + (i + 1) + '. ' + fmtTime(e.t) + ' · `' + (e.runner || 'shell') + '`' +
      ((typeof e.exit === 'number') ? ' · exit=' + e.exit : ''));
    out.push('');
    const langs = { shell: 'execute', python: 'execute-python', node: 'execute-js', powershell: 'execute-pwsh' };
    out.push('```' + (langs[e.runner] || 'execute'));
    out.push(safe(e.cmd));
    out.push('```');
    out.push('');
  });
  return out.join('\n') + '\n';
}

async function exportJournal() {
  clearSticky();
  try {
    const raw = await axStorageGet('local', ['axCommandLog', 'authToken']);
    const entries = (raw && Array.isArray(raw.axCommandLog)) ? raw.axCommandLog : [];
    // Свой токен тоже маскируем: вдруг он встретится в тексте команды.
    const text = journalLines(entries, [raw && raw.authToken]);
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ai-execute-journal.md';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    statusMsg(entries.length
      ? '📋 Журнал выгружен: ' + entries.length + ' записей (ai-execute-journal.md)'
      : 'Журнал пуст — сначала выполни что-нибудь', entries.length ? 'ok' : '');
  } catch (e) {
    statusMsg('Ошибка выгрузки журнала: ' + e, 'err');
  }
}

async function showJournalCount() {
  try {
    const raw = await axStorageGet('local', ['axCommandLog']);
    const n = (raw && Array.isArray(raw.axCommandLog)) ? raw.axCommandLog.length : 0;
    const el = $('journalCount');
    if (el) el.textContent = n ? n + ' записей' : 'пусто';
  } catch (e) { /* ignore */ }
}

async function clearJournal() {
  clearSticky();
  try {
    await axStorageRemove('local', ['axCommandLog']);
    statusMsg('Журнал выполнений очищен', 'ok');
    showJournalCount();
  } catch (e) {
    statusMsg('Не удалось очистить журнал: ' + e, 'err');
  }
}

// --- Статистика и достижения -------------------------------------------------
// Счётчики лежат в storage.local (axStats), считает их контент-скрипт при
// запусках. Здесь — только отрисовка виджета и сброс. Метки достижений общие
// с контентом (AXDetector.achievementState), поэтому страница не дублирует список.
async function renderStats() {
  let stats = {};
  try {
    const raw = await axStorageGet('local', ['axStats']);
    stats = (raw && raw.axStats) || {};
  } catch (e) { /* ignore */ }
  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
  set('statRuns', stats.runs || 0);
  set('statOk', stats.ok || 0);
  set('statErr', stats.err || 0);
  set('statStreak', stats.bestStreak || 0);
  set('statViews', stats.view || 0);
  set('statDays', Object.keys(stats.days || {}).length);

  // Уровень и полоса опыта считаются из тех же счётчиков (см. AXDetector.levelFor).
  let lvl = { level: 1, into: 0, need: 100, pct: 0 };
  try { lvl = AXDetector.levelFor(stats); } catch (e) { /* ignore */ }
  const lvlNum = $('lvlNum');
  if (lvlNum) lvlNum.textContent = String(lvl.level);
  const lvlXp = $('lvlXp');
  if (lvlXp) lvlXp.textContent = lvl.into + ' / ' + lvl.need + ' XP';
  const lvlBar = $('lvlBar');
  if (lvlBar) lvlBar.style.width = lvl.pct + '%';

  const grid = $('achGrid');
  if (!grid) return;
  grid.textContent = '';
  let all = [];
  try { all = AXDetector.achievementState(stats); } catch (e) { all = []; }
  const opened = all.filter((a) => a.unlocked).length;
  const cnt = $('achCount');
  if (cnt) cnt.textContent = opened + ' из ' + all.length;
  all.forEach((a) => {
    const item = document.createElement('div');
    item.className = 'ax-ach-item' + (a.unlocked ? ' on' : '');
    const ico = document.createElement('span');
    ico.className = 'ax-ach-ico';
    ico.textContent = a.unlocked ? a.icon : '🔒';
    const txt = document.createElement('div');
    txt.className = 'ax-ach-txt';
    const b = document.createElement('b');
    b.textContent = a.title;
    const desc = document.createElement('i');
    desc.textContent = a.desc;
    txt.appendChild(b);
    txt.appendChild(desc);
    if (!a.unlocked && a.goal > 1) {
      const bar = document.createElement('div');
      bar.className = 'ax-ach-bar';
      const fill = document.createElement('i');
      fill.style.width = Math.min(100, Math.round(((a.have || 0) / a.goal) * 100)) + '%';
      bar.appendChild(fill);
      txt.appendChild(bar);
    }
    item.appendChild(ico);
    item.appendChild(txt);
    grid.appendChild(item);
  });
}

async function resetStats() {
  clearSticky();
  if (!confirm('Сбросить статистику и достижения?')) return;
  try {
    await axStorageRemove('local', ['axStats']);
    await renderStats();
    statusMsg('Статистика и достижения сброшены', 'ok');
  } catch (e) {
    statusMsg('Не удалось сбросить статистику: ' + e, 'err');
  }
}

// --- Экспорт журнала в PDF ---------------------------------------------------
// Печатаем отдельный HTML-документ через скрытый iframe: в системном диалоге
// печати пользователь выбирает «Сохранить как PDF». Так не нужны внешние
// PDF-библиотеки (их пришлось бы тащить в расширение и обновлять).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function journalHtml(entries, secrets) {
  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (t) => {
    const d = new Date(t || Date.now());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  };
  const safe = (v) => {
    const text = String(v == null ? '' : v);
    try { return AXDetector.redactSecrets(text, secrets); } catch (e) { return text; }
  };
  const list = Array.isArray(entries) ? entries : [];
  let ver = '?';
  try { ver = axApi.runtime.getManifest().version; } catch (e) { /* ignore */ }
  const rows = list.map((e, i) => {
    const code = (typeof e.exit === 'number') ? String(e.exit) : (e.status || '');
    return '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(fmtTime(e.t)) + '</td><td><code>' +
      escapeHtml(e.runner || 'shell') + '</code></td><td>' + escapeHtml(code) + '</td></tr>' +
      '<tr class="cmd"><td colspan="4"><code>' + escapeHtml(safe(e.cmd)) + '</code></td></tr>';
  }).join('');
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<title>Журнал выполнений — AI Execute Runner</title><style>' +
    'body{font:13px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;margin:24px;color:#181b26}' +
    'h1{font-size:19px;margin:0 0 4px}p.meta{color:#5b6172;margin:0 0 16px;font-size:12px}' +
    'table{width:100%;border-collapse:collapse;margin-bottom:18px}' +
    'th,td{border:1px solid #d5d9e6;padding:5px 7px;text-align:left;vertical-align:top}' +
    'th{background:#f1f3f9;font-size:12px}' +
    'code{font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all}' +
    'tr.cmd td{background:#fafbfe}' +
    'footer{margin-top:18px;color:#5b6172;font-size:11px}' +
    '@media print{body{margin:12mm}}' +
    '</style></head><body>' +
    '<h1>Журнал выполнений — AI Execute Runner</h1>' +
    '<p class="meta">Записей: ' + list.length + ' · выгружено: ' + escapeHtml(fmtTime(Date.now())) +
    ' · версия расширения: ' + escapeHtml(ver) + '</p>' +
    (list.length
      ? '<table><thead><tr><th>#</th><th>Когда</th><th>Среда</th><th>Код</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<p>Записей пока нет.</p>') +
    '<footer>Команды выполнялись локально на этом ПК. Вывод команд в журнал не сохраняется, токен доступа замаскирован.</footer>' +
    '</body></html>';
}

async function exportJournalPdf() {
  clearSticky();
  try {
    const raw = await axStorageGet('local', ['axCommandLog', 'authToken']);
    const entries = (raw && Array.isArray(raw.axCommandLog)) ? raw.axCommandLog : [];
    if (!entries.length) { statusMsg('Журнал пуст — сначала выполни что-нибудь', ''); return; }
    const html = journalHtml(entries, [raw && raw.authToken]);
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(frame);
    const doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
    if (!doc) throw new Error('нет доступа к фрейму печати');
    doc.open(); doc.write(html); doc.close();
    const win = frame.contentWindow;
    let fired = false;
    const run = () => {
      if (fired) return;
      fired = true;
      try { win.focus(); win.print(); } catch (e) { /* ignore */ }
      // Сам фрейм убираем позже: пока открыт диалог печати, документ должен жить.
      setTimeout(() => { try { frame.remove(); } catch (e) { /* ignore */ } }, 60000);
    };
    frame.onload = () => setTimeout(run, 60);
    if (doc.readyState === 'complete') setTimeout(run, 100);
    setTimeout(run, 600); // страховка, если onload уже проскочил
    statusMsg('Открыт диалог печати — выбери «Сохранить как PDF»', 'ok');
  } catch (e) {
    statusMsg('Не удалось подготовить PDF: ' + e, 'err');
  }
}

// --- MCP (экспериментально) --------------------------------------------------
// Всё общение с сервером идёт через background: только он знает authToken.
// Здесь — чистый UI: показать статус, нарисовать серверы и инструменты.

function updateMcpBox() {
  const box = $('mcpBox');
  const on = $('mcpEnabled').checked;
  if (box) box.hidden = !on;
  return on;
}

// Отправляет сообщение в background. В options это обычный runtime.sendMessage,
// но через Promise-обёртку: Firefox и Chrome возвращают по-разному.
function mcpSend(msg) {
  return new Promise((resolve) => {
    try {
      const p = axApi.runtime.sendMessage(msg);
      if (p && typeof p.then === 'function') { p.then(resolve, () => resolve(null)); return; }
      axApi.runtime.sendMessage(msg, (resp) => {
        const err = axApi.runtime.lastError;
        resolve(err ? null : resp);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function mcpSetChip(text, kind) {
  const chip = $('mcpChip');
  if (!chip) return;
  chip.textContent = text;
  chip.className = 'ax-chip' + (kind ? ' ax-chip-' + kind : '');
}

function renderMcpServers(servers) {
  const box = $('mcpServers');
  if (!box) return;
  box.textContent = '';
  if (!servers || !servers.length) {
    box.textContent = 'Серверы не настроены.';
    return;
  }
  servers.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'ax-mcp-row';
    const name = document.createElement('span');
    name.className = 'ax-mcp-name';
    name.textContent = s.name;
    const cmd = document.createElement('span');
    cmd.className = 'ax-mcp-cmd';
    cmd.textContent = [s.command].concat(s.args || []).join(' ');
    row.appendChild(name);
    row.appendChild(cmd);
    const state = document.createElement('span');
    state.className = 'ax-chip ax-chip-' + (s.error ? 'danger' : s.running ? 'ok' : s.enabled ? 'warn' : '');
    state.textContent = s.error ? 'ошибка' : s.running ? 'запущен' : s.enabled ? 'не запущен' : 'выключен';
    row.appendChild(state);
    if (s.error) {
      const err = document.createElement('span');
      err.className = 'ax-mcp-err';
      err.textContent = s.error;
      row.appendChild(err);
    }
    box.appendChild(row);
  });
}

function renderMcpTools(tools) {
  const box = $('mcpTools');
  const count = $('mcpToolsCount');
  if (!box) return;
  box.textContent = '';
  if (!tools || !tools.length) {
    if (count) count.textContent = '0';
    box.textContent = 'Инструментов нет: проверьте, что серверы включены в конфиге и запускаются.';
    return;
  }
  if (count) count.textContent = String(tools.length);
  tools.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'ax-mcp-row';
    const name = document.createElement('span');
    name.className = 'ax-mcp-name';
    name.textContent = t.name;
    const srv = document.createElement('span');
    srv.className = 'ax-mcp-cmd';
    srv.textContent = t.server;
    row.appendChild(name);
    row.appendChild(srv);
    if (t.description) {
      const desc = document.createElement('span');
      desc.textContent = String(t.description).slice(0, 160);
      row.appendChild(desc);
    }
    box.appendChild(row);
  });
}

async function mcpLoadStatus() {
  const resp = await mcpSend({ type: 'AX_MCP_STATUS' });
  const st = (resp && resp.ok && resp.status) || null;
  if (!st) {
    mcpSetChip('нет связи с background', 'danger');
    return;
  }
  if (!st.reachable) {
    mcpSetChip('сервер недоступен', 'danger');
    const hint = $('mcpHint');
    if (hint) hint.textContent = 'Локальный сервер не отвечает. Запустите server.py и обновите адрес в настройках подключения.';
    return;
  }
  if (!st.enabled) {
    mcpSetChip('MCP выключен на сервере', 'warn');
    const hint = $('mcpHint');
    if (hint) hint.textContent = 'Сервер запущен без флага --mcp. Перезапустите его с этим флагом, чтобы включить MCP.';
    renderMcpServers([]);
    renderMcpTools([]);
    return;
  }
  mcpSetChip('включён', 'ok');
  const hint = $('mcpHint');
  if (hint) hint.textContent = st.configError
    ? 'Ошибка конфига: ' + st.configError
    : 'MCP-серверы подняты локальным сервером (stdio).';
  const cfg = $('mcpConfig');
  if (cfg) cfg.textContent = st.config || '—';
  renderMcpServers(st.servers);
}

async function mcpLoadTools() {
  if (!updateMcpBox()) return;
  mcpSetChip('проверяю…', 'warn');
  await mcpLoadStatus();
  const resp = await mcpSend({ type: 'AX_MCP_TOOLS' });
  if (!resp || !resp.ok) {
    const err = (resp && resp.error) || 'сервер не ответил';
    mcpSetChip('ошибка', 'danger');
    renderMcpTools([]);
    statusMsg('MCP: ' + err, 'err');
    return;
  }
  renderMcpTools(resp.result.tools || []);
  renderMcpServers(resp.result.servers || []);
  statusMsg('MCP: найдено инструментов — ' + (resp.result.count || 0), 'ok');
}

async function mcpReloadConfig() {
  if (!updateMcpBox()) return;
  statusMsg('MCP: перечитываю конфиг…');
  const resp = await mcpSend({ type: 'AX_MCP_RELOAD' });
  if (!resp || !resp.ok) {
    statusMsg('MCP: ' + ((resp && resp.error) || 'не удалось перечитать конфиг'), 'err');
    return;
  }
  await mcpLoadTools();
}

// Отчёт по инструментам для ИИ: точные имена, описания, аргументы и готовые
// блоки execute-mcp. Без него модель выдумывает «blender.create_cube» вместо
// настоящего имени инструмента — и вызов падает.
//
// Здесь НЕТ проверки updateMcpBox(): отчёт — справочная информация для модели,
// а не вызов инструмента, поэтому он нужен и при выключенном MCP. Раньше такая
// проверка была, и при mcpEnabled=false кнопка молча ничего не делала.
async function mcpReport(save) {
  const note = $('mcpReportNote');
  if (note) note.textContent = save ? 'Формирую отчёт и сохраняю…' : 'Формирую отчёт…';
  const resp = await mcpSend({ type: 'AX_MCP_REPORT', payload: { save: !!save } });
  if (!resp || !resp.ok) {
    const err = (resp && resp.error) || 'сервер не ответил';
    if (note) note.textContent = 'Не получилось: ' + err;
    statusMsg('MCP: ' + err, 'err');
    return;
  }
  const res = resp.result || {};
  const text = res.text || '';
  if (save && res.saved_to) {
    if (note) note.textContent = 'Готово: ' + res.saved_to +
      ' · вставь этот файл в чат или приложи как контекст';
    statusMsg('MCP: список инструментов сохранён на рабочий стол', 'ok');
  } else {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (note) note.textContent = 'Скопировано (' + (res.count || 0) +
        ' инструментов). Вставь в чат первым сообщением.';
      statusMsg('MCP: список инструментов скопирован в буфер', 'ok');
    } catch (e) {
      if (note) note.textContent = 'Скопировать не вышло: ' + (e && e.message ? e.message : e);
    }
  }
}

// Снимок текущих настроек из формы. Вынесено из save(), чтобы тем же набором
// пользовались профили: «Сохранить текущие настройки» и обычное сохранение
// должны писать ровно одно и то же.
function collectSettings() {
  let autoInsert = $('autoInsert').checked;
  const autoSend = $('autoSend').checked;
  if (autoSend && !autoInsert) { autoInsert = true; $('autoInsert').checked = true; }
  return {
    serverUrl: $('serverUrl').value.trim() || DEFAULTS.serverUrl,
    timeout: clampNum($('timeout').value, 2, 600, 30),
    requireConfirm: $('requireConfirm').checked,
    autoExecute: $('autoExecute').checked,
    autoInsert,
    autoSend,
    autoDelay: clampNum($('autoDelay').value, 0, 30, 3),
    maxAutoRuns: clampNum($('maxAutoRuns').value, 0, 100000, 0),
    autoWeak: $('autoWeak').checked,
    defaultRunner: $('defaultRunner').value || 'shell',
    looseSearch: $('looseSearch').checked,
    maxOutputChars: clampNum($('maxOutputChars').value, 0, 1000000, 32000),
    showToasts: $('showToasts').checked,
    defaultCwd: $('defaultCwd').value.trim(),
    echoMode: getSeg('echoMode') || 'short',
    uiPalette: getSeg('uiPalette') || 'indigo',
    uiRadius: getSeg('uiRadius') || 'soft',
    uiBtnStyle: getSeg('uiBtnStyle') || 'soft',
    uiDensity: getSeg('uiDensity') || 'normal',
    previewLines: clampNum($('previewLines').value, 0, 500, 12),
    paletteEnabled: $('paletteEnabled').checked,
    noisyCollapse: $('noisyCollapse').checked,
    mcpEnabled: $('mcpEnabled').checked,
    // Раньше эти пять настроек вообще не сохранялись: пользователь переключал
    // тему/размер/звук, жал «Сохранить» — и после перезагрузки всё откатывалось.
    uiTheme: getSeg('uiTheme') || 'auto',
    panelSize: getSeg('panelSize') || 'normal',
    collapseAfterRun: $('collapseAfterRun').checked,
    soundOnComplete: $('soundOnComplete').checked,
    catMode: $('catMode').checked,
    browserNotify: $('browserNotify').checked,
  };
}

async function save() {
  clearSticky();
  if (!loaded) { statusMsg('Настройки ещё не загружены — подожди секунду и попробуй снова', 'err'); return; }
  await axStorageSet('sync', collectSettings());
  // Токен в форме не показываем и не трогаем — он приходит из ссылки server.py.
  // На всякий случай убираем старый след из sync (в local его хранит background).
  try { await axStorageRemove('sync', ['authToken']); } catch (e) { /* старые версии */ }
  updateWarn();
  clearDirty();
  statusMsg('✅ Настройки сохранены и применены ко всем вкладкам', 'ok');
}

// --- Профили настроек --------------------------------------------------------
// Наборы хранятся в storage.sync (маленький объект), чтобы переезжать между
// устройствами. Профиль — тот же снимок, что пишет «Сохранить», поэтому формат
// не расходится. Токен в снимок не входит.
const PROFILES_KEY = 'axProfiles';

async function readProfiles() {
  try {
    const r = await axStorageGet('sync', [PROFILES_KEY]);
    return (r && r[PROFILES_KEY]) || {};
  } catch (e) { return {}; }
}

async function renderProfiles() {
  const box = $('profilesList');
  if (!box) return;
  const map = await readProfiles();
  const names = Object.keys(map).sort((a, b) => a.localeCompare(b, 'ru'));
  box.textContent = '';
  if (!names.length) {
    const empty = document.createElement('div');
    empty.className = 'ax-prof-empty';
    empty.textContent = 'Пока нет ни одного профиля — сохрани текущие настройки под именем.';
    box.appendChild(empty);
    return;
  }
  names.forEach((name) => {
    const item = document.createElement('div');
    item.className = 'ax-prof-item';
    const b = document.createElement('b');
    b.textContent = name;
    const info = document.createElement('span');
    info.className = 'desc';
    info.textContent = (map[name] && map[name].serverUrl) || '';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'ax-btn';
    applyBtn.textContent = 'Применить';
    applyBtn.onclick = () => applyProfile(name);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ax-btn';
    delBtn.textContent = 'Удалить';
    delBtn.onclick = () => deleteProfile(name);
    item.appendChild(b);
    item.appendChild(info);
    item.appendChild(spacer);
    item.appendChild(applyBtn);
    item.appendChild(delBtn);
    box.appendChild(item);
  });
}

async function saveProfile() {
  clearSticky();
  const nameEl = $('profileName');
  const name = ((nameEl && nameEl.value) || '').trim();
  if (!name) { statusMsg('Введи название профиля', ''); return; }
  try {
    const map = await readProfiles();
    const snap = collectSettings();
    delete snap.authToken;               // секрет в профиль не кладём
    map[name] = snap;
    await axStorageSet('sync', { [PROFILES_KEY]: map });
    if (nameEl) nameEl.value = '';
    await renderProfiles();
    statusMsg('Профиль «' + name + '» сохранён', 'ok');
  } catch (e) {
    statusMsg('Не удалось сохранить профиль: ' + e, 'err');
  }
}

async function applyProfile(name) {
  clearSticky();
  try {
    const map = await readProfiles();
    const snap = map[name];
    if (!snap) { statusMsg('Профиль не найден', 'err'); return; }
    await axStorageSet('sync', Object.assign({}, snap));
    await load();                        // перечитываем настройки и заполняем форму
    statusMsg('Профиль «' + name + '» применён', 'ok');
  } catch (e) {
    statusMsg('Не удалось применить профиль: ' + e, 'err');
  }
}

async function deleteProfile(name) {
  clearSticky();
  if (!confirm('Удалить профиль «' + name + '»?')) return;
  try {
    const map = await readProfiles();
    delete map[name];
    await axStorageSet('sync', { [PROFILES_KEY]: map });
    await renderProfiles();
    statusMsg('Профиль «' + name + '» удалён', 'ok');
  } catch (e) {
    statusMsg('Не удалось удалить профиль: ' + e, 'err');
  }
}

async function resetAll() {
  clearSticky();
  if (!confirm('Сбросить все настройки к значениям по умолчанию?')) return;
  const clean = { ...DEFAULTS };
  delete clean.authToken;              // секрет в local, сбрасываем его отдельно
  await axStorageSet('sync', clean);
  await axStorageSet('local', { authToken: '' });
  await load();
  statusMsg('↩️ Настройки сброшены к умолчанию', '');
}

async function testConnection(userInitiated) {
  if (userInitiated) clearSticky();
  const serverUrl = $('serverUrl').value.trim() || DEFAULTS.serverUrl;
  statusMsg('Проверка сервера…', '');
  try {
    const resp = await axApi.runtime.sendMessage({ type: 'AX_PING', serverUrl });
    if (resp && resp.ok) { statusMsg('✅ Сервер на связи: ' + JSON.stringify(resp.info), 'ok'); updateWhitelistInfo(resp.info); }
    else statusMsg('❌ Сервер недоступен (' + ((resp && resp.error) || 'нет ответа') + '). Запустите: python server.py', 'err');
  } catch (e) {
    statusMsg('❌ Ошибка: ' + e, 'err');
  }
}

function currentPromptText() {
  const autoEl = $('autoExecute');
  const on = !!(autoEl && autoEl.checked);
  return (typeof AX_buildPrompt === 'function') ? AX_buildPrompt(on) : AX_PROMPT;
}

async function copyPrompt() {
  const text = currentPromptText();
  try {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    }
    if (ok) statusMsg('📋 Промпт для ИИ скопирован — вставь его первым сообщением в чат', 'ok');
    else statusMsg('Не удалось скопировать. Промпт лежит в файле SYSTEM_PROMPT.md', 'err');
  } catch {
    statusMsg('Не удалось скопировать. Промпт лежит в файле SYSTEM_PROMPT.md', 'err');
  }
}

$('save').onclick = save;
$('saveTop').onclick = save;
$('reset').onclick = resetAll;
$('testBtn').onclick = () => testConnection(true);
$('exportJournal').onclick = exportJournal;
$('exportPdf').onclick = exportJournalPdf;
$('resetStats').onclick = resetStats;
$('saveProfile').onclick = saveProfile;
$('clearJournal').onclick = clearJournal;
$('copyPrompt').onclick = copyPrompt;
$('clearHistory').onclick = async () => {
  try {
    if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
      await browser.storage.local.remove(['axExecutedHistory']);
    } else {
      await new Promise((res) => chrome.storage.local.remove(['axExecutedHistory'], res));
    }
    $('histCount').textContent = '0';
    statusMsg('🗑 История выполненных очищена — повторы снова будут выполняться автоматически', 'ok');
  } catch {
    statusMsg('Не удалось очистить историю', 'err');
  }
};
$('autoExecute').onchange = updateWarn;
$('autoSend').onchange = () => { if ($('autoSend').checked) $('autoInsert').checked = true; };
$('autoInsert').onchange = () => { if (!$('autoInsert').checked) $('autoSend').checked = false; };

load();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
    save();
  }
});
