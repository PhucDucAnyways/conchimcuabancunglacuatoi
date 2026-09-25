param([switch]$OnlyIfMissing)
$ErrorActionPreference = 'Stop'
$envPath = Join-Path $PSScriptRoot '.env'
$content = if (Test-Path -LiteralPath $envPath) { [IO.File]::ReadAllText($envPath) } else { '' }
if ($OnlyIfMissing -and $content -match '(?m)^GEMINI_API_KEY=(?!sk-)[A-Za-z0-9_.-]{20,}[ \t]*\r?$') { return }
Write-Host 'Tao khoa Gemini tai https://aistudio.google.com/apikey'
$enteredKey = Read-Host 'Nhap Gemini API key (chi luu tren may server)' -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($enteredKey)
try { $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
try {
    # This checks safe .env syntax only; Google validates the actual credential.
    if ($plainKey.StartsWith('sk-')) { throw 'Day co ve la khoa OpenAI. Hay sao chep khoa tu Google AI Studio. Chua ghi file.' }
    if ($plainKey -notmatch '^[A-Za-z0-9_.-]{20,}$') { throw 'Chi dan nguyen gia tri API key, khong kem dau nhay, dau sao hay khoang trang. Chua ghi file.' }
    function Set-EnvLine([string]$Name, [string]$Value) {
        $pattern = '(?m)^' + [regex]::Escape($Name) + '=[^\r\n]*'
        if ([regex]::IsMatch($script:content, $pattern)) { $script:content = [regex]::Replace($script:content, $pattern, "$Name=$Value") }
        else { $script:content = $script:content.TrimEnd() + "`n$Name=$Value`n" }
    }
    Set-EnvLine 'GEMINI_API_KEY' $plainKey
    Set-EnvLine 'GEMINI_MODEL' 'gemini-flash-lite-latest'
    if ($content -notmatch '(?m)^APP_ACCESS_TOKEN=\S+') {
        $randomBytes = New-Object byte[] 24
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
        Set-EnvLine 'APP_ACCESS_TOKEN' (-join ($randomBytes | ForEach-Object { $_.ToString('x2') }))
    }
    if ($content -notmatch '(?m)^HOST=\S+') { Set-EnvLine 'HOST' '0.0.0.0' }
    if ($content -notmatch '(?m)^PORT=\S+') { Set-EnvLine 'PORT' '8787' }
    [IO.File]::WriteAllText($envPath, $content, (New-Object Text.UTF8Encoding($false)))
    Write-Host 'Da luu Gemini. APP_ACCESS_TOKEN cu duoc giu nguyen. Chay CHAY_HE_THONG.bat trong thu muc MemoryWeaver de mo server va Expo.'
} finally { $plainKey = $null; $content = $null; $enteredKey.Dispose() }
