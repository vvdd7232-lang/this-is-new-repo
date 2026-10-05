/* Тесты MCP-моста: background.js (маршруты /mcp/*, токен, дефолт-выключен),
 * options.js (секция MCP) и соглашения между расширением и сервером.
 *
 * Зачем: MCP — экспериментальная функция, но именно она даёт доступ к
 * Godot/Blender, и поломка сразу заметна. Плюс критично проверить, что всё
 * выключено по умолчанию и что токен не утекает в content-script.
 *
 * Запуск:  cd tests && npm run test:mcp
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT_DIR = path.join(__dirname, '..', 'extension');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(EXT_DIR, f), 'utf8');
const readRoot = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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

// ---------- окружение для background.js ----------
function makeBgEnv(opts) {
  opts = opts || {};
  const store = { sync: Object.assign({}, opts.sync || {}), local: Object.assign({}, opts.local || {}) };
  const calls = { fetch: [] };
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
  let msgListener = null;
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  w.chrome = {
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener() {} } },
    runtime: {
      id: 'test', getManifest: () => ({ version: '2.6.1' }), getURL: (p) => 'chrome-extension://test/' + p,
      onMessage: { addListener: (fn) => { msgListener = fn; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    },
    contextMenus: { create: (o, cb) => { if (cb) cb(); }, removeAll: (cb) => { if (cb) cb(); }, onClicked: { addListener() {} } },
    tabs: { sendMessage() { return Promise.resolve({}); } },
    scripting: { insertCSS: () => Promise.resolve(), executeScript: () => Promise.resolve() },
  };
  if (!w.AbortController) w.AbortController = AbortController;
  w.fetch = (url, init) => {
    calls.fetch.push({ url: String(url), init: init || {} });
    if (opts.fetchImpl) return opts.fetchImpl(String(url), init || {}, calls);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };
  w.eval(read('background.js'));
  const send = (msg) => new Promise((resolve) => {
    let settled = false;
    const keep = msgListener(msg, { id: 1 }, (resp) => { settled = true; resolve(resp); });
    if (keep === true) return;
    setTimeout(() => { if (!settled) resolve({ ok: false, error: 'no-response' }); }, 400);
  });
  return { w, store, calls, send };
}

const jsonOk = (payload) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });

// ---------- 1. background: маршруты и токен ----------
console.log('\n[1] background: MCP-маршруты ходят на сервер с токеном');
(async () => {
  const e = makeBgEnv({
    sync: { serverUrl: 'http://127.0.0.1:8765', timeout: 30 },
    local: { authToken: 'MCP-TOKEN' },
    fetchImpl: jsonOk({ ok: true, enabled: true, servers: [] }),
  });
  await e.send({ type: 'AX_MCP_STATUS' });
  await e.send({ type: 'AX_MCP_TOOLS' });
  await e.send({ type: 'AX_MCP_CALL', payload: { server: 'blender', tool: 'create_cube', args: { size: 2 } } });
  await e.send({ type: 'AX_MCP_RELOAD' });

  const paths = e.calls.fetch.map((c) => c.url.replace('http://127.0.0.1:8765', ''));
  check('AX_MCP_STATUS -> /mcp/servers', paths.indexOf('/mcp/servers') >= 0, paths);
  check('AX_MCP_TOOLS -> /mcp/tools', paths.indexOf('/mcp/tools') >= 0, paths);
  check('AX_MCP_CALL -> /mcp/call', paths.indexOf('/mcp/call') >= 0, paths);
  check('AX_MCP_RELOAD -> /mcp/reload', paths.indexOf('/mcp/reload') >= 0, paths);

  const toolsCall = e.calls.fetch.find((c) => c.url.endsWith('/mcp/tools'));
  check('токен в заголовке', toolsCall && toolsCall.init.headers['X-Auth-Token'] === 'MCP-TOKEN',
    toolsCall && toolsCall.init.headers);
  check('POST-тело — JSON', toolsCall && toolsCall.init.method === 'POST'
    && /application\/json/.test(toolsCall.init.headers['Content-Type']), toolsCall && toolsCall.init.headers);

  const callReq = e.calls.fetch.find((c) => c.url.endsWith('/mcp/call'));
  let body = {};
  try { body = JSON.parse(callReq.init.body); } catch (err) { /* пусто */ }
  check('аргументы уходят как arguments', !!body.arguments && body.arguments.size === 2, body);
  check('server и tool переданы', body.server === 'blender' && body.tool === 'create_cube', body);

  console.log('\n[2] background: без токена заголовок не добавляется');
  const e2 = makeBgEnv({
    sync: { serverUrl: 'http://127.0.0.1:8765' }, local: {},
    fetchImpl: jsonOk({ ok: true, enabled: false, servers: [] }),
  });
  await e2.send({ type: 'AX_MCP_TOOLS' });
  check('заголовка токена нет', !!e2.calls.fetch[0] && !e2.calls.fetch[0].init.headers['X-Auth-Token'],
    e2.calls.fetch[0] && e2.calls.fetch[0].init.headers);

  console.log('\n[3] background: сервер недоступен не роняет расширение');
  const e3 = makeBgEnv({
    sync: { serverUrl: 'http://127.0.0.1:8765' }, local: {},
    fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
  });
  const st3 = await e3.send({ type: 'AX_MCP_STATUS' });
  check('статус вернулся, а не упал', !!(st3 && st3.ok && st3.status), st3);
  check('reachable=false', !!(st3 && st3.status && st3.status.reachable === false), st3 && st3.status);
  const toolsErr = await e3.send({ type: 'AX_MCP_TOOLS' });
  check('инструменты: ok=false с текстом ошибки',
    !!(toolsErr && toolsErr.ok === false && /ECONNREFUSED/.test(String(toolsErr.error))), toolsErr);

  console.log('\n[4] background: MCP выключен на сервере — понятное сообщение');
  const e4 = makeBgEnv({
    sync: { serverUrl: 'http://127.0.0.1:8765' }, local: {},
    fetchImpl: jsonOk({ enabled: false, servers: [], hint: 'запустите сервер с --mcp' }),
  });
  const st4 = await e4.send({ type: 'AX_MCP_STATUS' });
  check('enabled=false распознан', !!(st4 && st4.status && st4.status.enabled === false), st4 && st4.status);
  check('сервер при этом доступен', !!(st4 && st4.status && st4.status.reachable === true), st4 && st4.status);

  // ---------- 5. Выключено по умолчанию ----------
  console.log('\n[5] MCP выключен по умолчанию (и в расширении, и на сервере)');
  const bgJs = read('background.js');
  const optJs = read('options.js');
  const srvPy = readRoot(path.join('server', 'server.py'));
  check('background.js: mcpEnabled по умолчанию false', /mcpEnabled:\s*false/.test(bgJs));
  check('options.js: DEFAULTS.mcpEnabled = false', /mcpEnabled:\s*false/.test(optJs));
  check('options.js: включение только при явном true', /mcpEnabled'\)\.checked = d\.mcpEnabled === true/.test(optJs));
  check('server.py: MCP_REGISTRY = None по умолчанию', /MCP_REGISTRY = None/.test(srvPy));
  check('server.py: флаг --mcp есть', /add_argument\('--mcp'/.test(srvPy));
  const cfg = JSON.parse(readRoot(path.join('server', 'mcp_servers.json')));
  check('поставляемый конфиг: все серверы выключены', cfg.servers.every((s) => s.enabled === false), cfg.servers);

  // ---------- 6. Безопасность ----------
  console.log('\n[6] MCP-эндпоинты закрыты токеном, как /run');
  check('GET /mcp/servers проверяет токен',
    /req_path == '\/mcp\/servers'[\s\S]{0,400}?self\._check_token\(\)/.test(srvPy));
  check('POST /mcp/* проверяет токен',
    /def _mcp_guard[\s\S]{0,400}?self\._check_token\(\)/.test(srvPy)
    && /def _mcp_post[\s\S]{0,200}?self\._mcp_guard\(\)/.test(srvPy));
  check('whitelist блокирует MCP (обход защиты через tools/call)',
    /WHITELIST is not None[\s\S]{0,300}?403/.test(srvPy));
  check('в режиме whitelist MCP отключается, а не проходит молча',
    /whitelist-режим: вызовы MCP заблокированы/.test(srvPy));
  check('README не обещает обхода whitelist',
    !/обходит whitelist/.test(readRoot('README.md')));
  check('MCP-ответ обрезается тем же лимитом, что и shell',
    /_mcp_clip_limit\(\)/.test(srvPy) && /return MAX_OUTPUT/.test(srvPy));
  check('таймаут MCP ограничен сверху',
    /min\(timeout, 600\.0\)/.test(srvPy));
  check('__proto__ и друзья отклоняются',
    /__proto__[\s\S]{0,120}?constructor[\s\S]{0,120}?prototype/.test(srvPy));
  check('do_POST сначала проверяет Host/Origin',
    /def do_POST[\s\S]{0,400}?self\._allowed\(\)[\s\S]{0,400}?_mcp_post/.test(srvPy));
  check('вызов требует server и tool', /нужны поля server и tool/.test(srvPy));
  check('arguments обязан быть объектом', /arguments должен быть объектом/.test(srvPy));
  check('выключенный сервер вызову не подлежит', /выключен/.test(readRoot(path.join('server', 'mcp_client.py'))));

  // ---------- 7. UI ----------
  console.log('\n[7] options: раздел «Экспериментальное» с MCP внутри');
  const optHtml = read('options.html');
  check('есть карточка #sec-exp', /id="sec-exp"/.test(optHtml));
  check('карточка называется «Экспериментальное»',
    /<svg><use href="#i-plug"><\/use><\/svg><\/span>\s*Экспериментальное/.test(optHtml));
  check('на карточке подсказка про MCP', /card-hint">MCP и другие новые функции/.test(optHtml));
  check('есть пункт в боковом меню',
    /<a href="#sec-exp" data-nav="sec-exp"/.test(optHtml));
  check('MCP-блок вложен в sec-exp, а не отдельная карточка',
    /<div class="ax-sub" id="sec-mcp">/.test(optHtml) && !/<details class="card" id="sec-mcp"/.test(optHtml));
  check('есть переключатель #mcpEnabled', /id="mcpEnabled"/.test(optHtml));
  check('визуальный бейдж «экспериментально»', /ax-chip-warn">экспериментально/.test(optHtml));
  check('предупреждение «выключено по умолчанию»', /выключено по умолчанию/.test(optHtml));
  check('указано про флаг --mcp', /--mcp/.test(optHtml));
  check('указано ограничение stdio', /stdio/.test(optHtml));
  check('есть кнопки проверки и перезагрузки', /id="mcpRefresh"/.test(optHtml) && /id="mcpReload"/.test(optHtml));
  check('блок состояний скрыт по умолчанию', /id="mcpBox" hidden/.test(optHtml));
  check('options.js скрывает блок по флажку',
    /function updateMcpBox/.test(optJs) && /box\.hidden = !on/.test(optJs));
  check('options.js не ходит на сервер напрямую', !/fetch\(\s*['"`]http:\/\/127/.test(optJs));
  check('options.js шлёт AX_MCP_* в background',
    /AX_MCP_STATUS/.test(optJs) && /AX_MCP_TOOLS/.test(optJs) && /AX_MCP_RELOAD/.test(optJs));
  const css = read('ax-ui.css');
  check('CSS: стиль врезки-предупреждения', /\.ax-warn-box/.test(css));
  check('CSS: стиль подблока', /\.ax-sub\b/.test(css) && /\.ax-sub-title/.test(css));
  check('CSS: разделитель подблока использует токен темы',
    /\.ax-sub\s*\{[^}]*--ax-border/.test(css));

  // Отчёт по инструментам: без него ИИ выдумывает имена.
  console.log('\n[12] отчёт по инструментам для ИИ');
  check('кнопка «Скопировать список для ИИ»', /id="mcpReport"/.test(optHtml));
  check('кнопка «Сохранить на рабочий стол»', /id="mcpReportSave"/.test(optHtml));
  check('есть поле для статуса отчёта', /id="mcpReportNote"/.test(optHtml));
  check('options.js шлёт AX_MCP_REPORT', /AX_MCP_REPORT/.test(optJs));
  check('options.js вешает оба обработчика',
    /id.*mcpReport.*|report\.addEventListener\('click', \(\) => mcpReport\(false\)\)/.test(optJs)
    && /mcpReportSave/.test(optJs) && /mcpReport\(true\)/.test(optJs));
  check('background знает маршрут AX_MCP_REPORT',
    /msg\.type === 'AX_MCP_REPORT'/.test(bgJs));
  check('background ходит на /mcp/report', /'\/mcp\/report'/.test(bgJs));
  check('сервер отдаёт отчёт и пишет файл',
    /_mcp_tools_report/.test(srvPy) && /mcp-tools\.md/.test(srvPy));
  check('в отчёте есть готовый блок execute-mcp',
    /lines\.append\('```execute-mcp'\)/.test(srvPy));

  // Регрессия: кнопки отчёта стояли ВНУТРИ #mcpBox, который скрыт переключателем
  // «Включить MCP». При mcpEnabled=false (значение по умолчанию) блок скрыт, и
  // кнопок не было видно вообще. Проверка выше смотрела только на наличие id в
  // разметке — и потому этот случай пропускала.
  const mcpBoxAt = optHtml.indexOf('<div id="mcpBox"');
  const reportAt = optHtml.indexOf('id="mcpReport"');
  // Ищем закрывающий </div> блока #mcpBox: идём от его открытия, пока глубина
  // вложенных <div> не вернётся к нулю. Кнопка после этой позиции — снаружи.
  let depth = 0;
  let mcpBoxEndAt = -1;
  for (let i = mcpBoxAt; i !== -1 && i < optHtml.length; i++) {
    if (optHtml.startsWith('<div', i)) depth++;
    else if (optHtml.startsWith('</div>', i)) {
      depth--;
      if (depth === 0) { mcpBoxEndAt = i; break; }
    }
  }
  check('кнопки отчёта находятся ВНЕ скрываемого блока #mcpBox',
    mcpBoxAt !== -1 && mcpBoxEndAt !== -1 && reportAt > mcpBoxEndAt);
  check('отчёт не зависит от переключателя MCP (нет проверки updateMcpBox)',
    !/async function mcpReport\(save\)\s*\{\s*if \(!updateMcpBox\(\)\)/.test(optJs));
  check('поле статуса отчёта тоже вне #mcpBox',
    optHtml.indexOf('id="mcpReportNote"') > mcpBoxEndAt);

  // ---------- 8. Протокол ----------
  console.log('\n[8] MCP-клиент реализует протокол');
  const mcpPy = readRoot(path.join('server', 'mcp_client.py'));
  check('объявлен initialize', /'initialize'/.test(mcpPy));
  check('шлётся notifications/initialized', /notifications\/initialized/.test(mcpPy));
  check('реализован tools/list', /tools\/list/.test(mcpPy));
  check('реализован tools/call', /tools\/call/.test(mcpPy));
  check('заявлена версия протокола', /PROTOCOL_VERSION = '2024-11-05'/.test(mcpPy));
  check('JSON-RPC 2.0', /'jsonrpc': '2\.0'/.test(mcpPy));
  check('ошибка сервера превращается в McpError', /raise McpError\(str\(msg\)\)/.test(mcpPy));
  check('таймаут реализован', /превышено время ожидания/.test(mcpPy));
  check('процессы глушатся при остановке сервера', /MCP_REGISTRY\.shutdown\(\)/.test(srvPy));
  check('мусор в stdout не ломает протокол', /continue\s+# мусор в stdout/.test(mcpPy));

  // ---------- 9. Версии согласованы (релизный процесс) ----------
  console.log('\n[9] версия в манифестах, сервере и MCP-клиенте одна');
  const mf = JSON.parse(read('manifest.json'));
  const mfc = JSON.parse(read('manifest.chrome.json'));
  const srvVer = (/^VERSION = '([^']+)'/m).exec(srvPy)[1];
  const cliVer = (/'version': '([^']+)'/.exec(mcpPy) || [])[1];
  check('manifest.json = manifest.chrome.json', mf.version === mfc.version,
    mf.version + ' / ' + mfc.version);
  check('manifest.json = server.py', mf.version === srvVer, mf.version + ' / ' + srvVer);
  check('manifest.json = mcp_client.py CLIENT_INFO', mf.version === cliVer, mf.version + ' / ' + cliVer);
  check('версия в формате X.Y.Z', /^\d+\.\d+\.\d+$/.test(mf.version), mf.version);

  console.log('\n[10] блок execute-mcp: детект, разбор, приведение результата');
  const det = require(path.join(EXT_DIR, 'ax-detector.js'));
  check('execute-mcp в EXEC_LANGS -> runner mcp', det.EXEC_LANGS.get('execute-mcp') === 'mcp');
  check('execute:mcp -> runner mcp', det.EXEC_LANGS.get('execute:mcp') === 'mcp');
  check('mcp-execute -> runner mcp', det.EXEC_LANGS.get('mcp-execute') === 'mcp');
  check('остальные среды не сломались', det.EXEC_LANGS.get('execute-python') === 'python'
    && det.EXEC_LANGS.get('execute-pwsh') === 'powershell'
    && det.EXEC_LANGS.get('execute') === 'shell');
  check('сниффер не считает mcp за python/node',
    det.sniffRunner('{"server":"a","tool":"b"}') !== 'mcp');
  // Регрессия: без 'mcp' в RUNNER_OPTIONS селект среды для блока execute-mcp
  // оставался на 'shell', и JSON уходил в cmd вместо вызова инструмента.
  check('runnerValid признаёт mcp', det.runnerValid('mcp') === 'mcp');
  check('mcp есть в списке выбора среды',
    det.RUNNER_OPTIONS.some(([v]) => v === 'mcp'),
    det.RUNNER_OPTIONS.map((x) => x[0]));
  check('обычные среды не сломались', det.runnerValid('shell') === 'shell'
    && det.runnerValid('python') === 'python'
    && det.runnerValid('нет-такой') === null);

  // Опасные MCP-инструменты: подтверждение нужно даже при автопилоте.
  console.log('\n[10b] опасные MCP-инструменты требуют подтверждения');
  check('execute_blender_code = hard', det.mcpToolDanger('execute_blender_code') === 'hard');
  check('run_code = hard', det.mcpToolDanger('run_code') === 'hard');
  check('write_file = hard', det.mcpToolDanger('write_file') === 'hard');
  check('export_mesh_library = hard', det.mcpToolDanger('export_mesh_library') === 'hard');
  check('get_scene_info = безопасен', det.mcpToolDanger('get_scene_info') === null);
  check('read_file = безопасен', det.mcpToolDanger('read_file') === null);
  check('блок с опасным инструментом = hard',
    det.mcpBlockDanger('{"server":"blender","tool":"execute_blender_code"}') === 'hard');
  check('блок с безопасным инструментом = null',
    det.mcpBlockDanger('{"server":"blender","tool":"get_scene_info"}') === null);
  check('блок без tool = hard (не знаем, что делает)',
    det.mcpBlockDanger('{"server":"x"}') === 'hard');
  const panelSrc = read('ax-panel.js');
  check('панель спрашивает подтверждение для опасного MCP даже в автопилоте',
    /mcpHard \|\| \(!isAuto && AX\.settings\.requireConfirm\)/.test(panelSrc));
  check('модалка умеет принимать danger и note',
    /function \(\{ lang, runner, command, danger, note \}\)/.test(panelSrc)
    && /const level = danger \|\| D\.dangerLevel\(command\)/.test(panelSrc));

  // Регрессия: обработчики модалки висели на ХОСТЕ закрытого shadow DOM, а
  // такие события до хоста не доходят (проверено в Chrome) — кнопки «Выполнить»
  // и «Отмена» молча не работали. Слушатель должен быть внутри тени.
  console.log('\n[10c] кнопки модалки: слушатель внутри shadow, не на хосте');
  check('confirmModal: слушатель на innerContent, не на backdrop',
    /backdrop\.innerContent\.addEventListener\('click'/.test(panelSrc)
    && !/backdrop\.addEventListener\('click'/.test(panelSrc));
  check('showResultModal: слушатель на innerContent',
    /backdrop\.innerContent\.addEventListener\('click'[\s\S]{0,200}?ax-modal/.test(panelSrc));
  check('клик по фону отменяет, клик по кнопке — нет',
    /!e\.target\.closest\('\.ax-modal'\)/.test(panelSrc)
    && /ax-btn-confirm/.test(panelSrc) && /ax-btn-cancel/.test(panelSrc));
  check('палитра: слушатель внутри тени',
    /overlay\.innerContent\.addEventListener\('mousedown'/.test(read('ax-palette.js'))
    && !/overlay\.addEventListener\('mousedown'/.test(read('ax-palette.js')));

  const coreJs = read('ax-core.js');
  check('ax-core: есть parseMcpBlock', /AX\.parseMcpBlock = function/.test(coreJs));
  check('ax-core: есть mcpResultToRun', /AX\.mcpResultToRun = function/.test(coreJs));
  check('панель шлёт AX_MCP_CALL для runner=mcp',
    /runRunner === 'mcp'/.test(read('ax-panel.js')) && /type: 'AX_MCP_CALL'/.test(read('ax-panel.js')));

  // Промпт должен учить ИИ новому блоку — иначе фича недоступна из чата.
  const promptSrc = read('prompt.js');
  check('промпт упоминает execute-mcp', /execute-mcp/.test(promptSrc));
  check('промпт объясняет JSON-формат', /"server".*"tool".*"arguments"/.test(promptSrc));
  check('промпт запрещает выдумывать инструменты',
    /Не выдумывай имена/.test(promptSrc) && /вернёт ошибку/.test(promptSrc));
  check('промпт упоминает список инструментов (файл на столе)',
    /mcp-tools\.md/.test(promptSrc));
  check('SYSTEM_PROMPT.md синхронизирован', /execute-mcp/.test(readRoot('SYSTEM_PROMPT.md')));

  // Разбор execute-mcp проверяем по-настоящему: грузим ax-core в jsdom и
// вызываем функции — regex по исходнику не поймал бы опечатку в разборе.
console.log('\n[11] разбор блока execute-mcp и приведение результата (jsdom)');
try {
  const { JSDOM: JSDOM2 } = require('jsdom');
  const dom2 = new JSDOM('<!doctype html><body><textarea id="t"></textarea></body>', {
    url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w2 = dom2.window;
  w2.chrome = { storage: { sync: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, local: { get: () => Promise.resolve({}) } }, runtime: { sendMessage: () => Promise.resolve({}), getManifest: () => ({ version: '2.7.0' }) } };
  w2.browser = undefined;
  w2.eval(read('ax-detector.js'));
  w2.eval(read('ax-core.js'));
  const A = w2.AX;

  const p1 = A.parseMcpBlock('{"server":"blender","tool":"create_cube","arguments":{"size":2}}');
  check('корректный блок разобран', p1.ok === true && p1.server === 'blender'
    && p1.tool === 'create_cube' && p1.args.size === 2, p1);

  const p2 = A.parseMcpBlock('{"server":"godot","tool":"run"}');
  check('без arguments — пустой объект', p2.ok === true && A.parseMcpBlock('{"server":"g","tool":"t"}').args !== null
    && Object.keys(p2.args).length === 0, p2);

  const p3 = A.parseMcpBlock('не json');
  check('мусор отклонён с понятной ошибкой', p3.ok === false && /JSON/.test(p3.error), p3);

  const p4 = A.parseMcpBlock('{"tool":"t"}');
  check('без server — ошибка', p4.ok === false && /server/.test(p4.error), p4);

  const p5 = A.parseMcpBlock('{"server":"s","tool":"t","arguments":[1,2]}');
  check('arguments-массив отклонён', p5.ok === false && /объект/.test(p5.error), p5);

  const p6 = A.parseMcpBlock('```json\n{"server":"s","tool":"t"}\n```');
  check('JSON в ограждении ``` разбирается', p6.ok === true && p6.server === 's', p6);

  const r1 = A.mcpResultToRun({ result: { content: [{ type: 'text', text: 'готово' }] } });
  check('ответ превращён в вид /run', r1.runner === 'mcp' && r1.exit_code === 0
    && r1.stdout === 'готово', r1);

  const r2 = A.mcpResultToRun({ result: { content: [{ type: 'text', text: 'ошибка' }], isError: true } });
  check('isError даёт ненулевой exit_code', r2.exit_code === 1 && /isError/.test(r2.stderr), r2);

  const r3 = A.mcpResultToRun({ result: {} });
  check('пустой результат не путается', r3.exit_code === 0 && r3.stdout.length > 0, r3);

  const r4 = A.mcpResultToRun({ result: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } });
  check('несколько content склеиваются', /a[\s\S]*b/.test(r4.stdout), r4.stdout);
} catch (e) {
  check('разбор execute-mcp в jsdom', false, e && e.message);
}

console.log('\n' + '-'.repeat(52));
  console.log('MCP: ' + passed + ' ok, ' + failed + ' fail');
  if (failures.length) {
    console.log('\nПровалы:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error('АВАРИЯ ТЕСТА:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});