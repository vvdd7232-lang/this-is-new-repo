# Проверка собранных артефактов релиза (read-only).
#
# Версия берётся из extension/manifest.json, поэтому при релизе её не нужно
# править здесь: раньше пути были зашиты вручную, и смена версии молча ломала
# проверку (скрипт искал несуществующие файлы и падал на первом же OpenRead).

[CmdletBinding()]
param(
    [string]$Version
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'

if (-not $Version) {
    $manifestPath = Join-Path (Join-Path $root 'extension') 'manifest.json'
    $Version = (Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json).version
}
Write-Host ("==> проверяю артефакты версии {0}" -f $Version)

function Get-EntryText($zipPath, $name) {
    $z = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $e = $z.Entries | Where-Object { $_.FullName -eq $name -or $_.FullName -like "*/$name" } | Select-Object -First 1
        if (-not $e) { return $null }
        $sr = New-Object System.IO.StreamReader($e.Open())
        $t = $sr.ReadToEnd()
        $sr.Close()
        return $t
    } finally { $z.Dispose() }
}

$targets = @(
    (Join-Path $dist "ai-execute-runner-$Version-firefox.xpi"),
    (Join-Path $dist "ai-execute-runner-$Version-chrome.zip"),
    (Join-Path $root 'firefox-addon.xpi')
)
function Get-Entries($zipPath) {
    $z = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try { return @($z.Entries | ForEach-Object { $_.FullName }) } finally { $z.Dispose() }
}

$slashProblems = @()
foreach ($f in $targets) {
    $manifest = Get-EntryText $f 'manifest.json'
    $options = Get-EntryText $f 'options.js'
    $ver = ([regex]'"version":\s*"([^"]+)"').Match($manifest).Groups[1].Value
    $stray = $options -match '(?m)^\s*await\s*$'
    $initTop = $options -match "(?m)^bindSeg\('uiTheme'"
    $panel = Get-EntryText $f 'ax-panel.js'
    $shadow = $panel -match 'attachShadow'
    $entries = Get-Entries $f
    $back = @($entries | Where-Object { $_ -like '*\*' })
    # Без ax-palette.js архив считается битым: манифест на него ссылается,
    # и расширение падает с «Could not load ax-palette.js».
    $hasPalette = $entries -contains 'ax-palette.js'
    Write-Host ("{0,-46} version={1} strayAwait={2} initAtTop={3} shadow={4} palette={5} backslashPaths={6}" -f (Split-Path -Leaf $f), $ver, $stray, $initTop, $shadow, $hasPalette, $back.Count)
    if ($back.Count) { $slashProblems += (Split-Path -Leaf $f) }
    if (-not $hasPalette) { throw "в $f нет ax-palette.js" }
}
if ($slashProblems.Count) {
    throw "обратные слэши в путях записей (ZIP требует прямой '/'): $($slashProblems -join ', ')"
}

$serverZip = Join-Path $dist "ai-execute-runner-$Version-server.zip"
$serverTxt = Get-EntryText $serverZip 'server.py'
# Имя НЕ $ver: в PowerShell имена регистронезависимы, поэтому $ver — это тот же
# самый $Version, и сверка «найденная == ожидаемая» всегда была бы верной.
$serverVer = ([regex]"VERSION = '([^']+)'").Match($serverTxt).Groups[1].Value
$nl = $serverTxt -match '\[\\r\\n\]'
$cyr = $serverTxt.Contains([string][char]0x043B + [string][char]0x043E + [string][char]0x043A)  # "лок"
$pycache = $false
$mcpFiles = @()
$private = @()
$z = [System.IO.Compression.ZipFile]::OpenRead($serverZip)
try {
    $pycache = @($z.Entries | Where-Object { $_.FullName -match '__pycache__|\.pyc$' }).Count -gt 0
    # MCP-клиент и конфиг обязаны попасть в server.zip: без них флаг --mcp
    # упадёт с ImportError, и пользователь не поймёт почему.
    $mcpFiles = @($z.Entries | Where-Object { $_.FullName -match '(mcp_client\.py|mcp_servers\.json)$' } |
                 ForEach-Object { $_.FullName })
    # Личная настройка (как whitelist) в релиз не попадает: в ней пути к файлам
    # конкретного человека. Проверяем явно, а не полагаемся на .gitignore.
    $private = @($z.Entries | Where-Object { $_.FullName -match 'mcp_servers\.local\.json$|whitelist.*\.txt$' } |
                ForEach-Object { $_.FullName })
} finally { $z.Dispose() }
Write-Host ("{0,-46} version={1} newline_rule={2} cyrillic_ok={3} pycache={4}" -f 'server.zip', $serverVer, $nl, $cyr, $pycache)
# Раньше версия просто печаталась: архив со старым server.py проходил проверку
# молча, и его можно было отдать пользователю как свежий релиз.
if ($serverVer -ne $Version) { throw "в server.zip версия $serverVer, а ожидалась $Version" }
if (-not ($mcpFiles -match 'mcp_client\.py$')) { throw "в server.zip нет mcp_client.py" }
if (-not ($mcpFiles -match 'mcp_servers\.json$')) { throw "в server.zip нет mcp_servers.json" }
# Личная настройка (как whitelist) в релиз не попадает: в ней пути к файлам
# конкретного человека. Проверяем явно, а не полагаемся на .gitignore.
if ($private.Count -gt 0) { throw "в server.zip попали личные файлы: $($private -join ', ')" }
Write-Host ("{0,-46} {1}" -f '  MCP-файлы в server.zip', ($mcpFiles -join ', '))
Write-Host ("{0,-46} личных файлов нет (ок)" -f '')
