# 炸金花 · 公网穿透（零下载版）
#
# 用 Windows 自带的 ssh 做反向隧道，不下载任何 exe，
# 因此不会被 360 / SmartScreen 当成"未知程序"拦截。
#
# 用法：双击项目根目录的 share.bat

$ErrorActionPreference = 'Stop'

# 统一走 UTF-8 输出，避免中文在控制台里乱码
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

$Root = Split-Path -Parent $PSScriptRoot
$Port = if ($env:PORT) { [int]$env:PORT } else { 8080 }
$LogFile = Join-Path $env:TEMP 'zjh-tunnel.log'

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

# ---------------------------------------------------------------- 环境检查

Write-Host ''
Write-Host '  炸金花 · 异地联机' -ForegroundColor Green
Write-Host '  ----------------------------------------------------------' -ForegroundColor DarkGray

$SshCmd = Get-Command ssh -ErrorAction SilentlyContinue
if (-not $SshCmd) {
    Write-Host ''
    Write-Host '  [缺少] 系统没有 ssh 客户端。' -ForegroundColor Red
    Write-Host '  请打开：设置 → 应用 → 可选功能 → 添加功能 → 勾选「OpenSSH 客户端」→ 安装' -ForegroundColor Yellow
    Write-Host '  装好后重新双击 share.bat 即可。' -ForegroundColor Yellow
    Write-Host ''
    Read-Host '  按回车退出'
    exit 1
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Host ''
    Write-Host '  [缺少] 没有找到 Node.js，请先安装：https://nodejs.org/' -ForegroundColor Red
    Write-Host ''
    Read-Host '  按回车退出'
    exit 1
}

# ---------------------------------------------------------------- 启动本地服务

function Test-LocalServer {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
        return [bool]$h.ok
    } catch {
        return $false
    }
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
        Read-Host '  按回车退出'
        exit 1
    }
    Write-Host '  [OK] 本地服务已启动' -ForegroundColor Green
}

Write-Host '  正在连接公网隧道（约 5~15 秒）...' -ForegroundColor Yellow

# ---------------------------------------------------------------- 隧道（断线自动重连）

# 注意：这里必须写 127.0.0.1 而不是 localhost。
# Windows 上 localhost 可能先解析到 IPv6 的 ::1，而 node 监听的是 IPv4，
# 用 localhost 会导致隧道连不上本地服务（浏览器打开是 502 错误）。
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
        Remove-Item $LogFile, ($LogFile + '.err') -Force -ErrorAction SilentlyContinue

        $SshProc = Start-Process -FilePath 'ssh' -ArgumentList $SshArgs `
            -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $LogFile -RedirectStandardError ($LogFile + '.err')

        # 从 ssh 输出里抓 https 地址（原始输出混着二维码和 ANSI 转义，这里只取干净 URL）
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
            Show-Url $url
            # 顺手复制到剪贴板，方便直接粘给朋友
            try { Set-Clipboard -Value $url; Write-Host '   （地址已复制到剪贴板，可直接粘贴发人）' -ForegroundColor DarkGray } catch { }
            # 隧道刚建立时服务端还在挂载，稍等一下再提示就绪
            Start-Sleep -Seconds 2
            Write-Host "  已就绪（第 $attempt 次连接）· 按 Ctrl + C 结束" -ForegroundColor DarkGray
            Write-Host ''
        } else {
            Write-Host ''
            Write-Host '  [失败] 没能建立隧道。可能原因：' -ForegroundColor Red
            Write-Host '    · 网络访问不了 localhost.run（换手机热点/关掉代理再试）' -ForegroundColor Yellow
            Write-Host '    · 安全软件拦了 ssh 的外连' -ForegroundColor Yellow
            $errText = ''
            if (Test-Path ($LogFile + '.err')) {
                $errText = (Get-Content ($LogFile + '.err') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
            }
            if ($errText) {
                Write-Host '  --- ssh 输出 ---' -ForegroundColor DarkGray
                ($errText -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -First 6) |
                    ForEach-Object { Write-Host ('    ' + $_.Trim()) -ForegroundColor DarkGray }
            }
        }

        # 心跳监测：ssh 进程活着不等于隧道可用（免费隧道会"僵死"，
        # 进程在、公网却 502）。每 30 秒真实访问一次公网地址，
        # 连续 2 次失败就主动杀掉重建，拿到新地址。
        if ($url -and -not $SshProc.HasExited) {
            Write-Host '  隧道运行中，别关这个窗口...（每 30 秒自动体检）' -ForegroundColor DarkGray
            $failCount = 0
            while (-not $SshProc.HasExited) {
                Start-Sleep -Seconds 30
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
                        break
                    }
                }
            }
        } elseif (-not $SshProc.HasExited) {
            # 没拿到地址但进程还活着，等它自然退出走重连
            try { Wait-Process -Id $SshProc.Id -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500 }
        }

        Write-Host ''
        Write-Host '  隧道已断开，5 秒后自动重连（重连后地址会变，需要重新发给朋友）' -ForegroundColor Yellow
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
    Remove-Item $LogFile, ($LogFile + '.err') -Force -ErrorAction SilentlyContinue
    Write-Host '  隧道已关闭。' -ForegroundColor DarkGray
}
