# 查看当前公网地址（并检查是否还能用）
# 用法：双击项目根目录的 show-url.bat

$ErrorActionPreference = 'SilentlyContinue'

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

$Root = Split-Path -Parent $PSScriptRoot
$UrlFile = Join-Path $Root 'data\tunnel-url.txt'
$PidFile = Join-Path $Root 'data\tunnel.pid'

Write-Host ''
Write-Host '  炸金花 · 当前公网地址' -ForegroundColor Green
Write-Host '  ----------------------------------------------------------' -ForegroundColor DarkGray

$url = ''
if (Test-Path $UrlFile) { $url = (Get-Content $UrlFile -Raw -ErrorAction SilentlyContinue).Trim() }

# 隧道进程还活着吗
$alive = $false
if (Test-Path $PidFile) {
    $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue) -replace '\s', ''
    $oldPid = 0
    if ([int]::TryParse($raw, [ref]$oldPid)) {
        if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { $alive = $true }
    }
}

if (-not $url) {
    Write-Host ''
    Write-Host '  现在没有可用的公网地址。' -ForegroundColor Yellow
    if (-not $alive) {
        Write-Host '  隧道没有在运行 —— 双击 share.bat 启动一条。' -ForegroundColor Yellow
    } else {
        Write-Host '  隧道正在重建中，等几秒再打开本窗口。' -ForegroundColor Yellow
    }
    Write-Host ''
    Read-Host '  按回车关闭'
    exit 0
}

Write-Host ''
Write-Host ('     ' + $url) -ForegroundColor Green
Write-Host ''

# 实测一下还能不能用
try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 12
    if ($r.StatusCode -eq 200 -and $r.Content -match '炸金花') {
        Write-Host '  [可用] 页面访问正常，可以发给朋友。' -ForegroundColor Green
    } else {
        Write-Host "  [异常] 返回了内容但不像游戏页（HTTP $($r.StatusCode)）" -ForegroundColor Yellow
    }
} catch {
    Write-Host '  [打不开] 这个地址已经失效，隧道正在重建的话等一会儿再来看。' -ForegroundColor Red
    Write-Host '           如果一直不行，双击 share.bat 重新建立。' -ForegroundColor DarkGray
}

try {
    Set-Clipboard -Value $url
    Write-Host '  （已复制到剪贴板）' -ForegroundColor DarkGray
} catch { }

Write-Host ''
Read-Host '  按回车关闭'
