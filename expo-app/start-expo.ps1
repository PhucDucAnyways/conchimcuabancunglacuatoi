$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath 'node_modules/expo/bin/cli')) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Cai dependencies that bai.' }
}
node scripts/run-phone.cjs
exit $LASTEXITCODE
