# Создание GitHub-релиза для текущего тега: использует учётные данные git,
# уже сохранённые в системе, поэтому отдельный токен вводить не нужно.
# Токен в вывод не попадает — он живёт только в переменной внутри процесса.
# Заголовок релиза. Версия берётся из параметра, текст — отсюда.
param(
    [string]$Tag = 'v2.10.0',
    [string]$Repo = 'vvdd7232-lang/this-is-new-repo'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# --- токен из credential helper ---
# Ввод даём файлом с перенаправлением: PowerShell-пайп отдаёт git строки с CRLF,
# и тот ругается «missing protocol field».
$env:GIT_TERMINAL_PROMPT = '0'
$credIn = New-TemporaryFile
Set-Content -LiteralPath $credIn -Value "protocol=https`nhost=github.com`n`n" -NoNewline -Encoding ascii
$cred = cmd /c "git credential fill < `"$credIn`"" 2>$null | Out-String
Remove-Item -LiteralPath $credIn -Force
$token = (($cred -split "`r?`n") | Where-Object { $_ -match '^password=' }) -replace '^password=',''
if (-not $token) { throw 'Не найдены учётные данные для github.com' }

$headers = @{
    Authorization = "Bearer $token"
    'User-Agent'  = 'ai-execute-runner-release'
    Accept        = 'application/vnd.github+json'
}

# --- существующий релиз? (повторный запуск не должен падать или задваивать) ---
# 404 здесь — норма: релиза для тега ещё нет. При $ErrorActionPreference='Stop'
# -ErrorAction SilentlyContinue не помогает, поэтому ловим по коду ответа.
$existing = $null
try {
    $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers -ErrorAction Stop
} catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
}
if ($existing) {
    Write-Host "==> Релиз $Tag уже существует (id $($existing.id)) — обновляем описание" -ForegroundColor Yellow
    $releaseId = $existing.id
    $notesPath = Join-Path $root "dist\$Tag-notes.md"
    # Именно .NET, а не Get-Content: в Windows PowerShell 5.1 файл без BOM
    # читается как ANSI, и кириллица в заметках рассыпается в «Ð‘Ñ€Ð°Ñ€».
    $body = if (Test-Path $notesPath) { [System.IO.File]::ReadAllText($notesPath, [System.Text.Encoding]::UTF8) } else { $existing.body }
    $patch = @{ name = "$Tag — Исправление палитры и «таблетки»"; body = $body } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Method Patch -Uri "https://api.github.com/repos/$Repo/releases/$releaseId" `
        -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($patch)) | Out-Null
    Write-Host "==> Описание и имя обновлены" -ForegroundColor Green
} else {
    $notesPath = Join-Path $root "dist\$Tag-notes.md"
    # Именно .NET, а не Get-Content: в Windows PowerShell 5.1 файл без BOM
    # читается как ANSI, и кириллица в заметках рассыпается в «Ð‘Ñ€Ð°Ñ€».
    $body = if (Test-Path $notesPath) { [System.IO.File]::ReadAllText($notesPath, [System.Text.Encoding]::UTF8) } else { "Релиз $Tag" }
    $payload = @{
        tag_name         = $Tag
        # $Tag уже вида v2.10.0, поэтому префикс 'v' здесь лишний.
        name             = "$Tag — Исправление палитры и «таблетки»"
        body             = $body
        draft            = $false
        prerelease       = $false
    } | ConvertTo-Json -Depth 5
    $release = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/releases" `
        -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
    $releaseId = $release.id
    Write-Host "==> Создан релиз $Tag (id $releaseId)" -ForegroundColor Green
}

# --- вложения ---
# Уже загруженный файл пропускаем: GitHub отвечает "already_exists", и без
# этой проверки повторный запуск скрипта падал бы на первом же артефакте.
$uploaded = @()
try {
    $uploaded = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/$releaseId/assets" -Headers $headers -ErrorAction Stop).name
} catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
}
$assets = Get-ChildItem (Join-Path $root 'dist') -File |
    Where-Object { $_.Extension -in @('.zip', '.xpi') -and $_.Name -ne 'firefox-addon.xpi' }
foreach ($a in $assets) {
    if ($uploaded -contains $a.Name) {
        Write-Host "  = $($a.Name) уже загружен" -ForegroundColor DarkGray
        continue
    }
    $url = "https://uploads.github.com/repos/$Repo/releases/$releaseId/assets?name=$([uri]::EscapeDataString($a.Name))"
    Invoke-RestMethod -Method Post -Uri $url -Headers $headers -ContentType 'application/octet-stream' -Body ([System.IO.File]::ReadAllBytes($a.FullName)) | Out-Null
    Write-Host "  + $($a.Name) ($([math]::Round($a.Length / 1KB)) KB)" -ForegroundColor Cyan
}

Write-Host "==> Готово: https://github.com/$Repo/releases/tag/$Tag" -ForegroundColor Green