/* AI Execute Runner — ax-palette.js
 *
 * Палитра команд: Ctrl+Shift+E (или Cmd+Shift+E) на странице чата.
 *
 * Зачем: не каждую команду нужно «выпрашивать» у ИИ. Рутина («собери проект»,
 * «прогони тесты», «покажи git status») повторяется каждый день, и её быстрее
 * запустить самому. Палитра берёт историю запусков и закреплённые сниппеты,
 * даёт поиск, выбор среды и три действия: выполнить, выполнить без
 * подтверждения, вставить в чат как execute-блок.
 *
 * Изоляция как у панели: закрытый shadow root (page-JS не видит содержимое) и
 * проверка isTrusted на горячей клавише и кликах. Зависит от AX (core),
 * AXDetector и AX.runArbitrary (panel).
 */
(function () {
  'use strict';
  const AX = window.AX;
  const D = window.AXDetector;
  if (!AX || !D || AX.__paletteLoaded) return;
  AX.__paletteLoaded = true;

  const SHORTCUT = 'Ctrl+Shift+E';
  let overlay = null;      // хост в DOM страницы
  let items = [];          // отфильтрованные элементы
  let cursor = 0;          // выбранный индекс
  let opened = false;
  let lastFocus = null;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // Строим каркас один раз: пересоздавать shadow root на каждое открытие дорого.
  function build() {
    if (overlay) return overlay;
    overlay = AX.createShadowPanel();
    overlay.classList.add('ax-palette-host');
    overlay.innerContent.innerHTML =
      '<div class="ax-palette" role="dialog" aria-modal="true" aria-label="Палитра команд">' +
        '<div class="ax-palette-head">' +
          '<span class="ax-palette-input-wrap">' +
            '<input class="ax-input ax-palette-input" type="text" placeholder="Найти команду или ввести новую…" ' +
              'spellcheck="false" autocomplete="off">' +
          '</span>' +
          '<span class="ax-palette-shortcut" title="Закрыть">Esc</span>' +
        '</div>' +
        '<div class="ax-palette-list" role="listbox"></div>' +
        '<div class="ax-palette-foot">' +
          '<span><b>Enter</b> выполнить</span>' +
          '<span><b>Ctrl+Enter</b> без подтверждения</span>' +
          '<span><b>Ctrl+I</b> в чат как execute</span>' +
          '<span><b>Ctrl+P</b> закрепить</span>' +
          '<span><b>Del</b> удалить из истории</span>' +
        '</div>' +
      '</div>';

    const input = overlay.$('.ax-palette-input');
    input.addEventListener('input', () => { cursor = 0; render(); });
    input.addEventListener('keydown', onKeyDown);
    // Клик по фону закрывает, клик по строке — обрабатывается отдельно.
    // Слушатель внутри тени: до хоста закрытого shadow события не доходят,
    // поэтому раньше клик мимо палитры её не закрывал.
    overlay.innerContent.addEventListener('mousedown', (e) => {
      if (!e.target || !e.target.closest || !e.target.closest('.ax-palette')) close();
    });
    overlay.$('.ax-palette-list').addEventListener('click', onListClick);
    overlay.$('.ax-palette-list').addEventListener('mousemove', (e) => {
      const row = e.target.closest && e.target.closest('.ax-palette-item');
      if (!row) return;
      const ix = +row.dataset.ix;
      if (!Number.isNaN(ix) && ix !== cursor) { cursor = ix; paintCursor(); }
    });
    return overlay;
  }

  function onListClick(e) {
    if (!AX.assumeTrustedEvents && e.isTrusted === false) return;
    const btn = e.target.closest && e.target.closest('[data-act]');
    if (btn) {
      const item = btn.closest('.ax-palette-item');
      if (!item) return;
      const ix = +item.dataset.ix;
      const act = btn.dataset.act;
      if (act === 'pin') { togglePinAt(ix); return; }
      if (act === 'run') { execute(items[ix], false); return; }
      if (act === 'insert') { insertToChat(items[ix]); return; }
      if (act === 'forget') { forgetAt(ix); return; }
      return;
    }
    const row = e.target.closest && e.target.closest('.ax-palette-item');
    if (row) {
      cursor = +row.dataset.ix;
      execute(items[cursor], false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[cursor];
      if (!item) return;
      if (e.ctrlKey && e.shiftKey) { execute(item, true); return; }
      if (e.ctrlKey) { execute(item, true); return; }
      execute(item, false);
      return;
    }
    if (e.key === 'i' && e.ctrlKey) { e.preventDefault(); if (items[cursor]) insertToChat(items[cursor]); return; }
    if (e.key === 'p' && e.ctrlKey) { e.preventDefault(); togglePinAt(cursor); return; }
    if (e.key === 'Delete') { e.preventDefault(); forgetAt(cursor); return; }
  }

  function move(delta) {
    if (!items.length) return;
    cursor = (cursor + delta + items.length) % items.length;
    paintCursor();
  }

  /* Подкручиваем список так, чтобы курсорная строка была видна.
     Важно: НЕ используем scrollIntoView — он прокручивает всех предков,
     включая страницу чата, и открытие палитры прыгало бы в конец ленты.
     Поэтому считаем смещение вручную и двигаем только сам список. */
  function paintCursor() {
    const list = overlay.$('.ax-palette-list');
    const rows = list.querySelectorAll('.ax-palette-item');
    rows.forEach((row, i) => row.classList.toggle('on', i === cursor));
    const active = rows[cursor];
    if (!active) return;
    try {
      const top = active.offsetTop;
      const bottom = top + active.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    } catch (e) { /* ignore */ }
  }

  // --- фильтрация -----------------------------------------------------------
  // Ищем по подстроке, но с приоритетом «начинается с» и по каждому слову —
  // так «нпм тест» не найдёт, а «npm test» найдёт даже при вводе «test npm».
  AX.paletteFilter = function (list, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return list.slice();
    const words = q.split(/\s+/);
    const scored = [];
    for (const item of list) {
      const hay = item.cmd.toLowerCase();
      const runner = String(item.runner || '').toLowerCase();
      let score = 0;
      let ok = true;
      for (const w of words) {
        const ix = hay.indexOf(w);
        if (ix === -1) {
          if (runner.indexOf(w) === 0) { score += 1; continue; }
          ok = false;
          break;
        }
        score += ix === 0 ? 12 : (hay[ix - 1] === ' ' || hay[ix - 1] === '\n' ? 8 : 3);
        score -= Math.min(6, Math.floor(hay.length / 200));
      }
      if (!ok) continue;
      if (item.pinned) score += 4;
      scored.push({ item, score });
    }
    scored.sort((a, b) => (b.score - a.score) || ((b.item.t || 0) - (a.item.t || 0)));
    return scored.map((s) => s.item);
  };

  // --- отрисовка ------------------------------------------------------------
  function beforeLabel(sec) {
    if (!sec) return '';
    if (sec < 120) return sec + ' с назад';
    if (sec < 7200) return Math.round(sec / 60) + ' мин назад';
    if (sec < 172800) return Math.round(sec / 3600) + ' ч назад';
    return Math.round(sec / 86400) + ' дн назад';
  }

  function statusChip(item) {
    if (item.pinned) return { cls: 'ax-chip ax-chip-accent', text: 'закреплено' };
    if (typeof item.exit === 'number') {
      return item.exit === 0
        ? { cls: 'ax-chip ax-chip-ok', text: 'exit=0' }
        : { cls: 'ax-chip ax-chip-danger', text: 'exit=' + item.exit };
    }
    if (item.status === 'error') return { cls: 'ax-chip ax-chip-danger', text: 'ошибка' };
    return null;
  }

  function render() {
    const list = overlay.$('.ax-palette-list');
    const query = overlay.$('.ax-palette-input').value;
    const custom = String(query || '').trim();
    const matched = AX.paletteFilter(AX.paletteItems(), query);

    // Строку «новая команда» показываем ТОЛЬКО когда история ничего не нашла —
    // иначе при вводе 'git' список выглядел бы как «новое: git» + «git status».
    // Свой текст всё равно можно ввести целиком: тогда совпадений нет и строка
    // появляется (в том числе с аргументами: 'npm run build -- --watch').
    const showCustom = custom.length > 0 && !matched.some((i) => i.cmd.trim() === custom) && matched.length === 0;
    items = showCustom
      ? [{ cmd: custom, runner: AX.settings.defaultRunner || 'shell', t: 0, pinned: false, exit: null, status: '', custom: true }].concat(matched)
      : matched;

    if (cursor >= items.length) cursor = Math.max(0, items.length - 1);

    list.textContent = '';
    if (!items.length) {
      const empty = el('div', 'ax-palette-empty');
      empty.appendChild(AX.icon('search'));
      empty.appendChild(el('span', null, AX.cmdLog.length
        ? 'Ничего не найдено — уточни запрос'
        : 'История пуста: выполни команду или введи текст и нажми Enter'));
      list.appendChild(empty);
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const row = el('div', 'ax-palette-item'
        + (item.pinned ? ' pinned' : '')
        + (item.custom ? ' ax-palette-custom' : ''));
      row.dataset.ix = String(i);
      row.title = item.cmd;

      row.appendChild(AX.icon(item.custom ? 'bolt' : (item.pinned ? 'check' : 'play'), 'ax-palette-ico'));

      const main = el('div', 'ax-palette-main');
      main.appendChild(el('div', 'ax-palette-cmd', item.cmd.split('\n')[0] + (item.cmd.includes('\n') ? ' …' : '')));
      const meta = el('div', 'ax-palette-meta');
      if (item.custom) {
        meta.appendChild(el('span', null, 'новая команда · ' + item.runner));
      } else {
        if (item.secret) meta.appendChild(el('span', 'ax-chip ax-chip-warn', 'секрет скрыт'));
        const chip = statusChip(item);
        if (chip) meta.appendChild(el('span', chip.cls, chip.text));
        meta.appendChild(el('span', null, item.runner));
        if (item.t) meta.appendChild(el('span', null, beforeLabel(Math.max(1, Math.round((Date.now() - item.t) / 1000)))));
        if (item.cmd.includes('\n')) meta.appendChild(el('span', null, item.cmd.split('\n').length + ' стр.'));
      }
      main.appendChild(meta);
      row.appendChild(main);

      const actions = el('div', 'ax-palette-actions');
      if (!item.custom) {
        const pin = el('button', 'ax-btn ax-btn-icon', item.pinned ? '★' : '☆');
        pin.dataset.act = 'pin';
        pin.title = item.pinned ? 'Открепить' : 'Закрепить';
        actions.appendChild(pin);
        const forget = el('button', 'ax-btn ax-btn-icon');
        forget.dataset.act = 'forget';
        forget.title = 'Убрать из истории';
        forget.appendChild(AX.icon('stop'));
        actions.appendChild(forget);
      }
      const ins = el('button', 'ax-btn ax-btn-icon');
      ins.dataset.act = 'insert';
      ins.title = 'Вставить в чат как execute-блок';
      ins.appendChild(AX.icon('chat'));
      actions.appendChild(ins);
      row.appendChild(actions);

      list.appendChild(row);
    }
    paintCursor();
  }

  // --- действия -------------------------------------------------------------
  function currentCustomOrItem() {
    const value = String(overlay.$('.ax-palette-input').value || '').trim();
    const row = overlay.$('.ax-palette-list').querySelector('.ax-palette-item.on');
    const hasCustom = !!(row && row.classList.contains('ax-palette-custom'));
    if (hasCustom) return { cmd: value, runner: AX.settings.defaultRunner || 'shell', pinned: false, t: 0, custom: true };
    if (items[cursor]) return items[cursor];
    if (value) return { cmd: value, runner: AX.settings.defaultRunner || 'shell', pinned: false, t: 0, custom: true };
    return null;
  }

  function execute(item, skipConfirm) {
    if (!item || !item.cmd) return;
    // В команде был секрет — в журнале он заменён на «скрыто». Запускать такой
    // текст бессмысленно (сервер получит мусор), поэтому отдаём его в поиск:
    // пользователь допишет значение и нажмёт Enter.
    if (item.secret) {
      editSecret(item);
      return;
    }
    const runner = D.runnerValid(item.runner) || (D.sniffRunner(item.cmd) || AX.settings.defaultRunner || 'shell');
    close();
    // Подтверждение, защита от параллельных запусков и запись в журнал — в
    // ax-panel: палитра только передаёт команду и флаг «без диалога».
    try {
      Promise.resolve(AX.runArbitrary(item.cmd, runner, { skipConfirm: !!skipConfirm, palette: true }))
        .catch((e) => console.warn('[AX] palette run:', e));
    } catch (e) {
      console.warn('[AX] palette run:', e);
    }
  }

  function insertToChat(item) {
    if (!item || !item.cmd) return;
    const lang = item.runner === 'shell' ? 'execute' : 'execute-' + (item.runner === 'powershell' ? 'pwsh' : item.runner);
    const text = '\n```' + lang + '\n' + item.cmd + '\n```\n';
    close();
    try {
      const ok = AX.insertIntoChat(text);
      AX.toast(ok ? 'Команда вставлена в чат как ' + lang : 'Поле ввода не найдено — команда в буфере обмена');
      if (!ok) AX.silentCopy(text);
    } catch (e) {
      AX.toast('Не удалось вставить команду');
    }
  }

  /* Команда с замаскированным секретом: кладём текст в поиск и ставим курсор в
   * конец, вместо запуска заведомо неверной команды. */
  function editSecret(item) {
    const input = overlay.$('.ax-palette-input');
    input.value = item.cmd;
    cursor = 0;
    render();
    try { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ }
    AX.toast('Секрет в команде скрыт — вставь значение вместо «скрыто» и нажми Enter');
  }

  function togglePinAt(ix) {
    const item = items[ix];
    if (!item) return;
    const nowPinned = AX.togglePin(item.cmd, item.runner);
    AX.toast(nowPinned ? '★ Закреплено: будет первым в палитре' : '☆ Откреплено');
    render();
  }

  function forgetAt(ix) {
    const item = items[ix];
    if (!item) return;
    if (item.pinned) { AX.togglePin(item.cmd, item.runner); render(); return; }
    const key = String(item.cmd).trim().replace(/\s+/g, ' ');
    const before = AX.cmdLog.length;
    AX.cmdLog = AX.cmdLog.filter((e) => String(e.cmd).trim().replace(/\s+/g, ' ') !== key);
    if (AX.cmdLog.length !== before) AX.saveCmdLog();
    render();
  }

  // --- открытие/закрытие ----------------------------------------------------
  /* Палитра не должна дёргать ленту чата: запоминаем позицию прокрутки
   * страницы и возвращаем её после отрисовки и после focus(). На реальных
   * сайтах фокус в поле поверх fixed-оверлея иначе прокручивает страницу. */
  function axScrollTop() {
    try { return (document.scrollingElement || document.documentElement || {}).scrollTop || 0; } catch (e) { return 0; }
  }
  function axRestoreScroll(top) {
    try {
      const se = document.scrollingElement || document.documentElement;
      if (se && Math.abs(se.scrollTop - top) > 1) se.scrollTop = top;
    } catch (e) { /* ignore */ }
  }

  function open() {
    if (opened) return;
    opened = true;
    build();
    const pageTop = axScrollTop();
    lastFocus = document.activeElement;
    if (!overlay.isConnected) document.body.appendChild(overlay);
    overlay.classList.add('ax-palette-open');
    cursor = 0;
    const input = overlay.$('.ax-palette-input');
    input.value = '';
    render();
    try { input.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    axRestoreScroll(pageTop);
  }

  function close() {
    if (!opened || !overlay) return;
    opened = false;
    const pageTop = axScrollTop();
    overlay.classList.remove('ax-palette-open');
    try { if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    axRestoreScroll(pageTop);
  }

  AX.openCommandPalette = open;
  AX.closeCommandPalette = close;
  AX.isPaletteOpen = () => opened;

  // Горячая клавиша. Проверяем isTrusted: синтетическое событие из page-JS не
  // должно открывать окно с историей команд.
  function onGlobalKey(e) {
    if (!AX.assumeTrustedEvents && e.isTrusted === false) return;
    // Esc закрывает палитру, даже если фокус уехал из поля поиска.
    if (opened && e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (AX.settings.paletteEnabled === false) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === 'E' || e.key === 'e' || e.code === 'KeyE')) {
      e.preventDefault();
      if (opened) close(); else open();
    }
  }
  try { document.addEventListener('keydown', onGlobalKey, true); } catch (e) { /* ignore */ }

  AX.PALETTE_SHORTCUT = SHORTCUT;
  console.log('[AX] palette loaded');
})();
