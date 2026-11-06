# 设置/取消「创建房间口令」
# 设置后：创建房间必须输入口令，加入房间不受影响。改动立即生效，不用重启服务。

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root 'data'
$File = Join-Path $DataDir 'settings.json'

Write-Host ''
Write-Host '  炸金花 · 创建口令设置' -ForegroundColor Green
Write-Host '  ----------------------------------------------------------' -ForegroundColor DarkGray
Write-Host '  设置口令后：只有知道口令的人能创建房间；'
Write-Host '  朋友凭 6 位房号加入不受任何影响。'
Write-Host ''

# 显示当前状态
$current = ''
if (Test-Path $File) {
    try {
        $raw = Get-Content $File -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($raw -and $raw.createPin) { $current = String($raw.createPin) }
    } catch { }
}
if ($current) {
    Write-Host ('  当前口令: {0}' -f $current) -ForegroundColor Yellow
} else {
    Write-Host '  当前状态: 未设置口令（任何人都能创建房间）' -ForegroundColor DarkGray
}
Write-Host ''

$answer = Read-Host '  输入新口令（3-8 位数字；直接回车 = 取消口令）'
$pin = ($answer -replace '\D', '').Trim()

if ($pin -ne '' -and $pin.Length -lt 3) {
    Write-Host ''
    Write-Host '  [失败] 口令至少 3 位数字，未做任何修改。' -ForegroundColor Red
    exit 1
}

# 读取并合并现有设置
$settings = @{}
if (Test-Path $File) {
    try {
        $raw = Get-Content $File -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($p in $raw.PSObject.Properties) { $settings[$p.Name] = $p.Value }
    } catch { $settings = @{} }
}

if ($pin -eq '') {
    if ($settings.ContainsKey('createPin')) { $settings.Remove('createPin') | Out-Null }
} else {
    $settings['createPin'] = $pin
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# 注意：必须写"无 BOM 的 UTF-8"。PS 5.1 的 Set-Content -Encoding UTF8 会带 BOM，
# Node 的 JSON.parse 遇到 BOM 会解析失败（口令就悄悄失效了）。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($File, ($settings | ConvertTo-Json), $utf8NoBom)

Write-Host ''
if ($pin -eq '') {
    Write-Host '  [完成] 已取消创建口令，现在任何人都能创建房间。' -ForegroundColor Green
} else {
    Write-Host ('  [完成] 创建口令已设为: {0}' -f $pin) -ForegroundColor Green
    Write-Host '  把口令告诉允许开房的朋友即可。' -ForegroundColor DarkGray
}
Write-Host '  改动立即生效，服务不用重启。' -ForegroundColor DarkGray
Write-Host ''
