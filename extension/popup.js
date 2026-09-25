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
    d = await axStorageGet('sync', ['serverUrl', 'authToken', 'timeout', 'requireConfirm', 'autoExecute', 'autoInsert', 'autoSend', 'autoDelay']);
  } catch {
    $('status').className = 'status err';
    $('status').textContent = '❌ Не удалось прочитать настройки (расширение обновляется? закрой попап и открой заново)';
    return;
  }
  if (d.serverUrl) $('serverUrl').value = d.serverUrl;
  if (d.authToken) $('authToken').value = d.authToken;
  if (d.timeout != null) $('timeout').value = d.timeout;
  $('requireConfirm').checked = d.requireConfirm !== false;
  $('autoExecute').checked = d.autoExecute === true;
  $('autoInsert').checked = d.autoInsert === true;
  $('autoSend').checked = d.autoSend === true;
  if (d.autoDelay != null) $('autoDelay').value = d.autoDelay;
  loaded = true;
  updateWarn();
  try { $('ver').textContent = 'v' + axApi.runtime.getManifest().version; } catch {}
  ping();
}

async function ping() {
  const box = $('status');
  box.className = 'status';
  box.textContent = 'Проверка сервера…';
  const serverUrl = $('serverUrl').value.trim();
  const pr = axApi.runtime.sendMessage({ type: 'AX_PING', serverUrl });
  if (pr && pr.then) {
    pr.then((resp) => {
      if (resp && resp.ok) {
        const info = resp.info || {};
        if (info.auth_required && info.auth_ok === false) {
          box.className = 'status err';
          box.textContent = '⚠️ Сервер на связи, но токен неверный. Проверь поле «Токен доступа».';
        } else if (info.auth_required && info.auth_ok === true) {
          box.className = 'status ok';
          box.textContent = '✅ Сервер на связи, токен принят: ' + JSON.stringify(info);
        } else {
          box.className = 'status ok';
          box.textContent = '✅ Сервер на связи: ' + JSON.stringify(info);
        }
      } else {
        box.className = 'status err';
        box.textContent = '❌ Сервер недоступен (' + ((resp && resp.error) || 'нет ответа') + '). Запустите: python server.py';
      }
    }).catch((err) => {
      box.className = 'status err';
      box.textContent = '❌ Сервер недоступен (' + ((err && err.message) || 'нет ответа') + '). Запустите: python server.py';
    });
  } else {
    chrome.runtime.sendMessage({ type: 'AX_PING', serverUrl }, (resp) => {
      const err = chrome.runtime.lastError;
      if (!err && resp && resp.ok) {
        const info = resp.info || {};
        if (info.auth_required && info.auth_ok === false) {
          box.className = 'status err';
          box.textContent = '⚠️ Сервер на связи, но токен неверный. Проверь поле «Токен доступа».';
        } else if (info.auth_required && info.auth_ok === true) {
          box.className = 'status ok';
          box.textContent = '✅ Сервер на связи, токен принят: ' + JSON.stringify(info);
        } else {
          box.className = 'status ok';
          box.textContent = '✅ Сервер на связи: ' + JSON.stringify(info);
        }
      } else {
        box.className = 'status err';
        const msg = (err && err.message) || (resp && resp.error) || 'нет ответа';
        box.textContent = '❌ Сервер недоступен (' + msg + '). Запустите: python server.py';
      }
    });
  }
}

function updateWarn() {
  $('autoWarn').style.display = $('autoExecute').checked ? 'block' : 'none';
}

$('save').onclick = async () => {
  if (!loaded) { $('status').className = 'status err'; $('status').textContent = 'Настройки ещё не загружены — подожди секунду'; return; }
  let autoInsert = $('autoInsert').checked;
  const autoSend = $('autoSend').checked;
  if (autoSend && !autoInsert) { autoInsert = true; $('autoInsert').checked = true; }
  await axStorageSet('sync', {
    serverUrl: $('serverUrl').value.trim() || 'http://127.0.0.1:8765',
    authToken: ($('authToken').value || '').trim(),
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
    if (ok) {
      $('copyPrompt').textContent = '✅ Промпт скопирован!';
      setTimeout(() => ($('copyPrompt').textContent = '📋 Скопировать промпт для ИИ'), 2000);
    } else {
      alert('Не удалось скопировать. Полный промпт лежит в файле SYSTEM_PROMPT.md');
    }
  } catch {
    alert('Не удалось скопировать. Полный промпт лежит в файле SYSTEM_PROMPT.md');
  }
};

$('autoExecute').onchange = updateWarn;
$('autoSend').onchange = () => { if ($('autoSend').checked) $('autoInsert').checked = true; };
$('autoInsert').onchange = () => { if (!$('autoInsert').checked) $('autoSend').checked = false; };
$('openOptions').onclick = () => { axApi.runtime.openOptionsPage(); };

load();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
    $('save').click();
  }
});
