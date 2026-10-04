# Сборка артефактов релиза: dist/ai-execute-runner-<версия>-{chrome.zip,firefox.xpi,server.zip}
#
# Зачем скрипт: раньше dist/ собирался вручную, из-за чего в артефакты уезжали
# уже исправленные и неисправленные версии вперемешку (например, баг с
# инициализацией страницы настроек попал во ВСЕ собранные архивы).
#
# Запуск из корня репозитория:
#     pwsh -File tools/build-release.ps1
#     pwsh -File tools/build-release.ps1 -Version 2.7.0
#
# Версия берётся из extension/manifest.json, если не задана явно.

[CmdletBinding()]
param(
    [string]$Version
)

$ErrorActionPreference = 'Stop'
# Без этого [System.IO.Compression.ZipFile] недоступен в Windows PowerShell 5.1.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$extDir = Join-Path $root 'extension'
$serverDir = Join-Path $root 'server'
$distDir = Join-Path $root 'dist'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# --- версия ---
$manifestPath = Join-Path $extDir 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$chromeManifest = Get-Content -LiteralPath (Join-Path $extDir 'manifest.chrome.json') -Raw -Encoding utf8 | ConvertFrom-Json
$serverVersion = (Select-String -LiteralPath (Join-Path $serverDir 'server.py') -Pattern "^VERSION = '([^']+)'" |
    Select-Object -First 1).Matches[0].Groups[1].Value

if (-not $Version) { $Version = $manifest.version }

Write-Step "Проверка согласованности версий (ожидается $Version)"
$mismatch = @()
if ($manifest.version -ne $Version) { $mismatch += "extension/manifest.json = $($manifest.version)" }
if ($chromeManifest.version -ne $Version) { $mismatch += "extension/manifest.chrome.json = $($chromeManifest.version)" }
if ($serverVersion -ne $Version) { $mismatch += "server/server.py = $serverVersion" }
if ($mismatch.Count -gt 0) {
    throw "Версии расходятся:`n  " + ($mismatch -join "`n  ")
}

# --- чистая сборка ---
if (Test-Path $distDir) { Remove-Item -LiteralPath $distDir -Recurse -Force }
New-Item -ItemType Directory -Path $distDir | Out-Null

# Мусор, который не должен попадать в релиз: кэш Python, системные файлы,
# локальные бэкапы и служебные полигоны для визуальной проверки.
$excludeDirs = @('__pycache__', 'node_modules', '.git')
$excludeFiles = @('*.pyc', '*.pyo', '*.bak', '.DS_Store', 'Thumbs.db')
# _preview_panel.html лежит рядом со страницами расширения, но это инструмент
# разработки (полигон панели), а не часть расширения.
$excludeExact = @('_preview_panel.html')

function New-ZipFromDir($sourceDir, $zipPath, $includeRoot) {
    # Собираем через .NET, а не Compress-Archive: во-первых, .xpi не принимается
    # Compress-Archive, во-вторых, .NET пишет прямые слэши в именах записей
    # (архив корректно распаковывается и на Linux/macOS).
    $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("axbuild-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $payloadDir = $stage
        if ($includeRoot) {
            $payloadDir = Join-Path $stage (Split-Path -Leaf $sourceDir)
            New-Item -ItemType Directory -Path $payloadDir | Out-Null
        }
        Get-ChildItem -LiteralPath $sourceDir -Force | Where-Object {
            $_.Name -notin $excludeDirs -and $_.Name -notin $excludeExact -and $_.Name -notlike '*.bak'
        } | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $payloadDir -Recurse -Force
        }
        # вычищаем исключения внутри скопированного дерева
        foreach ($d in $excludeDirs) {
            Get-ChildItem -LiteralPath $payloadDir -Recurse -Force -Directory -Filter $d -ErrorAction SilentlyContinue |
                Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        }
        foreach ($pat in $excludeFiles) {
            Get-ChildItem -LiteralPath $payloadDir -Recurse -Force -File -Filter $pat -ErrorAction SilentlyContinue |
                Remove-Item -Force -ErrorAction SilentlyContinue
        }
        [System.IO.Compression.ZipFile]::CreateFromDirectory(
            $payloadDir, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
        Write-ZipWithForwardSlashes $zipPath
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Пересобирает архив с прямыми слэшами в именах записей.
#
# Зачем: [ZipFile]::CreateFromDirectory на .NET Framework 4.x (Windows
# PowerShell 5.1) пишет разделитель пути ОС, то есть «icons\icon48.png».
# Спецификация ZIP (APPNOTE 4.4.17.1) требует прямой слэш, и unzip/7-Zip на
# Linux/macOS считают такой путь именем файла, а не каталога. Firefox при
# установке .xpi такие иконки не находит → расширение без иконок.
# На .NET Core/PowerShell 7 это уже исправлено, но скрипт должен работать
# и на 5.1 — значит, пути нормализуем сами.
function Write-ZipWithForwardSlashes($zipPath) {
    $tmp = "$zipPath.fixed"
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }

    $src = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $out = [System.IO.Compression.ZipFile]::Open($tmp, 'Create')
        try {
            foreach ($entry in $src.Entries) {
                $name = $entry.FullName -replace '\\', '/'
                $new = $out.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
                # Нужен явный LastWriteTime: свойство zip-записи без extended
                # timestamp не наследует дату файла и «обнуляется».
                $new.LastWriteTime = $entry.LastWriteTime
                $rs = $entry.Open()
                try {
                    $ws = $new.Open()
                    try { $rs.CopyTo($ws) } finally { $ws.Dispose() }
                } finally { $rs.Dispose() }
            }
        } finally { $out.Dispose() }
    } finally { $src.Dispose() }

    Move-Item -LiteralPath $tmp -Destination $zipPath -Force
}

# --- Chrome/Edge: manifest.chrome.json -> manifest.json ---
Write-Step "Chrome/Edge: ai-execute-runner-$Version-chrome.zip"
$chromeStage = Join-Path ([System.IO.Path]::GetTempPath()) ("axchrome-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $chromeStage | Out-Null
try {
    Get-ChildItem -LiteralPath $extDir -Force | Where-Object { $_.Name -notin $excludeDirs -and $_.Name -notin $excludeExact } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $chromeStage -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $extDir 'manifest.chrome.json') -Destination (Join-Path $chromeStage 'manifest.json') -Force
    Remove-Item -LiteralPath (Join-Path $chromeStage 'manifest.chrome.json') -Force
    $chromeZip = Join-Path $distDir "ai-execute-runner-$Version-chrome.zip"
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $chromeStage, $chromeZip,
        [System.IO.Compression.CompressionLevel]::Optimal, $false)
    Write-ZipWithForwardSlashes $chromeZip
} finally {
    Remove-Item -LiteralPath $chromeStage -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Firefox: manifest.json как есть ---
Write-Step "Firefox: ai-execute-runner-$Version-firefox.xpi"
$firefoxXpi = Join-Path $distDir "ai-execute-runner-$Version-firefox.xpi"
New-ZipFromDir $extDir $firefoxXpi $false

# --- firefox-addon.xpi в корне репозитория ---
# Отдельный коммитимый артефакт: README предлагает грузить его в Firefox
# напрямую («Загрузить временное дополнение» → выбрать .xpi), без распаковки.
# Раньше он собирался вручную и со временем отставал от кода — в копии 2.6.1
# отсутствовал ax-palette.js. Теперь собирается тем же кодом, что и dist/.
$rootXpi = Join-Path $root 'firefox-addon.xpi'
Write-Step "Firefox (корень, для установки без распаковки): firefox-addon.xpi"
Copy-Item -LiteralPath $firefoxXpi -Destination $rootXpi -Force

# --- сервер: папка server внутри архива ---
Write-Step "Сервер: ai-execute-runner-$Version-server.zip"
New-ZipFromDir $serverDir (Join-Path $distDir "ai-execute-runner-$Version-server.zip") $true

Write-Step 'Готово:'
Get-ChildItem -LiteralPath $distDir | ForEach-Object {
    "  {0,-46} {1,8:N0} B" -f $_.Name, $_.Length
}
