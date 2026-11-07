$ErrorActionPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root 'data\tunnel.pid'
$UrlFile = Join-Path $Root 'data\tunnel-url.txt'

$killed = 0

# 收集自身及所有祖先进程，避免"误杀调用自己的那层 shell"
$protected = @($PID)
$cur = $PID
for ($i = 0; $i -lt 8; $i++) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
    if (-not $p) { break }
    $cur = $p.ParentProcessId
    if (-not $cur -or $cur -eq 0) { break }
    $protected += $cur
}

# 1) 停隧道监督进程（只认 -File ...\share-ssh.ps1，且不碰自身/祖先）
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object {
        $_.CommandLine -match 'share-ssh\.ps1' -and
        $_.CommandLine -match '-File' -and
        ($protected -notcontains $_.ProcessId)
    } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        $killed++
    }

# 2) 兜底：直接停 localhost.run 的 ssh 隧道
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
    Where-Object { $_.CommandLine -match 'localhost\.run' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        $killed++
    }

# 3) 停占用 8080 的服务进程
Get-NetTCPConnection -LocalPort 8080 -State Listen |
    ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force
        $killed++
    }

# 4) 清理状态文件
Remove-Item $PidFile, $UrlFile -Force

# 5) 等 2 秒再复查一轮：防止某个漏网的监督进程在这期间又拉起服务
Start-Sleep -Seconds 2
for ($round = 0; $round -lt 3; $round++) {
    $again = @()
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -match 'share-ssh\.ps1' -and
            $_.CommandLine -match '-File' -and
            ($protected -notcontains $_.ProcessId)
        } | ForEach-Object { $again += $_ }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'server\.js' } | ForEach-Object { $again += $_ }
    Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { $again += $_ }
    if (-not $again) { break }
    foreach ($x in $again) {
        $xp = $x.ProcessId
        if ($xp -and ($protected -notcontains $xp)) {
            Stop-Process -Id $xp -Force -ErrorAction SilentlyContinue
            $killed++
        }
    }
    Start-Sleep -Seconds 2
}

if ($killed -gt 0) {
    Write-Host "Stopped $killed process(es). Public link is no longer valid."
} else {
    Write-Host "Nothing was running."
}
