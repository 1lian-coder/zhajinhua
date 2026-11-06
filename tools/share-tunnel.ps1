# 一键生成公网地址：让异地好友通过链接进入你的牌局
#
# 用法（在项目根目录执行）：
#   powershell -ExecutionPolicy Bypass -File tools\share-tunnel.ps1
#
# 原理：cloudflared 快速隧道（免费、无需注册账号），
#       把本机 8080 端口临时映射成一个 https 公网地址。
#       关掉窗口地址就失效。

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Port = if ($env:PORT) { [int]$env:PORT } else { 8080 }
$ToolsDir = Join-Path $Root 'tools'
$CfExe = Join-Path $ToolsDir 'cloudflared.exe'

Write-Host ''
Write-Host '  ♠ ♥ 炸金花 · 公网穿透工具' -ForegroundColor Green
Write-Host '  ────────────────────────────────────────' -ForegroundColor DarkGray

# ---------- 1. 准备 cloudflared ----------
if (-not (Test-Path $CfExe)) {
    Write-Host '  首次运行，正在下载 cloudflared（约 30MB，只需一次）...' -ForegroundColor Yellow
    $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $CfExe -UseBasicParsing -TimeoutSec 300
    } catch {
        Write-Host '  下载失败，请检查网络，或手动下载后放到 tools\cloudflared.exe：' -ForegroundColor Red
        Write-Host "  $url" -ForegroundColor Red
        Read-Host '  按回车退出'
        exit 1
    }
    if (-not (Test-Path $CfExe) -or (Get-Item $CfExe).Length -lt 1000000) {
        Write-Host '  下载的文件不完整，请重试。' -ForegroundColor Red
        Read-Host '  按回车退出'
        exit 1
    }
    Write-Host '  ✓ cloudflared 下载完成' -ForegroundColor Green
}

# ---------- 2. 起本地服务 ----------
$serverProc = $null
$alreadyUp = $false
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    if ($health.ok) {
        $alreadyUp = $true
        Write-Host "  ✓ 检测到本地服务已在运行（端口 $Port）" -ForegroundColor Green
    }
} catch { }

if (-not $alreadyUp) {
    Write-Host "  正在启动本地服务（端口 $Port）..." -ForegroundColor Yellow
    $serverProc = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
        -WorkingDirectory $Root -PassThru -WindowStyle Hidden
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 300
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
            if ($h.ok) { $ok = $true; break }
        } catch { }
    }
    if (-not $ok) {
        Write-Host '  本地服务启动失败，请先手动运行 start.bat 看报错。' -ForegroundColor Red
        if ($serverProc) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue }
        Read-Host '  按回车退出'
        exit 1
    }
    Write-Host '  ✓ 本地服务已启动' -ForegroundColor Green
}

Write-Host ''
Write-Host '  正在建立公网隧道，地址马上出来（首次可能等 5~15 秒）...' -ForegroundColor Yellow
Write-Host '  ┌────────────────────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host '  │ 看到 https://xxx.trycloudflare.com 这个地址就是你的入口' -ForegroundColor White
Write-Host '  │ 把它发给朋友，他们手机浏览器直接打开就能进房' -ForegroundColor White
Write-Host '  │ 按 Ctrl + C 结束，地址随即失效' -ForegroundColor White
Write-Host '  └────────────────────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host ''

try {
    & $CfExe tunnel --url "http://127.0.0.1:$Port" --no-autoupdate
} finally {
    if ($serverProc -and -not $serverProc.HasExited) {
        Write-Host ''
        Write-Host '  正在关闭本地服务...' -ForegroundColor DarkGray
        Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host '  隧道已关闭。' -ForegroundColor DarkGray
}
