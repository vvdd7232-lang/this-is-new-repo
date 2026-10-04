# Скриншоты страниц расширения в headless Chrome — визуальная проверка интерфейса.
#
# Запуск из корня репозитория:
#     powershell -NoProfile -ExecutionPolicy Bypass -File tools/shot.ps1
# Результат: tools/shots/*.png (каталог в git не коммитится)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$extDir = Join-Path $root 'extension'
$outDir = Join-Path $PSScriptRoot 'shots'

if (Test-Path $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $outDir | Out-Null

$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Chrome/Edge не найден' }

# Скриншоты делаем на копиях страниц: без расширения chrome.storage недоступен,
# поэтому подставляем демо-настройки, чтобы на снимке было реальное состояние UI.
$demoScript = @'
<script>
(function () {
  var demo = {
    serverUrl: 'http://127.0.0.1:8765', timeout: 120, requireConfirm: false,
    autoExecute: true, autoInsert: true, autoSend: false, autoDelay: 3, maxAutoRuns: 25,
    autoWeak: false, defaultRunner: 'powershell', looseSearch: true, maxOutputChars: 32000,
    showToasts: true, defaultCwd: 'C:\\Users\\me\\projects', authToken: 'demo-token-not-real',
    uiTheme: 'auto', panelSize: 'normal', collapseAfterRun: true, soundOnComplete: true,
    browserNotify: true, echoMode: 'short', paletteEnabled: true, noisyCollapse: true
  };
  var text = { serverUrl: demo.serverUrl, timeout: demo.timeout, autoDelay: demo.autoDelay,
    maxAutoRuns: demo.maxAutoRuns, maxOutputChars: demo.maxOutputChars, authToken: demo.authToken,
    defaultCwd: demo.defaultCwd };
  var checks = { requireConfirm: demo.requireConfirm, autoExecute: demo.autoExecute, autoInsert: demo.autoInsert,
    autoSend: demo.autoSend, autoWeak: demo.autoWeak, looseSearch: demo.looseSearch, showToasts: demo.showToasts,
    browserNotify: demo.browserNotify, collapseAfterRun: demo.collapseAfterRun, soundOnComplete: demo.soundOnComplete,
    paletteEnabled: demo.paletteEnabled, noisyCollapse: demo.noisyCollapse };
  function seg(id, v) {
    var g = document.getElementById(id);
    if (!g) return;
    Array.prototype.forEach.call(g.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.dataset.v === v); });
  }
  function apply() {
    for (var k in text) { var el = document.getElementById(k); if (el) el.value = text[k]; }
    for (var k2 in checks) { var c = document.getElementById(k2); if (c) c.checked = checks[k2]; }
    var r = document.getElementById('defaultRunner'); if (r) r.value = demo.defaultRunner;
    seg('echoMode', demo.echoMode); seg('uiTheme', 'auto'); seg('panelSize', demo.panelSize);
    var st = document.getElementById('status');
    if (st) { st.className = 'status ok'; st.textContent = '\u2705 Сервер на связи: версия 2.8.0, whitelist выключен'; }
    var wl = document.getElementById('whitelistInfo');
    if (wl) { wl.className = 'ax-chip ax-chip-warn'; wl.textContent = 'Whitelist выключен — рекомендуется --whitelist'; }
    var hc = document.getElementById('histCount'); if (hc) hc.textContent = '3';
    var jc = document.getElementById('journalCount'); if (jc) jc.textContent = '18 записей';
    var warn = document.getElementById('autoWarn'); if (warn) warn.style.display = 'none';
    var dot = document.getElementById('dirtyDot'); if (dot) dot.classList.add('on');
    // ?focus=sec-palette — снимок только этого раздела. Прокрутка ненадёжна
    // (страница сама восстанавливает позицию), поэтому прячем остальные карточки.
    var m = /[?&]focus=([\w-]+)/.exec(location.search);
    if (m) {
      setTimeout(function () {
        var target = document.getElementById(m[1]);
        if (!target) return;
        var cards = document.querySelectorAll('details.card');
        for (var i = 0; i < cards.length; i++) if (cards[i] !== target) cards[i].style.display = 'none';
        var status = document.getElementById('status');
        if (status) status.style.display = 'none';
        // visibility, а не display: иначе пропадает колонка грида и карточка
        // схлопывается в узкую полосу.
        var nav = document.querySelector('.sidenav');
        if (nav) nav.style.visibility = 'hidden';
        window.scrollTo(0, 0);
      }, 120);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(apply, 60); });
  else setTimeout(apply, 60);
  window.addEventListener('load', function () { setTimeout(apply, 300); });
})();
</script>
'@

# Варианты страниц (тема + демо-данные) отдаём отдельными файлами-обёртками.
$wrappers = @()

# Полигон панели лежит в tools/ (инструмент разработки) и копируется в extension/
# только на время съёмки — в релиз он не попадает.
$previewSrc = Join-Path $PSScriptRoot 'panel-preview.html'
$previewDst = Join-Path $extDir '_preview_panel.html'
if (Test-Path -LiteralPath $previewSrc) {
    Copy-Item -LiteralPath $previewSrc -Destination $previewDst -Force
    $wrappers += $previewDst
}

$pages = @(
    @{ src = 'options.html'; out = '_shot_options_light.html'; theme = 'light' },
    @{ src = 'options.html'; out = '_shot_options_dark.html'; theme = 'dark' },
    @{ src = 'popup.html'; out = '_shot_popup_light.html'; theme = 'light' },
    @{ src = 'popup.html'; out = '_shot_popup_dark.html'; theme = 'dark' }
)
foreach ($page in $pages) {
    $html = [System.IO.File]::ReadAllText((Join-Path $extDir $page.src))
    $html = $html -replace '<html lang="ru">', ('<html lang="ru" data-ax-theme="' + $page.theme + '">')
    $html = $html -replace '</body>', ($demoScript + '</body>')
    $dest = Join-Path $extDir $page.out
    [System.IO.File]::WriteAllText($dest, $html, (New-Object System.Text.UTF8Encoding($false)))
    $wrappers += $dest
}

# Статический сервер на python — надёжнее самодельного HttpListener в PowerShell.
# Порт выбираем свободный: прошлый запуск мог оставить слушателя.
$port = 8800
while ($port -lt 8830) {
    $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $busy) { break }
    $port++
}
$server = Start-Process -FilePath 'py' -ArgumentList @('-3', '-m', 'http.server', "$port", '--bind', '127.0.0.1', '--directory', $extDir) `
    -PassThru -WindowStyle Hidden

# Ждём готовности сервера и проверяем, что отдаётся именно страница, а не мусор.
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 250
    try {
        $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$port/options.html" -UseBasicParsing -TimeoutSec 3
        if ($probe.StatusCode -eq 200 -and $probe.Content -match '<title>') { $ready = $true; break }
    } catch { }
}
if (-not $ready) { throw "статический сервер не поднялся на порту $port" }
Write-Host "==> сервер: http://127.0.0.1:$port (options.html = $($probe.RawContentLength) B)"

function Take-Shot($url, $fileName, $size) {
    $out = Join-Path $outDir $fileName
    $profile = Join-Path ([System.IO.Path]::GetTempPath()) ('axshot-' + [guid]::NewGuid().ToString('N'))
    $chromeArgs = @(
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
        "--user-data-dir=$profile", "--screenshot=$out", "--window-size=$size",
        '--force-device-scale-factor=1', '--virtual-time-budget=3000', $url
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $chrome @chromeArgs 2>&1 | Out-Null } finally { $ErrorActionPreference = $prev }
    Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $out) { Write-Host ('  ok   {0} ({1:N0} B)' -f $fileName, (Get-Item $out).Length) }
    else { Write-Host ('  FAIL {0}' -f $fileName) }
}

try {
    Write-Host '==> Светлая тема'
    Take-Shot "http://127.0.0.1:$port/_shot_options_light.html" 'options-light.png' '1280,1700'
    Take-Shot "http://127.0.0.1:$port/_shot_popup_light.html" 'popup-light.png' '420,1000'

    Write-Host '==> Тёмная тема'
    Take-Shot "http://127.0.0.1:$port/_shot_options_dark.html" 'options-dark.png' '1280,1700'
    Take-Shot "http://127.0.0.1:$port/_shot_popup_dark.html" 'popup-dark.png' '420,1000'

    Write-Host '==> Раздел «Палитра и журнал»'
    Take-Shot "http://127.0.0.1:$port/_shot_options_light.html?focus=sec-palette" 'options-palette.png' '1280,860'

    if (Test-Path -LiteralPath $previewDst) {
        Write-Host '==> Панель под кодом и диалоги'
        Take-Shot "http://127.0.0.1:$port/_preview_panel.html" 'panel-preview.png' '980,3200'
        Take-Shot "http://127.0.0.1:$port/_preview_panel.html?only=modals" 'panel-dialogs.png' '1080,660'
        Write-Host '==> Палитра команд (Ctrl+Shift+E) и свёрнутый вывод'
        Take-Shot "http://127.0.0.1:$port/_preview_panel.html?only=palette" 'palette.png' '900,760'
    }
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    foreach ($path in $wrappers) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
}

Write-Host "Готово: $outDir"
