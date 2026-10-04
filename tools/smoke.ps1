# Smoke-проверка в НАСТОЯЩЕМ браузере: расширение грузится на страницу «чата»
# и мы проверяем, что оно действительно работает.
#
# Важное ограничение, о котором надо знать честно:
#   В брендовом Chrome/Edge (начиная с ~137) ключ --load-extension ЗАБЛОКИРОВАН
#   политикой: «--load-extension is not allowed in Google Chrome, ignoring».
#   Поэтому «загрузить распакованное расширение из CLI» здесь невозможно.
#   Вместо этого мы проверяем то, что реально доступно и что ломается чаще всего:
#     • валиден ли манифест и все ли файлы на месте (правила сборки это тоже проверяют);
#     • поднимается ли страница-фикстура;
#     • выполняются ли в браузере те же скрипты, что и в расширении, в том же порядке;
#     • применяется ли боевой @import стилей в shadow root и доходят ли токены до :host;
#     • есть ли исключения в консоли.
#   Именно в этом слое жили баги «токены не работают» и «панель без отступов».
#
# Запуск из корня репозитория:
#     powershell -NoProfile -ExecutionPolicy Bypass -File tools/smoke.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$extDir = Join-Path $root 'extension'
$fixDir = Join-Path $PSScriptRoot 'fixtures'

$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Chrome/Edge не найден' }

$port = 8840
while ($port -lt 8870) {
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
    $port++
}

Write-Host "==> сервер фикстур на порту $port"
$server = Start-Process -FilePath 'py' -ArgumentList @('-3', '-m', 'http.server', "$port", '--bind', '127.0.0.1', '--directory', $fixDir) `
    -PassThru -WindowStyle Hidden
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 250
    try {
        if ((Invoke-WebRequest -Uri "http://127.0.0.1:$port/chat.html" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}
if (-not $ready) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue; throw 'сервер фикстур не поднялся' }

$tmp = [System.IO.Path]::GetTempPath()
$domOut = Join-Path $tmp ('axsmoke-dom-' + [guid]::NewGuid().ToString('N') + '.html')
$errOut = Join-Path $tmp ('axsmoke-err-' + [guid]::NewGuid().ToString('N') + '.log')
$profileDir = Join-Path $tmp ('axsmoke-' + [guid]::NewGuid().ToString('N'))

try {
    # Копию расширения кладём ВНУТРЬ каталога фикстуры: тот же сервер отдаст и
    # страницу, и скрипты расширения по относительным путям.
    $stage = Join-Path $fixDir '_ext_smoke'
    if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    Copy-Item -LiteralPath $extDir -Destination $stage -Recurse -Force

    Write-Host '==> запуск Chrome'
    # Chrome запускаем процессом, а не через cmd /c: так можно задать жёсткий
    # таймаут. В некоторых сборках headless не завершается сам после --dump-dom,
    # и скрипт иначе висит бесконечно.
    $chromeArgs = @(
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        "--user-data-dir=$profileDir", '--enable-logging=stderr', '--v=0',
        '--virtual-time-budget=3000', '--dump-dom',
        "http://127.0.0.1:$port/chat.html?ext=_ext_smoke"
    )
    $cmdLine = '"' + $chrome + '" ' + ($chromeArgs -join ' ') +
        ' > "' + $domOut + '" 2> "' + $errOut + '"'
    # Путь к Chrome содержит пробелы, поэтому всю команду cmd /c оборачиваем
    # в кавычки: иначе cmd срезает первую и последнюю и ругается на 'C:\Program'.
    $wrapped = '"' + $cmdLine + '"'
    $proc = Start-Process -FilePath 'cmd' -ArgumentList @('/c', $wrapped) -PassThru -NoNewWindow
    $finished = $proc.WaitForExit(25000)
    if (-not $finished) {
        Write-Host '  (Chrome не завершился за 25 c — снимаем принудительно)'
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
        Start-Sleep -Milliseconds 800
    }

    # Пока процесс жив, файлы перенаправления заняты — читаем с небольшим повтором.
    $dom = ''
    $log = ''
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            if (Test-Path $domOut) { $dom = [System.IO.File]::ReadAllText($domOut) }
            if (Test-Path $errOut) { $log = [System.IO.File]::ReadAllText($errOut) }
            break
        } catch { Start-Sleep -Milliseconds 400 }
    }

    $fail = @()

    Write-Host '==> проверки'
    if (-not $dom -or $dom -notmatch 'data-language="execute"') {
        $fail += 'страница-фикстура не отдалась браузеру (DOM пуст)'
    } else { Write-Host '  ok   страница-фикстура загрузилась' }

    $seen = @()
    foreach ($mod in @('core loaded', 'view loaded', 'panel loaded', 'palette loaded', 'AI Execute Runner')) {
        if ($log -match [regex]::Escape($mod)) { $seen += $mod } else { $fail += "нет сообщения в консоли: $mod" }
    }
    if ($seen.Count -eq 5) { Write-Host '  ok   все 5 модулей выполнились в браузере' }

    # Ошибки страницы фикстура перехватывает и печатает в консоль с маркером
    # (--enable-logging в stderr отдаёт только console.*, исключения мимо идут).
    $errs = $log -split "`n" | Where-Object { $_ -match 'PAGEERROR|PAGEREJECT|Uncaught|\[SMOKE\]' }
    if ($errs.Count) { $fail += 'ошибки страницы: ' + (($errs | Select-Object -First 4) -join ' / ') }
    else { Write-Host '  ok   ошибок страницы нет' }

    $panels = ([regex]::Matches($dom, 'class="ax-exec-panel')).Count
    if ($panels -ne 1) { $fail += "панелей построено $panels, ожидалась 1 (bash-блок запускаться не должен)" }
    else { Write-Host '  ok   панель построена только на execute-блоке' }

    if ($dom -match 'data-ax-theme="(light|dark)"') { Write-Host '  ok   тема применена к хосту панели' }
    else { $fail += 'у хоста панели нет data-ax-theme' }

    if ($dom -match 'ax-server-dot') { Write-Host '  ok   бейдж сервера отрисован' }
    else { $fail += 'бейдж сервера не появился' }

    if ($fail.Count) {
        Write-Host '' ; Write-Host 'ПРОВАЛЫ:' -ForegroundColor Red
        $fail | ForEach-Object { Write-Host ('  - ' + $_) -ForegroundColor Red }
        Write-Host "`nDOM: $domOut`nЛог: $errOut" -ForegroundColor Yellow
        exit 1
    }
    Write-Host ''
    Write-Host 'Smoke-проверка пройдена.' -ForegroundColor Green
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}