# Keeps the agent alive for the whole competition: if the process crashes,
# it restarts after 30 seconds. Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\run-forever.ps1        (dry-run)
#   powershell -ExecutionPolicy Bypass -File scripts\run-forever.ps1 -Live  (real trading)
param([switch]$Live)

$mode = if ($Live) { "--live" } else { "" }
Set-Location (Split-Path $PSScriptRoot -Parent)

while ($true) {
    Write-Host "`n[run-forever] starting Karve agent $mode at $(Get-Date -Format o)"
    if ($mode) { npx tsx src/index.ts $mode } else { npx tsx src/index.ts }
    Write-Host "[run-forever] agent exited with code $LASTEXITCODE - restarting in 30s (Ctrl+C to stop)"
    Start-Sleep -Seconds 30
}
