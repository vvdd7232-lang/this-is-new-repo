/* AI Execute Runner — ax-panel.js
 * Подтверждение запуска, панель под execute-блоком, очередь автозапусков и
 * логика автопилота (дедуп, история, loop-guard, лимиты). Зависит от AX (core)
 * и AXDetector.
 */
(function () {
  'use strict';
  const AX = window.AX;
  const D = window.AXDetector;
  if (!AX || !D || AX.__panelLoaded) return;
  AX.__panelLoaded = true;

  const MSG_WEAK_AUTO_OFF = '🔍 EXECUTE?: автозапуск для таких блоков выключен — жми ▶ вручную (или включи «Автозапуск блоков EXECUTE?» в настройках).';
  const MSG_LOOP_OFF = '🛑 Автопилот остановлен (зацикливание) — дальше вручную.';

  // ---------- модалка подтверждения ----------
  AX.confirmModal = function ({ lang, runner, command }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'ax-modal-backdrop';
      const level = D.dangerLevel(command);
      const dangerous = level !== null;
      backdrop.innerHTML =
        '<div class="ax-modal">' +
          '<h3>⚡ Выполнить команду локально?</h3>' +
          '<div class="ax-modal-desc" style="font-size:13px;opacity:.8"></div>' +
          '<div class="ax-runner-row">Среда выполнения: <select class="ax-runner-select ax-modal-select"></select></div>' +
          '<pre></pre>' +
          '<div class="ax-modal-warn"></div>' +
          '<div class="ax-modal-row">' +
            '<button class="ax-btn ax-btn-cancel">Отмена</button>' +
            '<button class="ax-btn ax-btn-confirm">▶ Выполнить</button>' +
          '</div>' +
        '</div>';
      backdrop.querySelector('.ax-modal-desc').textContent = 'Блок ' + lang + ' на вашем ПК (сервер ' + AX.settings.serverUrl + ').';
      const warnBox = backdrop.querySelector('.ax-modal-warn');
      if (level === 'hard') {
        warnBox.className = 'ax-warn ax-danger';
        warnBox.textContent = '⛔ Команда похожа на необратимо опасную (удаление / форматирование / sudo / pipe в shell). Автопилот её не выполнит — только вручную. Запускайте, только если на 100% понимаете, что она делает.';
      } else if (level === 'soft') {
        warnBox.className = 'ax-warn ax-danger';
        warnBox.textContent = '⚠️ В команде есть динамическое выполнение кода (eval/exec/Invoke-Expression). Часто это легитимный код (тесты, генераторы), но проверьте: команда выполняется с вашими правами.';
      } else {
        warnBox.className = 'ax-warn';
        warnBox.textContent = '⚠️ Команда выполнится на вашем компьютере с вашими правами. Проверьте её перед запуском.';
      }
      const confirmBtn = backdrop.querySelector('.ax-btn-confirm');
      if (!dangerous) confirmBtn.classList.add('safe');
      backdrop.querySelector('pre').textContent = command;
      const sel = backdrop.querySelector('.ax-modal-select');
      AX.fillRunnerSelect(sel, runner);
      const onKey = (e) => {
        if (e.key === 'Escape') { cleanup(); resolve({ ok: false }); }
      };
      const cleanup = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop || e.target.closest('.ax-btn-cancel')) { cleanup(); resolve({ ok: false }); }
        if (e.target.closest('.ax-btn-confirm')) { cleanup(); resolve({ ok: true, runner: sel.value }); }
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(backdrop);
      try { backdrop.querySelector('.ax-btn-confirm').focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    });
  };

  AX.fillRunnerSelect = function (sel, current) {
    sel.innerHTML = '';
    for (const [val, label] of D.RUNNER_OPTIONS) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      if (val === current) o.selected = true;
      sel.appendChild(o);
    }
  };

  // ---------- окно результата (для контекстного меню) ----------
  AX.showResultModal = function (formatted, okExit) {
    const backdrop = document.createElement('div');
    backdrop.className = 'ax-modal-backdrop';
    backdrop.innerHTML =
      '<div class="ax-modal">' +
        '<h3 class="ax-modal-title"></h3>' +
        '<pre></pre>' +
        '<div class="ax-modal-row">' +
          '<button class="ax-btn ax-btn-copy">📋 Копировать</button>' +
          '<button class="ax-btn ax-btn-insert">📥 Вставить в чат</button>' +
          '<button class="ax-btn ax-btn-cancel">Закрыть</button>' +
        '</div>' +
      '</div>';
    backdrop.querySelector('.ax-modal-title').textContent = okExit ? '✅ Команда выполнена (exit=0)' : '⚠️ Команда завершилась с ошибкой';
    backdrop.querySelector('pre').textContent = formatted;
    const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
    const cleanup = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    backdrop.querySelector('.ax-btn-copy').onclick = async () => {
      const ok = await AX.copyToClipboard(formatted);
      AX.toast(ok ? 'Вывод скопирован' : 'Не удалось скопировать');
    };
    backdrop.querySelector('.ax-btn-insert').onclick = () => {
      try { AX.insertIntoChat('\n```text\n' + formatted + '\n```\n'); } catch (e) { /* ignore */ }
      AX.silentCopy(formatted);
      cleanup();
    };
    backdrop.querySelector('.ax-btn-cancel').onclick = cleanup;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    try { backdrop.querySelector('.ax-btn-insert').focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  };

  // ---------- запуск произвольного текста (контекстное меню) ----------
  let arbitraryRunning = false;
  AX.runArbitrary = async function (text, defaultRunner) {
    const command = (text || '').trim();
    if (!command) { AX.toast('Ничего не выделено'); return; }
    let runRunner = defaultRunner || 'shell';
    if (runRunner === 'shell') {
      const sniffed = D.sniffRunner(command);
      if (sniffed) runRunner = sniffed;
    }
    if (AX.settings.requireConfirm || D.isHardDangerous(command)) {
      const res = await AX.confirmModal({ lang: 'selection', runner: runRunner, command });
      if (!res || !res.ok) return;
      runRunner = res.runner || runRunner;
    }
    if (arbitraryRunning) { AX.toast('Уже выполняется — дождись результата'); return; }
    arbitraryRunning = true;
    AX.toast('⏳ Выполняется локально…');
    const mySeq = ++AX.axSeq;
    AX.safeSend(
      { type: 'AX_RUN', payload: { command, runner: runRunner, timeout: AX.settings.timeout, cwd: AX.settings.defaultCwd || undefined } },
      (resp) => {
        arbitraryRunning = false;
        if (!resp || !resp.ok) {
          AX.toast('❌ ' + ((resp && resp.error) || 'нет ответа') + ' — запущен ли server.py?');
          return;
        }
        const r = resp.result || {};
        if (r.blocked) {
          AX.toast('\u26d4 Whitelist: ' + (r.error || 'команда не разрешена'));
          return;
        }
        AX.markExecuted(command, r.runner || runRunner);
        const formatted = AX.formatRunResult(command, runRunner, r, mySeq, 'full');
        AX.showResultModal(formatted, r.exit_code === 0);
      }
    );
  };

  // ---------- очередь автозапусков ----------
  function updateQueueStatuses() {
    AX.autoQueue.forEach((h, i) => { try { h.showQueued(i); } catch (e) { /* ignore */ } });
  }

  function dequeueAuto(handle) {
    const ix = AX.autoQueue.indexOf(handle);
    if (ix >= 0) AX.autoQueue.splice(ix, 1);
    if (AX.autoActive && AX.currentAuto === handle) { AX.autoActive = false; AX.currentAuto = null; }
    updateQueueStatuses();
    AX.pumpAutoQueue();
  }
  AX.dequeueAuto = dequeueAuto;

  function enqueueAuto(handle) {
    if (!AX.autoQueue.includes(handle)) AX.autoQueue.push(handle);
    updateQueueStatuses();
    AX.pumpAutoQueue();
  }
  AX.enqueueAuto = enqueueAuto;

  AX.pumpAutoQueue = function () {
    if (AX.autoActive) return;
    let h = null;
    while (AX.autoQueue.length) {
      const cand = AX.autoQueue[0];
      const dead = cand.el && !cand.el.isConnected;
      if (dead || cand.claimed) { AX.autoQueue.shift(); updateQueueStatuses(); continue; }
      h = cand;
      break;
    }
    if (!h) return;
    AX.autoActive = true;
    AX.currentAuto = h;
    h.claimed = true;
    try {
      h.runNow(() => {
        const ix = AX.autoQueue.indexOf(h);
        if (ix >= 0) AX.autoQueue.splice(ix, 1);
        if (AX.currentAuto === h) { AX.autoActive = false; AX.currentAuto = null; }
        updateQueueStatuses();
        AX.pumpAutoQueue();
      });
    } catch (e) {
      const ix = AX.autoQueue.indexOf(h);
      if (ix >= 0) AX.autoQueue.splice(ix, 1);
      AX.autoActive = false;
      AX.currentAuto = null;
      updateQueueStatuses();
      AX.pumpAutoQueue();
    }
  };

  // ---------- панель под блоком ----------
  AX.buildPanel = function (pre, info, command, flags) {
    flags = flags || {};
    const createdCmd = (command || '').trim();
    const panel = document.createElement('div');
    panel.className = 'ax-exec-panel';
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) panel.classList.add('ax-dark');
    AX.applyPanelAppearance(panel);

    panel.innerHTML =
      '<div class="ax-exec-header"><span class="ax-exec-badge">⚡ EXECUTE</span>' +
      '<select class="ax-runner-select" title="Среда выполнения (можно переключить)"></select>' +
      '<button class="ax-btn ax-btn-run">▶ Выполнить</button>' +
      '<button class="ax-btn ax-btn-copy ax-btn-icon" title="Скопировать команду">📋</button></div>' +
      '<div class="ax-exec-cmd-preview"></div>' +
      '<div class="ax-exec-status"></div>' +
      '<div class="ax-exec-output" style="display:none"></div>' +
      '<div class="ax-exec-after" style="display:none">' +
        '<button class="ax-btn ax-btn-insert">📥 В чат</button>' +
        '<button class="ax-btn ax-btn-copy ax-btn-copy-out ax-btn-icon" title="Скопировать вывод">📋</button>' +
      '</div>';

    if (flags.weak) {
      panel.querySelector('.ax-exec-badge').textContent = '⚡ EXECUTE?';
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;opacity:.75;font-weight:500';
      note.textContent = AX.settings.autoWeak
        ? '🔍 находка нестрогая (EXECUTE?) — автозапуск разрешён'
        : '🔍 находка нестрогая (EXECUTE?) — только вручную';
      panel.querySelector('.ax-exec-header').appendChild(note);
    }
    const runnerSelect = panel.querySelector('.ax-runner-select');
    AX.fillRunnerSelect(runnerSelect, AX.memGet(command) || info.runner);
    runnerSelect.onchange = () => AX.memSet(command, runnerSelect.value);
    function panelRunner() {
      try { return (runnerSelect && runnerSelect.value) || info.runner; }
      catch (e) { return info.runner; }
    }
    function maybeResniff(cmd) {
      try {
        if (runnerSelect.value === 'shell' && info.runner === 'shell' && !AX.memGet(cmd)) {
          const sn = D.sniffRunner(cmd);
          if (sn) runnerSelect.value = sn;
        }
      } catch (e) { /* ignore */ }
      return panelRunner();
    }
    let previewExpanded = false;
    let previewCmd = command;
    renderPreview();
    panel.querySelector('.ax-exec-cmd-preview').onclick = () => { previewExpanded = !previewExpanded; renderPreview(); };

    const btnRun = panel.querySelector('.ax-btn-run');
    const btnCopy = panel.querySelector('.ax-btn-copy');
    const status = panel.querySelector('.ax-exec-status');
    const outBox = panel.querySelector('.ax-exec-output');
    const after = panel.querySelector('.ax-exec-after');
    let lastFormatted = '';
    let lastChatFormatted = '';

    function renderPreview() {
      const box = panel.querySelector('.ax-exec-cmd-preview');
      if (previewExpanded) {
        box.textContent = '▾ ' + (previewCmd || '(пустая команда)');
        box.classList.add('expanded');
        box.title = 'Свернуть';
      } else {
        const first = (previewCmd || '').split('\n')[0] || '(пустая команда)';
        box.textContent = '▸ ' + first + ((previewCmd || '').includes('\n') ? ' …' : '');
        box.classList.remove('expanded');
        box.title = 'Показать команду полностью';
      }
    }

    btnCopy.onclick = async () => {
      const ok = await AX.copyToClipboard(D.getCodeText(pre) || command);
      AX.toast(ok ? 'Команда скопирована' : 'Не удалось скопировать');
    };

    function refreshPreview(cmd) { previewCmd = cmd; renderPreview(); }

    async function doRun(cmdOverride, isAuto, onDone) {
      const done = () => { try { onDone && onDone(); } catch (e) { /* ignore */ } };
      if (running) { AX.toast('Уже выполняется — дождись результата'); done(); return; }
      running = true;
      const fin = () => { running = false; done(); };
      if (!isAuto) { AX.loopBlocked = false; AX.lastAutoCommands = []; }
      const cmd = ((cmdOverride != null ? cmdOverride : D.getCodeText(pre)) || '').trim();
      if (!cmd) { AX.toast('Пустая команда'); fin(); return; }
      refreshPreview(cmd);
      let runRunner = maybeResniff(cmd);
      const mySeq = ++AX.axSeq;
      if (!isAuto && AX.settings.requireConfirm) {
        const beforeModal = panelRunner();
        const res = await AX.confirmModal({ lang: info.lang, runner: runRunner, command: cmd });
        if (!res || !res.ok) { fin(); return; }
        runRunner = res.runner || runRunner;
        if (runRunner !== beforeModal) { try { AX.memSet(cmd, runRunner); } catch (e) { /* ignore */ } }
        try { runnerSelect.value = runRunner; } catch (e) { /* ignore */ }
      }
      stopAutoTimer();
      btnRun.disabled = true;
      btnRun.textContent = '⏳ Выполняется…';
      status.className = 'ax-exec-status ax-running';
      status.textContent = isAuto ? '🤖 Автопилот: выполняется…' : 'Выполняется локально…';
      outBox.style.display = 'none';
      after.style.display = 'none';

      let runFinished = false;
      let runStatusSent = false;
      const runStatusTimer = AX.settings.autoInsert ? setTimeout(() => {
        if (runFinished || runStatusSent) return;
        runStatusSent = true;
        AX.noteToChat('\n[LOCAL EXEC] seq=' + mySeq + ' status=running runner=' + runRunner + '\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n');
      }, 800) : null;
      AX.safeSend(
        { type: 'AX_RUN', payload: { command: cmd, runner: runRunner, timeout: AX.settings.timeout, cwd: AX.settings.defaultCwd || undefined } },
        (resp) => {
          runFinished = true;
          if (runStatusTimer) clearTimeout(runStatusTimer);
          btnRun.disabled = false;
          btnRun.textContent = '▶ Выполнить';
          if (!resp) {
            AX.noteToChat('\n[LOCAL EXEC RESULT] seq=' + mySeq + ' status=error\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\nнет ответа от расширения\n');
            status.className = 'ax-exec-status ax-err'; status.textContent = '❌ Нет ответа от расширения.'; fin(); return;
          }
          if (!resp.ok) {
            AX.noteToChat('\n[LOCAL EXEC RESULT] seq=' + mySeq + ' status=error\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n' + resp.error + '\n');
            const looksConn = /fetch|abort|network|ожидания|ECONN|Failed/i.test(resp.error || '');
            status.className = 'ax-exec-status ax-err';
            status.textContent = '❌ Ошибка: ' + resp.error + (looksConn ? ' — запущен ли server.py?' : '');
            AX.toast('❌ ' + resp.error);
            fin();
            return;
          }
          autoHandle.finish();
          const r = resp.result || {};
          if (r.blocked) {
            AX.noteToChat('\n[LOCAL EXEC RESULT] seq=' + mySeq + ' status=blocked reason=whitelist\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n' + (r.error || '') + '\n');
            status.className = 'ax-exec-status ax-err';
            status.textContent = '\u26d4 Whitelist: ' + (r.error || 'команда не разрешена');
            AX.toast('\u26d4 ' + (r.error || 'Заблокировано whitelist'));
            fin();
            return;
          }
          AX.markExecuted(cmd, r.runner || runRunner);
          lastFormatted = AX.formatRunResult(cmd, runRunner, r, mySeq, 'full');
          lastChatFormatted = AX.formatRunResult(cmd, runRunner, r, mySeq, AX.settings.echoMode);
          if (r.view) {
            try { AX.renderView(panel, r.view); } catch (e) { /* ignore */ }
            try { Promise.resolve(AX.insertImageIntoChat(r.view)).catch((e) => console.warn('[AX] view insert:', e)); } catch (e) { /* ignore */ }
          }
          const okExit = r.view ? true : (r.exit_code === 0);
          status.className = 'ax-exec-status ' + (okExit ? 'ax-ok' : 'ax-err');
          if (r.view) {
            status.textContent = '🖼️ view: ' + r.view.path + ' (' + r.view.mime + ', ' + Math.round(r.view.size / 1024) + ' KB) #' + mySeq;
          } else {
            status.textContent = (okExit ? '✅ exit=0' : '⚠️ exit=' + r.exit_code) + ' #' + mySeq + ' • stdout: ' + (r.stdout || '').length + ' симв. • stderr: ' + (r.stderr || '').length + ' симв.';
          }
          outBox.textContent = lastFormatted;
          outBox.style.display = 'block';
          after.style.display = 'flex';
          AX.playBeep(okExit);
          AX.notifyDone(okExit, cmd);
          if (AX.settings.collapseAfterRun) panel.classList.add('ax-collapsed');
          if (AX.settings.autoInsert && lastChatFormatted) {
            try {
              const input = AX.insertIntoChat('\n```text\n' + lastChatFormatted + '\n```\n');
              if (input && AX.settings.autoSend) { AX.autoSendToChat(input, fin); return; }
            } catch (e) { console.warn('[AX] insert:', e); }
          }
          fin();
        }
      );
    }

    btnRun.onclick = () => { stopAutoTimer(); dequeueAuto(autoHandle); doRun(null, false); };

    // ---------- автозапуск этой панели ----------
    let autoTimer = null;
    let settleCancelFn = null;
    let autoCancelled = false;
    let running = false;
    let phase2 = false;
    let forceAutoOnce = false;

    function stopAutoTimer(msg) {
      autoCancelled = true;
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      if (settleCancelFn) { settleCancelFn(); settleCancelFn = null; }
      const cb = panel.querySelector('.ax-btn-cancel-auto');
      if (cb) cb.remove();
      if (msg) { status.className = 'ax-exec-status'; status.textContent = msg; }
    }

    function startAuto() {
      if (autoHandle.started || autoHandle.done || autoCancelled) return;
      autoHandle.started = true;
      if (flags.weak && !AX.settings.autoWeak) {
        status.className = 'ax-exec-status';
        status.textContent = MSG_WEAK_AUTO_OFF;
        return;
      }
      if (!AX.settings.autoExecute) return;
      if (AX.loopBlocked) {
        status.className = 'ax-exec-status';
        status.textContent = MSG_LOOP_OFF;
        return;
      }
      ensureCancelBtn();
      enqueueAuto(autoHandle);
    }

    function ensureCancelBtn() {
      if (panel.querySelector('.ax-btn-cancel-auto')) return;
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ax-btn ax-btn-copy ax-btn-cancel-auto';
      cancelBtn.textContent = '✋ Отмена авто';
      cancelBtn.onclick = () => { stopAutoTimer('Автозапуск отменён — нажмите ▶ вручную.'); dequeueAuto(autoHandle); };
      panel.querySelector('.ax-exec-header').appendChild(cancelBtn);
    }

    function showQueued(i) {
      if (phase2 || autoHandle.done || autoCancelled) return;
      status.className = 'ax-exec-status ax-running';
      status.textContent = i === 0 ? '🤖 Автопилот: подготовка…' : '🤖 В очереди на автозапуск (#' + (i + 1) + ')…';
    }

    function runAutoNow(onDone) {
      const finQ = () => { try { onDone && onDone(); } catch (e) { /* ignore */ } };
      const bypassChecks = forceAutoOnce;
      forceAutoOnce = false;
      if (autoCancelled || autoHandle.done) { finQ(); return; }
      if (!AX.settings.autoExecute) {
        AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=auto-disabled (выключено в настройках)\n');
        status.className = 'ax-exec-status';
        status.textContent = 'Автовыполнение выключено в настройках — нажмите ▶ вручную.';
        finQ(); return;
      }
      if (flags.weak && !AX.settings.autoWeak) {
        AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=weak-disabled (блок EXECUTE?, автозапуск выключен)\n');
        status.className = 'ax-exec-status';
        status.textContent = MSG_WEAK_AUTO_OFF;
        finQ(); return;
      }
      if (AX.loopBlocked) {
        AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=loop-guard (зацикливание, автопилот остановлен)\n');
        status.className = 'ax-exec-status';
        status.textContent = MSG_LOOP_OFF;
        finQ(); return;
      }
      phase2 = true;
      const runLim = +AX.settings.maxAutoRuns || 0;
      if (runLim > 0 && AX.autoRunCount >= runLim) {
        AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=tab-limit (' + runLim + ')\n');
        status.className = 'ax-exec-status';
        status.textContent = '🛑 Лимит автозапусков (' + runLim + ') на вкладку исчерпан — дальше вручную.';
        finQ(); return;
      }
      status.className = 'ax-exec-status ax-running';
      status.textContent = '🤖 Автопилот: жду конца генерации…';
      settleCancelFn = AX.waitForSettle(pre, (settled) => {
        settleCancelFn = null;
        try {
          if (autoCancelled) { finQ(); return; }
          const cmd = (settled || '').trim();
          if (!cmd) { stopAutoTimer('Пустая команда — пропуск.'); finQ(); return; }
          maybeResniff(cmd);
          if (D.isHardDangerous(cmd)) {
            AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=dangerous-manual-only\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n');
            stopAutoTimer();
            status.className = 'ax-exec-status ax-err';
            status.textContent = '⛔ Опасная команда: только вручную кнопкой ▶.';
            finQ(); return;
          }
          const dup = AX.dupAge(cmd, panelRunner());
          if (dup > 0) {
            AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=duplicate age=' + dup + 's\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n');
            stopAutoTimer('⏭ Дубль: такая команда уже выполнялась ' + dup + 'с назад — пропуск (жми ▶ для повтора).');
            finQ(); return;
          }
          if (!bypassChecks) {
            const hist = AX.historyAge(cmd, panelRunner());
            if (hist > 0) {
              AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=already-executed age=' + hist + 's\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n');
              stopAutoTimer('⏭ Уже выполнялась раньше (' + AX.fmtAge(hist) + ' назад) — пропуск (жми ▶ для повтора).');
              finQ(); return;
            }
            if (!flags.forced && Date.now() - AX.AX_BOOT < AX.BOOT_GRACE_MS && createdCmd && cmd === createdCmd) {
              AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=old-block (был на странице при загрузке)\n$ ' + AX.echoCommand(cmd, AX.settings.echoMode) + '\n');
              stopAutoTimer('⏭ Блок уже был на странице при загрузке — автозапуск пропущен (жми ▶).');
              finQ(); return;
            }
          }
          refreshPreview(cmd);
          AX.lastAutoCommands.push(cmd);
          if (AX.lastAutoCommands.length > 5) AX.lastAutoCommands.shift();
          if (AX.lastAutoCommands.length >= 3 && AX.lastAutoCommands.slice(-3).every((c) => c === cmd)) {
            AX.loopBlocked = true;
            AX.noteToChat('\n[LOCAL EXEC] status=skipped reason=loop-guard (одна команда 3 раза подряд)\n');
            stopAutoTimer('🛑 Одна и та же команда 3 раза подряд — автопилот остановлен, дальше вручную.');
            AX.toast('🛑 Похоже на зацикливание ИИ — автопилот выключен');
            finQ(); return;
          }
          const d = +AX.settings.autoDelay;
          const left0 = (Number.isFinite(d) ? Math.max(0, Math.min(30, d)) : 3);
          const fireAt = Date.now() + left0 * 1000;
          const tick = () => {
            const rem = Math.max(0, Math.ceil((fireAt - Date.now()) / 1000));
            status.textContent = '🤖 Автозапуск через ' + rem + 'с… (✋ Отмена авто — остановить)';
          };
          const fire = () => {
            AX.autoRunCount++;
            AX.markAutoRun(cmd, panelRunner());
            const cb = panel.querySelector('.ax-btn-cancel-auto');
            if (cb) cb.remove();
            doRun(cmd, true, finQ);
          };
          if (left0 <= 0) { fire(); return; }
          tick();
          autoTimer = setInterval(() => {
            if (autoCancelled) { if (autoTimer) clearInterval(autoTimer); autoTimer = null; finQ(); return; }
            if (Date.now() >= fireAt) { if (autoTimer) clearInterval(autoTimer); autoTimer = null; fire(); }
            else tick();
          }, 1000);
        } catch (e) { console.warn('[AX] auto:', e); stopAutoTimer('Ошибка автозапуска — жми ▶ вручную.'); finQ(); }
      });
    }

    panel.querySelector('.ax-btn-insert').onclick = () => {
      const forChat = lastChatFormatted || lastFormatted;
      try { AX.insertIntoChat('\n```text\n' + forChat + '\n```\n'); } catch (e) { /* ignore */ }
      AX.silentCopy(forChat);
    };
    panel.querySelector('.ax-btn-copy-out').onclick = async () => {
      const ok = await AX.copyToClipboard(lastFormatted);
      AX.toast(ok ? 'Вывод скопирован' : 'Не удалось скопировать');
    };

    const autoHandle = {
      el: panel, started: false, done: false,
      finish() { this.done = true; },
      start() { startAuto(); },
      showQueued(i) { showQueued(i); },
      runNow(cb) { runAutoNow(cb); },
      retry() { if (!this.done) { this.started = false; autoCancelled = false; } this.start(); },
    };
    AX.livePanels.push(autoHandle);
    panel._axStart = () => { try { autoHandle.start(); } catch (e) { console.warn('[AX] autostart:', e); } };

    // Быстрое включение автопилота с панели
    (function addQuickAuto() {
      const needExec = !AX.settings.autoExecute || (flags.weak && !AX.settings.autoWeak);
      if (!needExec || autoHandle.done) return;
      const q = document.createElement('button');
      q.className = 'ax-btn ax-btn-copy ax-btn-quickauto';
      q.textContent = '🤖 Включить авто';
      q.title = 'Включить полный автопилот (выполнение + вставка + отправка) и сохранить в настройках';
      q.onclick = async () => {
        try {
          if (!AX.ctxAlive()) { AX.handleDeadContext(); return; }
          const patch = { autoExecute: true, autoInsert: true, autoSend: true };
          if (flags.weak) patch.autoWeak = true;
          const b = typeof browser !== 'undefined' ? browser : chrome;
          await (b.storage.sync.set ? b.storage.sync.set(patch) : new Promise((res) => chrome.storage.sync.set(patch, res)));
          Object.assign(AX.settings, patch);
          const note = panel.querySelector('.ax-exec-header div');
          if (note && flags.weak) note.textContent = '🔍 находка нестрогая (EXECUTE?) — автозапуск разрешён';
          AX.toast('🤖 Автопилот включён полностью (выполнение + вставка + отправка)');
          q.remove();
          AX.loopBlocked = false;
          AX.lastAutoCommands = [];
          autoHandle.started = false;
          autoCancelled = false;
          forceAutoOnce = true;
          startAuto();
        } catch (e) { AX.toast('Не удалось сохранить настройку'); }
      };
      panel.querySelector('.ax-exec-header').appendChild(q);
    })();

    return panel;
  };

  console.log('[AX] panel loaded');
})();
