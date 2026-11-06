$ErrorActionPreference = 'SilentlyContinue'

$killed = 0

# 1) 停掉 localhost.run 的 ssh 隧道
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
    Where-Object { $_.CommandLine -match 'localhost\.run' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        $killed++
    }

# 2) 停掉占用 8080 的服务进程
Get-NetTCPConnection -LocalPort 8080 -State Listen |
    ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force
        $killed++
    }

if ($killed -gt 0) {
    Write-Host "Stopped $killed process(es). Public link is no longer valid."
} else {
    Write-Host "Nothing was running."
}
