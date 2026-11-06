# 炸金花 · 公网穿透（零下载版 · 单实例守护）
#
# 用 Windows 自带的 ssh 做反向隧道，不下载任何 exe，
# 因此不会被 360 / SmartScreen 当成"未知程序"拦截。
#
# 特性：
#   · 单实例：重复启动会直接告诉你当前地址，不会再起第二条隧道
#   · 心跳自检：每 30 秒真实访问一次公网地址，连续失败自动重建
#   · 地址落盘：当前地址写入 data/tunnel-url.txt，随时用「查看地址.bat」查看
#   · 自动复制：每次拿到新地址自动进剪贴板
#
# 用法：双击项目根目录的 share.bat

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root 'data'
$Port = if ($env:PORT) { [int]$env:PORT } else { 8080 }
$PidFile = Join-Path $DataDir 'tunnel.pid'
$UrlFile = Join-Path $DataDir 'tunnel-url.txt'
$LogFile = Join-Path $env:TEMP ("zjh-tunnel-$PID.log")
$ErrFile = "$LogFile.err"

function Show-Url($url) {
    Write-Host ''
    Write-Host '  ==========================================================' -ForegroundColor DarkGray
    Write-Host '   把这个地址发给朋友（手机浏览器直接打开）：' -ForegroundColor White
    Write-Host ''
    Write-Host ('     ' + $url) -ForegroundColor Green
    Write-Host ''
    Write-Host '   关掉这个窗口，地址立刻失效。' -ForegroundColor White
    Write-Host '  ==========================================================' -ForegroundColor DarkGray
    Write-Host ''
}

function Save-Url($url) {
    try {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        $tmp = "$UrlFile.tmp"
        [System.IO.File]::WriteAllText($tmp, $url, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -Force $tmp $UrlFile
    } catch { }
    try { Set-Clipboard -Value $url } catch { }
}

# ---------------------------------------------------------------- 单实例检查

function Test-ExistingSupervisor {
    if (-not (Test-Path $PidFile)) { return $null }
    $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue)
    $oldPid = 0
    if (-not [int]::TryParse(($raw -replace '\s', ''), [ref]$oldPid)) { return $null }
    $p = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    return $oldPid
}

Write-Host ''
Write-Host '  炸金花 · 异地联机' -ForegroundColor Green
Write-Host '  ----------------------------------------------------------' -ForegroundColor DarkGray

$running = Test-ExistingSupervisor
if ($running) {
    Write-Host "  已经有一条隧道在运行（进程 $running），这次不重复启动。" -ForegroundColor Yellow
    $cur = ''
    if (Test-Path $UrlFile) { $cur = (Get-Content $UrlFile -Raw -ErrorAction SilentlyContinue).Trim() }
    if ($cur) {
        Write-Host ''
        Write-Host '  当前地址：' -ForegroundColor White
        Write-Host ('     ' + $cur) -ForegroundColor Green
        try { Set-Clipboard -Value $cur; Write-Host '   （已复制到剪贴板）' -ForegroundColor DarkGray } catch { }
    } else {
        Write-Host '  还没拿到地址，稍等几秒后再运行一次本程序。' -ForegroundColor Yellow
    }
    Write-Host ''
    Read-Host '  按回车关闭这个窗口（不会停止已运行的隧道）'
    exit 0
}

# 清理上次残留
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
Remove-Item $UrlFile -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Set-Content -Path $PidFile -Value $PID -Encoding ascii

# ---------------------------------------------------------------- 环境检查

$SshCmd = Get-Command ssh -ErrorAction SilentlyContinue
if (-not $SshCmd) {
    Write-Host ''
    Write-Host '  [缺少] 系统没有 ssh 客户端。' -ForegroundColor Red
    Write-Host '  请打开：设置 → 应用 → 可选功能 → 添加功能 → 勾选「OpenSSH 客户端」→ 安装' -ForegroundColor Yellow
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Read-Host '  按回车退出'
    exit 1
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Host ''
    Write-Host '  [缺少] 没有找到 Node.js，请先安装：https://nodejs.org/' -ForegroundColor Red
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Read-Host '  按回车退出'
    exit 1
}

# ---------------------------------------------------------------- 启动本地服务

function Test-LocalServer {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
        return [bool]$h.ok
    } catch { return $false }
}

$ServerProc = $null
$ServerStartedByUs = $false

if (Test-LocalServer) {
    Write-Host "  [OK] 本地服务已在运行（端口 $Port）" -ForegroundColor Green
} else {
    Write-Host "  正在启动本地服务（端口 $Port）..." -ForegroundColor Yellow
    $ServerProc = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
        -WorkingDirectory $Root -PassThru -WindowStyle Hidden
    $ServerStartedByUs = $true
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 300
        if (Test-LocalServer) { $ok = $true; break }
    }
    if (-not $ok) {
        Write-Host '  [失败] 本地服务没起来。请先单独双击 start.bat 看它报什么错。' -ForegroundColor Red
        if ($ServerProc -and -not $ServerProc.HasExited) {
            Stop-Process -Id $ServerProc.Id -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        Read-Host '  按回车退出'
        exit 1
    }
    Write-Host '  [OK] 本地服务已启动' -ForegroundColor Green
}

Write-Host '  正在连接公网隧道（约 5~15 秒）...' -ForegroundColor Yellow

# ---------------------------------------------------------------- 隧道主循环

# 必须写 127.0.0.1：Windows 上 localhost 可能先解析到 IPv6 的 ::1，
# 而 node 监听 IPv4，用 localhost 会导致隧道连不上（浏览器 502）。
$SshArgs = @(
    '-T',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'BatchMode=yes',
    '-R', "80:127.0.0.1:$Port",
    'nokey@localhost.run'
)

$SshProc = $null
$attempt = 0

try {
    while ($true) {
        $attempt++
        Remove-Item $LogFile, $ErrFile -Force -ErrorAction SilentlyContinue

        $SshProc = Start-Process -FilePath 'ssh' -ArgumentList $SshArgs `
            -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile

        $url = $null
        for ($i = 0; $i -lt 80; $i++) {
            Start-Sleep -Milliseconds 400
            if (Test-Path $LogFile) {
                $content = Get-Content $LogFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
                if ($content -and $content -match 'https://[a-z0-9]+\.lhr\.life') {
                    $url = $Matches[0]
                    break
                }
            }
            if ($SshProc.HasExited) { break }
        }

        if ($url) {
            Save-Url $url
            Show-Url $url
            try { Write-Host '   （地址已复制到剪贴板）' -ForegroundColor DarkGray } catch { }
            Start-Sleep -Seconds 2
            Write-Host "  已就绪（第 $attempt 次连接）· 按 Ctrl + C 结束" -ForegroundColor DarkGray
            Write-Host ''

            # 心跳：ssh 进程活着 ≠ 隧道可用（免费隧道会僵死，公网 502）
            $failCount = 0
            while (-not $SshProc.HasExited) {
                Start-Sleep -Seconds 30

                # 顺带看护本地服务：node 挂了就拉起来，否则隧道再好也是 502
                if (-not (Test-LocalServer)) {
                    Write-Host '  [看护] 本地服务没响应，正在重启...' -ForegroundColor Yellow
                    if ($ServerProc -and -not $ServerProc.HasExited) {
                        Stop-Process -Id $ServerProc.Id -Force -ErrorAction SilentlyContinue
                    }
                    Start-Sleep -Milliseconds 500
                    $ServerProc = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
                        -WorkingDirectory $Root -PassThru -WindowStyle Hidden
                    $ServerStartedByUs = $true
                    for ($w = 0; $w -lt 30; $w++) {
                        Start-Sleep -Milliseconds 300
                        if (Test-LocalServer) { break }
                    }
                    if (Test-LocalServer) {
                        Write-Host '  [看护] 本地服务已恢复' -ForegroundColor Green
                    } else {
                        Write-Host '  [看护] 重启失败，请双击 start.bat 看报错' -ForegroundColor Red
                    }
                }

                $healthy = $false
                try {
                    $resp = Invoke-WebRequest -Uri ($url + '/api/health') -UseBasicParsing -TimeoutSec 10
                    if ($resp.StatusCode -eq 200 -and $resp.Content -match '"ok":\s*true') { $healthy = $true }
                } catch { $healthy = $false }

                if ($healthy) {
                    if ($failCount -gt 0) { Write-Host '  [体检] 恢复正常' -ForegroundColor Green }
                    $failCount = 0
                } else {
                    $failCount++
                    Write-Host ("  [体检] 公网地址第 {0} 次检测失败" -f $failCount) -ForegroundColor Yellow
                    if ($failCount -ge 2) {
                        Write-Host '  隧道已僵死，正在重建（新地址会自动复制，记得重新发给朋友）...' -ForegroundColor Red
                        Stop-Process -Id $SshProc.Id -Force -ErrorAction SilentlyContinue
                        Remove-Item $UrlFile -Force -ErrorAction SilentlyContinue
                        break
                    }
                }
            }
        } else {
            Write-Host ''
            Write-Host '  [失败] 没能建立隧道。可能原因：' -ForegroundColor Red
            Write-Host '    · 网络访问不了 localhost.run（换手机热点/关掉代理再试）' -ForegroundColor Yellow
            Write-Host '    · 安全软件拦了 ssh 的外连' -ForegroundColor Yellow
            if (Test-Path $ErrFile) {
                $errText = Get-Content $ErrFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
                if ($errText) {
                    Write-Host '  --- ssh 输出 ---' -ForegroundColor DarkGray
                    ($errText -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -First 5) |
                        ForEach-Object { Write-Host ('    ' + $_.Trim()) -ForegroundColor DarkGray }
                }
            }
            if (-not $SshProc.HasExited) {
                try { Wait-Process -Id $SshProc.Id -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500 }
            }
        }

        Write-Host ''
        Write-Host '  隧道已断开，5 秒后自动重连（重连后地址会变）' -ForegroundColor Yellow
        Remove-Item $UrlFile -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 5
    }
} finally {
    if ($SshProc -and -not $SshProc.HasExited) {
        Stop-Process -Id $SshProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($ServerStartedByUs -and $ServerProc -and -not $ServerProc.HasExited) {
        Write-Host '  正在关闭本地服务...' -ForegroundColor DarkGray
        Stop-Process -Id $ServerProc.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $PidFile, $UrlFile -Force -ErrorAction SilentlyContinue
    Remove-Item $LogFile, $ErrFile -Force -ErrorAction SilentlyContinue
    Write-Host '  隧道已关闭。' -ForegroundColor DarkGray
}
