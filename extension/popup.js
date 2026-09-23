// Popup: быстрые настройки + проверка сервера + копирование промпта.
// Остальные параметры — на странице настроек (options.html).
const $ = (id) => document.getElementById(id);
let loaded = false; // save блокируется, пока настройки не прочитаны

function clamp(v, lo, hi, fb) {
  v = parseInt(v, 10);
  if (!Number.isFinite(v)) return fb;
  return Math.max(lo, Math.min(hi, v));
}

async function load() {
  let d;
  try {
    d = await chrome.storage.sync.get(['serverUrl', 'timeout', 'requireConfirm', 'autoExecute', 'autoInsert', 'autoSend', 'autoDelay']);
  } catch {
    $('status').className = 'status err';
    $('status').textContent = '❌ Не удалось прочитать настройки (расширение обновляется? закрой попап и открой заново)';
    return;
  }
  if (d.serverUrl) $('serverUrl').value = d.serverUrl;
  if (d.timeout != null) $('timeout').value = d.timeout;
  $('requireConfirm').checked = d.requireConfirm !== false;
  $('autoExecute').checked = d.autoExecute === true;
  $('autoInsert').checked = d.autoInsert === true;
  $('autoSend').checked = d.autoSend === true;
  if (d.autoDelay != null) $('autoDelay').value = d.autoDelay;
  loaded = true;
  updateWarn();
  try { $('ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch {}
  ping();
}

async function ping() {
  const box = $('status');
  box.className = 'status';
  box.textContent = 'Проверка сервера…';
  const serverUrl = $('serverUrl').value.trim();
  chrome.runtime.sendMessage({ type: 'AX_PING', serverUrl }, (resp) => {
    if (resp && resp.ok) {
      box.className = 'status ok';
      box.textContent = '✅ Сервер на связи: ' + JSON.stringify(resp.info);
    } else {
      box.className = 'status err';
      box.textContent = '❌ Сервер недоступен (' + ((resp && resp.error) || 'нет ответа') + '). Запустите: python server.py';
    }
  });
}

function updateWarn() {
  $('autoWarn').style.display = $('autoExecute').checked ? 'block' : 'none';
}

$('save').onclick = async () => {
  if (!loaded) { $('status').className = 'status err'; $('status').textContent = 'Настройки ещё не загружены — подожди секунду'; return; }
  let autoInsert = $('autoInsert').checked;
  const autoSend = $('autoSend').checked;
  if (autoSend && !autoInsert) { autoInsert = true; $('autoInsert').checked = true; }
  await chrome.storage.sync.set({
    serverUrl: $('serverUrl').value.trim() || 'http://127.0.0.1:8765',
    timeout: clamp($('timeout').value, 2, 600, 30),
    requireConfirm: $('requireConfirm').checked,
    autoExecute: $('autoExecute').checked,
    autoInsert,
    autoSend,
    autoDelay: clamp($('autoDelay').value, 0, 30, 3),
  });
  updateWarn();
  ping();
};

$('ping').onclick = ping;

$('copyPrompt').onclick = async () => {
  try {
    await navigator.clipboard.writeText(AX_PROMPT);
    $('copyPrompt').textContent = '✅ Промпт скопирован!';
    setTimeout(() => ($('copyPrompt').textContent = '📋 Скопировать промпт для ИИ'), 2000);
  } catch {
    alert('Не удалось скопировать. Полный промпт лежит в файле SYSTEM_PROMPT.md');
  }
};

$('autoExecute').onchange = updateWarn;
$('autoSend').onchange = () => { if ($('autoSend').checked) $('autoInsert').checked = true; };
$('autoInsert').onchange = () => { if (!$('autoInsert').checked) $('autoSend').checked = false; };
$('openOptions').onclick = () => { chrome.runtime.openOptionsPage(); };

load();
