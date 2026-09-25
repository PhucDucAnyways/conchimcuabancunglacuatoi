$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
    $child = Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -Wait -PassThru
    if ($child.ExitCode -ne 0) { throw 'Chua mo duoc quyen mang. Hay chap nhan cua so Windows Administrator.' }
    Write-Host 'Da cho phep MemoryWeaver tren Wi-Fi noi bo. Thu lai trang /status tren dien thoai.' -ForegroundColor Green
    exit 0
}

$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$wifi = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and ($_.Name -match 'Wi-?Fi|Wireless|WLAN' -or $_.PhysicalMediaType -eq 'Native 802.11') } | Select-Object -First 1
if (-not $wifi) { throw 'Khong tim thay card Wi-Fi dang ket noi.' }
$ruleName = 'MemoryWeaver-Local-WiFi'
$existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
    New-NetFirewallRule -Name $ruleName -DisplayName 'MemoryWeaver Expo and AI - local Wi-Fi only' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8081,8082,8787 -RemoteAddress LocalSubnet -InterfaceAlias $wifi.Name -Program $nodeExecutable -Profile Any | Out-Null
} else {
    Enable-NetFirewallRule -Name $ruleName
}
