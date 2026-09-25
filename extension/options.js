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
};

const $ = (id) => document.getElementById(id);
let loaded = false; // save блокируется, пока настройки не прочитаны

function statusMsg(text, kind) {
  const el = $('status');
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.textContent = text;
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
    d = await chrome.storage.sync.get(Object.keys(DEFAULTS));
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
  updateWarn();
  try {
    const v = 'v' + chrome.runtime.getManifest().version;
    $('ver').textContent = v;
    $('ver2').textContent = v;
  } catch {}
  loaded = true;
  try {
    const h = await chrome.storage.local.get(['axExecutedHistory']);
    const n = h && h.axExecutedHistory ? Object.keys(h.axExecutedHistory).length : 0;
    $('histCount').textContent = n;
  } catch {}
  statusMsg('Настройки загружены. Меняй и жми «Сохранить».', '');
}

async function save() {
  if (!loaded) { statusMsg('Настройки ещё не загружены — подожди секунду и попробуй снова', 'err'); return; }
  let autoInsert = $('autoInsert').checked;
  const autoSend = $('autoSend').checked;
  if (autoSend && !autoInsert) { autoInsert = true; $('autoInsert').checked = true; }
  await chrome.storage.sync.set({
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
  });
  updateWarn();
  statusMsg('✅ Настройки сохранены и применены ко всем вкладкам', 'ok');
}

async function resetAll() {
  if (!confirm('Сбросить все настройки к значениям по умолчанию?')) return;
  await chrome.storage.sync.set({ ...DEFAULTS });
  await load();
  statusMsg('↩️ Настройки сброшены к умолчанию', '');
}

async function testConnection() {
  const serverUrl = $('serverUrl').value.trim() || DEFAULTS.serverUrl;
  statusMsg('Проверка сервера…', '');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'AX_PING', serverUrl });
    if (resp && resp.ok) statusMsg('✅ Сервер на связи: ' + JSON.stringify(resp.info), 'ok');
    else statusMsg('❌ Сервер недоступен (' + ((resp && resp.error) || 'нет ответа') + '). Запустите: python server.py', 'err');
  } catch (e) {
    statusMsg('❌ Ошибка: ' + e, 'err');
  }
}

async function copyPrompt() {
  try {
    let ok = false;
    try {
      await navigator.clipboard.writeText(AX_PROMPT);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = AX_PROMPT;
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
$('testBtn').onclick = testConnection;
$('copyPrompt').onclick = copyPrompt;
$('clearHistory').onclick = async () => {
  try {
    await chrome.storage.local.remove(['axExecutedHistory']);
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
