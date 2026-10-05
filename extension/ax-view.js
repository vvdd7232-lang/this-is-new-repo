/* AI Execute Runner — ax-view.js
 * Всё про view: вставка картинки в поле ввода чата и рендер превью под панелью.
 * Зависит от AX (core) и AXDetector.
 */
(function () {
  'use strict';
  const AX = window.AX;
  if (!AX || AX.__viewLoaded) return;
  AX.__viewLoaded = true;

  // Расширение -> нормальное расширение файла. DeepSeek и другие проверяют
  // accept по расширению, поэтому 'image.svg+xml' из наивного mime.split('/')[1]
  // НЕ проходит.
  const VIEW_MIME_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp',
    'image/avif': 'avif', 'image/apng': 'png', 'image/heic': 'heic', 'image/heif': 'heif',
    'image/tiff': 'tiff', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  };

  function dataUrlToBlob(dataUrl, fallbackMime) {
    const s = String(dataUrl || '');
    const comma = s.indexOf(',');
    if (comma < 0) return null;
    const meta = s.slice(0, comma);
    const payload = s.slice(comma + 1);
    const m = meta.match(/^data:([^;,]+)/i);
    const mime = (m && m[1]) || fallbackMime || 'image/png';
    try {
      if (/;base64/i.test(meta)) {
        const bin = atob(payload);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
      }
      return new Blob([decodeURIComponent(payload)], { type: mime });
    } catch (e) {
      console.warn('[AX] view: не удалось разобрать data_url:', e);
      return null;
    }
  }

  function makeViewFile(blob, path) {
    const mime = (blob.type || 'image/png').toLowerCase();
    let ext = VIEW_MIME_EXT[mime];
    if (!ext) {
      const fromPath = String(path || '').match(/\.([a-z0-9]{2,5})$/i);
      ext = fromPath ? fromPath[1].toLowerCase() : 'png';
    }
    const raw = String(path || 'image').split(/[\\/]/).pop() || 'image';
    const base = raw.replace(/\.[^.]*$/, '').replace(/[^\w.\-]+/g, '_') || 'image';
    return new File([blob], base + '.' + ext, { type: blob.type || mime });
  }

  function findUploadFileInputs(input) {
    const all = AX.deepQueryAll('input[type="file"]', AX.collectShadowRoots());
    const scored = [];
    for (const fi of all) {
      if (AX.isOurNode(fi) || fi.disabled) continue;
      const accept = (fi.getAttribute('accept') || '').toLowerCase();
      if (accept && !/image|\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|tiff)\b/.test(accept)) continue;
      let score = 0;
      if (fi.multiple) score += 2;
      try {
        if (input) {
          const host = input.closest('form') || input.parentElement || input;
          if (host && (host.contains(fi) || (host.parentElement && host.parentElement.contains(fi)))) score += 6;
        }
      } catch (e) { /* ignore */ }
      scored.push({ fi, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.fi);
  }

  // Раньше возвращался только один «лучший» input[type=file]. Если он по
  // какой-то причине не срабатывал (например, это был инпут другого блока
  // страницы с тем же accept), вставка падала, хотя рядом мог лежать рабочий.
  function findUploadFileInput(input) {
    const list = findUploadFileInputs(input);
    return list.length ? list[0] : null;
  }

  function composerScope(input) {
    try { return input.closest('form') || input.parentElement || input; } catch (e) { return input; }
  }

  function countAttachmentNodes(scope) {
    try {
      const root = scope && scope.nodeType === 1 ? scope : document;
      return root.querySelectorAll('img[src^="blob:"], img[src^="data:image"], [class*="attachment" i], [class*="thumb" i], [class*="file-icon" i]').length;
    } catch (e) { return 0; }
  }

  // Ждём реального изменения DOM. Вызывать ДО отправки события.
  // Множитель таймаутов ожидания. В проде = 1. Тесты выставляют 0.05, иначе
  // каждый неуспешный шаг вставки ждал бы полные секунды и прогон занимал
  // бы около минуты вместо нескольких.
  function waitMs(base) {
    try {
      const k = (typeof AX !== 'undefined' && AX.__viewWait) || 1;
      return Math.max(20, Math.round(base * k));
    } catch (e) { return base; }
  }
  function waitForAttachment(scope, ms) {
    const limit = ms || 2000;
    let cancelFn = null;
    const promise = new Promise((resolve) => {
      const root = scope && scope.nodeType === 1 ? scope : document.body;
      if (!root) return resolve(false);
      const before = countAttachmentNodes(scope);
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try { obs.disconnect(); } catch (e) { /* ignore */ }
        clearInterval(iv);
        clearTimeout(to);
        resolve(ok);
      };
      cancelFn = () => finish(false);
      const grew = () => countAttachmentNodes(scope) > before;
      let obs = null;
      try {
        obs = new MutationObserver(() => { if (grew()) finish(true); });
        obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
      } catch (e) { /* ignore */ }
      const iv = setInterval(() => { if (grew()) finish(true); }, 120);
      const to = setTimeout(() => finish(false), limit);
      if (grew()) finish(true);
    });
    promise.cancel = () => { try { cancelFn && cancelFn(); } catch (e) { /* ignore */ } };
    return promise;
  }

  function trySyntheticPaste(input, file, scope) {
    let dt = null;
    try {
      dt = new DataTransfer();
      dt.items.add(file);
    } catch (e) { return Promise.resolve({ ok: false, why: 'DataTransfer: ' + e }); }
    let ev;
    try {
      ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    } catch (e) { return Promise.resolve({ ok: false, why: 'ClipboardEvent: ' + e }); }
    const roundTrip = !!(ev.clipboardData && ev.clipboardData.items && ev.clipboardData.items.length);
    if (!roundTrip) return Promise.resolve({ ok: false, why: 'браузер не пробросил clipboardData' });
    const wait = waitForAttachment(scope, waitMs(1500));
    input.dispatchEvent(ev);
    try {
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', dataTransfer: dt }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', dataTransfer: dt }));
    } catch (e) { /* ignore */ }
    return wait.then((ok) => ({ ok, why: ok ? '' : 'событие отправлено, но DOM не изменился' }));
  }

  // Шаг вставки через drop-событие — то, как на самом деле работает
  // перетаскивание файла в чат. Многие сайты (DeepSeek, ChatGPT, Claude)
  // больше не отзываются на синтетический change у скрытого input[type=file],
  // но продолжают слушать dragover/drop на композере. Без этого шага вставка
  // падала в буфер обмена, а он тоже мог быть недоступен.
  function tryDropImage(input, file, scope) {
    // DragEvent есть не везде (и точно нет в headless-окружениях). Без этой
    // проверки код падал в ReferenceError, который глушился catch, и шаг
    // молча превращался в пустой — как раз тот случай, когда вставка не
    // срабатывала нигде.
    const DragCtor = (typeof DragEvent !== 'undefined' && DragEvent) ||
      (typeof window !== 'undefined' && window.DragEvent) || null;
    if (!DragCtor) return Promise.resolve({ ok: false, why: 'DragEvent недоступен' });
    let dt = null;
    try {
      dt = new DataTransfer();
      dt.items.add(file);
    } catch (e) { return Promise.resolve({ ok: false, why: 'DataTransfer: ' + e }); }
    // Только композер и его ближайшие обёртки. document.body намеренно НЕ
    // трогаем: drop по всему документу ловит вкладка/файловое окно и лишние
    // обработчики сайта, а в тестовом окружении это вообще вешало прогон.
    const targets = [];
    try {
      if (input) targets.push(input);
      let el = input;
      for (let i = 0; i < 3 && el && el.parentElement; i++) { el = el.parentElement; targets.push(el); }
      if (scope && scope.nodeType === 1 && targets.indexOf(scope) === -1) targets.push(scope);
    } catch (e) { /* ignore */ }
    if (!targets.length) return Promise.resolve({ ok: false, why: 'нет целей для drop' });
    const wait = waitForAttachment(scope, waitMs(2000));
    try {
      for (const t of targets) {
        try {
          let x = 0, y = 0;
          try {
            const rc = t.getBoundingClientRect();
            if (rc) { x = Math.round(rc.left + rc.width / 2); y = Math.round(rc.top + rc.height / 2); }
          } catch (e) { /* геометрия не обязательна */ }
          const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y };
          t.dispatchEvent(new DragCtor('dragenter', init));
          t.dispatchEvent(new DragCtor('dragover', init));
          t.dispatchEvent(new DragCtor('drop', init));
        } catch (e) { /* один не сработал — пробуем следующий */ }
      }
    } catch (e) { return Promise.resolve({ ok: false, why: 'drop: ' + e }); }
    // Страховка от зависания: waitForAttachment имеет свой таймаут, но если он
    // по какой-то причине не сработает, вставка не должна вставать колом.
    const guard = new Promise((res) => setTimeout(() => res(false), waitMs(3000)));
    return Promise.race([wait, guard])
      .then((ok) => ({ ok: !!ok, why: ok ? '' : 'drop отправлен, но DOM не изменился' }));
  }

  function tryExecInsertImage(input, dataUrl, scope) {
    try {
      if (document.queryCommandSupported && !document.queryCommandSupported('insertImage')) {
        return Promise.resolve({ ok: false, why: 'insertImage не поддерживается браузером' });
      }
    } catch (e) { /* ignore */ }
    const wait = waitForAttachment(scope, waitMs(1500));
    try {
      if (!document.execCommand('insertImage', false, dataUrl)) {
        wait.cancel && wait.cancel();
        return Promise.resolve({ ok: false, why: 'execCommand вернул false' });
      }
    } catch (e) {
      return Promise.resolve({ ok: false, why: 'execCommand: ' + e });
    }
    return wait.then((ok) => ({ ok, why: ok ? '' : 'отработал, но <img> не появился' }));
  }

  async function transcodeToPng(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width || 1;
      canvas.height = bmp.height || 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      return await new Promise((res) => canvas.toBlob((b) => res(b), 'image/png'));
    } catch (e) { return null; }
  }

  async function copyImageToClipboard(blob) {
    if (!navigator.clipboard || !navigator.clipboard.write || !window.ClipboardItem) {
      return { ok: false, why: 'Clipboard API недоступен' };
    }
    const supports = (t) => {
      try { return !window.ClipboardItem.supports || window.ClipboardItem.supports(t); } catch (e) { return false; }
    };
    let outBlob = blob;
    let outMime = blob.type || 'image/png';
    if (!supports(outMime)) {
      const png = await transcodeToPng(blob);
      if (!png) return { ok: false, why: 'формат ' + outMime + ' не поддерживается буфером' };
      outBlob = png;
      outMime = 'image/png';
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ [outMime]: outBlob })]);
      return { ok: true };
    } catch (e) {
      return { ok: false, why: 'clipboard.write: ' + (e && e.name ? e.name : e) };
    }
  }

  let lastViewData = null;
  AX.getLastViewData = () => lastViewData;
  AX.setLastViewData = (v) => { lastViewData = v; };

  AX.insertImageIntoChat = async function (view) {
    if (view && view.data_url) lastViewData = view;
    if (!view || !view.data_url) { AX.toast('🖼 view: сервер не вернул data_url'); return false; }
    const diag = { url: location.href, steps: [] };
    const say = (s) => { diag.steps.push(s); try { console.info('[AX][view]', s); } catch (e) { /* ignore */ } };
    const found = AX.findChatInputDetailed();
    diag.input = AX.describeChatInput(found);
    say('поле ввода: ' + JSON.stringify(diag.input));
    const input = found.el;
    if (!input) {
      AX.toast('\uD83D\uDDBC view: \u043D\u0435 \u043D\u0430\u0448\u0451\u043B \u043F\u043E\u043B\u0435 \u0432\u0432\u043E\u0434\u0430 \u2014 \u043A\u0430\u0440\u0442\u0438\u043D\u043A\u0430 \u0432 \u043F\u0440\u0435\u0432\u044C\u044E \u043F\u043E\u0434 \u0431\u043B\u043E\u043A\u043E\u043C (\u043F\u043E\u0434\u0440\u043E\u0431\u043D\u043E\u0441\u0442\u0438 \u0432 F12)', 4500);
      return false;
    }
    const blob = dataUrlToBlob(view.data_url, view.mime);
    if (!blob) { AX.toast('view: \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0440\u0430\u0437\u043E\u0431\u0440\u0430\u0442\u044C \u043A\u0430\u0440\u0442\u0438\u043D\u043A\u0443'); return false; }
    const file = makeViewFile(blob, view.path);
    diag.file = { name: file.name, type: file.type, size: file.size };
    say('\u0444\u0430\u0439\u043B: ' + file.name + ' | ' + file.type + ' | ' + file.size + ' B');
    try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (e2) { /* ignore */ } }
    const scope = composerScope(input);
    // contenteditable="plaintext-only" — полноценный редактор без
    // форматирования (ProseMirror, TipTap, новые сборки чатов). Прежняя
    // проверка требовала ровно "true", считала такое поле нередактируемым,
    // и шаги с paste/execCommand молча пропускались.
    const ceAttr = input.getAttribute ? input.getAttribute('contenteditable') : null;
    const isCE = !!input.isContentEditable || (!!ceAttr && ceAttr !== 'false');
    diag.isContentEditable = isCE;

    // Шаг 1: скрытый input[type=file] композера (DeepSeek / ChatGPT / Claude)
// Полный список кандидатов — по нему работает запасной перебор ниже.
    const fileInputsList = findUploadFileInputs(input);
    // Файл кладут в инпут, но сайт может не отреагировать. Раньше наличие
    // fi.files тут же считалось успехом и возвращало true — но это наше же
    // присвоенное значение, а не доказательство, что чат принял картинку.
    // Теперь запоминаем факт отправки и идём дальше: запасные инпуты, drop,
    // буфер. Если всё глухо — сообщаем, что файл отправлен.
    let sentToFileInput = false;
    const fi = findUploadFileInput(input);
    if (fi) {
      try {
        const wait = waitForAttachment(scope, waitMs(2500));
        const dt = new DataTransfer();
        dt.items.add(file);
        fi.files = dt.files;
        fi.dispatchEvent(new Event('input', { bubbles: true }));
        fi.dispatchEvent(new Event('change', { bubbles: true }));
        const ok = await wait;
        diag.fileInput = { accept: fi.getAttribute('accept'), multiple: !!fi.multiple, verified: ok };
        say('file-input: \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D, \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D=' + ok);
        if (ok) { AX.toast('view: \u043A\u0430\u0440\u0442\u0438\u043D\u043A\u0430 \u0432\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u0430 \u0432 \u0447\u0430\u0442', 3500); return true; }
        if (fi.files && fi.files.length) sentToFileInput = true;
      } catch (e) {
        say('file-input \u043E\u0448\u0438\u0431\u043A\u0430: ' + e);
      }
    } else {
      say('file-input \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D');
    }

// Шаг 1б: перебор остальных input[type=file]. Шаг 1 пробует только один —
    // самый «похожий на композер». Если он не сработал (а рядом может лежать
    // инпут того же чата с тем же accept), раньше вставка просто падала дальше.
    if (fileInputsList && fileInputsList.length > 1) {
      for (const alt of fileInputsList.slice(1)) {
        try {
          const wait = waitForAttachment(scope, waitMs(1200));
          const dt = new DataTransfer();
          dt.items.add(file);
          alt.files = dt.files;
          alt.dispatchEvent(new Event('input', { bubbles: true }));
          alt.dispatchEvent(new Event('change', { bubbles: true }));
          const ok = await wait;
          say('file-input (запасной): принят=' + ok);
          if (ok) { AX.toast('view: картинка вставлена в чат', 3500); return true; }
        } catch (e) { say('запасной file-input ошибка: ' + e); }
      }
    }

    // Шаг 1в: drop-событие — именно так картинка попадает в чат при
    // перетаскивании. Сайты часто перестают реагировать на синтетический
    // change у скрытого input[type=file], но продолжают слушать drop на
    // композере. Шаг идёт для любого типа поля (textarea тоже), поэтому
    // расположен до paste/execCommand и к буферу обмена.
    const dr = await tryDropImage(input, file, scope);
    say('drop: ok=' + dr.ok + (dr.why ? ' (' + dr.why + ')' : ''));
    if (dr.ok) { AX.toast('view: картинка вставлена в чат', 3500); return true; }
    // Шаг 2: синтетическая вставка (только contenteditable с onPaste)
    if (isCE) {
      const r = await trySyntheticPaste(input, file, scope);
      say('paste: ok=' + r.ok + (r.why ? ' (' + r.why + ')' : ''));
      if (r.ok) { AX.toast('view: \u043A\u0430\u0440\u0442\u0438\u043D\u043A\u0430 \u0432\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u0430 \u0432 \u0447\u0430\u0442', 3500); return true; }
    } else {
      say('paste: \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D \u2014 \u043F\u043E\u043B\u0435 \u043D\u0435 contenteditable');
    }

    // Шаг 3: execCommand insertImage (только contenteditable)
    if (isCE) {
      const r = await tryExecInsertImage(input, view.data_url, scope);
      say('execCommand insertImage: ok=' + r.ok + (r.why ? ' (' + r.why + ')' : ''));
      if (r.ok) { AX.toast('view: \u043A\u0430\u0440\u0442\u0438\u043D\u043A\u0430 \u0432\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u0430 \u0432 \u0447\u0430\u0442', 3500); return true; }
    }

    // Файл дошёл до скрытого input[type=file], но сайт не показал превью.
    // Сообщаем честно: скорее всего, он подхватит файл позже. Раньше здесь
    // сразу показывалось «авто-вставка не сработала», хотя файл-то был отправлен.
    if (sentToFileInput) {
      AX.toast('view: файл отправлен в композер — проверь превью', 5000);
      return true;
    }

    // Шаг 4: буфер обмена + подсказка Ctrl+V
    const cp = await copyImageToClipboard(blob);
    say('clipboard: ok=' + cp.ok + (cp.why ? ' (' + cp.why + ')' : ''));
    if (cp.ok) AX.toast('\u041A\u0430\u0440\u0442\u0438\u043D\u043A\u0430 \u0432 \u0431\u0443\u0444\u0435\u0440\u0435 \u043E\u0431\u043C\u0435\u043D\u0430 \u2014 \u043D\u0430\u0436\u043C\u0438 Ctrl+V \u0432 \u043F\u043E\u043B\u0435 \u0432\u0432\u043E\u0434\u0430', 4500);
    else AX.toast('view: \u0430\u0432\u0442\u043E-\u0432\u0441\u0442\u0430\u0432\u043A\u0430 \u043D\u0435 \u0441\u0440\u0430\u0431\u043E\u0442\u0430\u043B\u0430 \u2014 \u043E\u0442\u043A\u0440\u043E\u0439 \u043F\u0440\u0435\u0432\u044C\u044E \u0438 \u0432\u0441\u0442\u0430\u0432\u044C \u0432\u0440\u0443\u0447\u043D\u0443\u044E (F12: [AX][view])', 5000);
    return false;
  };

  AX.renderView = function (panel, view) {
    if (!panel || !view || !view.data_url) return;
    // Панель живёт в закрытом shadow root — обращаемся через panel.$(...) и
    // panel.innerContent, а не через document/DOM страницы.
    const scope = panel.innerContent || panel;
    const q = panel.$ ? (sel) => panel.$(sel) : (sel) => scope.querySelector(sel);
    let box = q('.ax-view-wrap');
    if (!box) {
      box = document.createElement('div');
      box.className = 'ax-view-wrap';
      const img = document.createElement('img');
      img.className = 'ax-view-img';
      img.title = 'Click to open in new tab';
      img.onclick = () => { try { window.open(view.data_url, '_blank'); } catch (e) { /* ignore */ } };
      const meta = document.createElement('div');
      meta.className = 'ax-view-meta';
      box.appendChild(img);
      box.appendChild(meta);
      const after = q('.ax-exec-after');
      if (after && after.parentNode) after.parentNode.insertBefore(box, after.nextSibling);
      else scope.appendChild(box);
    }
    box.querySelector('.ax-view-img').src = view.data_url;
    box.querySelector('.ax-view-meta').textContent = view.path + ' (' + view.mime + ', ' + view.size + ' B)';
    AX.addViewRetryButton(box, view);
  };

  AX.addViewRetryButton = function (box, view) {
    if (!box || box.querySelector('.ax-btn-view-retry')) return;
    const btn = document.createElement('button');
    btn.className = 'ax-btn ax-btn-view-retry';
    btn.textContent = '🖼 Вставить в чат';
    btn.title = 'Повторить вставку картинки в поле ввода чата';
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      Promise.resolve(AX.insertImageIntoChat(view)).catch((err) => console.warn('[AX] view retry:', err));
    };
    box.appendChild(btn);
  };

  console.log('[AX] view loaded');
})();
