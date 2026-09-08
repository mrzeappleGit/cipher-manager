param(
    [Parameter(Mandatory = $true)][string]$Source,
    [switch]$History
)
$ErrorActionPreference = 'Stop'
$auditRoot = Join-Path $PSScriptRoot '../.release-private'
$auditTools = Join-Path $auditRoot 'tools'
$auditExe = Join-Path $auditTools 'gitleaks/gitleaks.exe'
$auditVersion = '8.30.1'
$auditArchive = "gitleaks_${auditVersion}_windows_x64.zip"
New-Item -ItemType Directory -Force -Path $auditTools | Out-Null
if (!(Test-Path -LiteralPath $auditExe)) {
    $auditUrl = "https://github.com/gitleaks/gitleaks/releases/download/v$auditVersion"
    Invoke-WebRequest -UseBasicParsing -Uri "$auditUrl/$auditArchive" -OutFile (Join-Path $auditTools $auditArchive)
    Invoke-WebRequest -UseBasicParsing -Uri "$auditUrl/gitleaks_${auditVersion}_checksums.txt" -OutFile (Join-Path $auditTools 'checksums.txt')
    $auditExpected = ((Get-Content -LiteralPath (Join-Path $auditTools 'checksums.txt') | Where-Object { $_.EndsWith($auditArchive) }) -split '\s+')[0]
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $auditTools $auditArchive)).Hash.ToLowerInvariant() -ne $auditExpected) { throw 'Gitleaks checksum mismatch' }
    Expand-Archive -LiteralPath (Join-Path $auditTools $auditArchive) -DestinationPath (Join-Path $auditTools 'gitleaks') -Force
}
$auditResolved = (Resolve-Path -LiteralPath $Source).Path
$auditReport = Join-Path $auditRoot 'source-secrets.json'
& $auditExe dir $auditResolved --redact=100 --no-banner --log-level error --report-format json --report-path $auditReport
if ($LASTEXITCODE -ne 0) { throw 'Source secret scan failed; inspect the private redacted report. Do not publish.' }
if ($History) {
    & $auditExe git . --redact=100 --no-banner --log-level error --log-opts=--all --report-format json --report-path (Join-Path $auditRoot 'history-secrets.json')
    if ($LASTEXITCODE -ne 0) { throw 'Git history secret scan failed; inspect the private redacted report. Do not publish.' }
}
Write-Output 'Secret scan passed (known patterns only; manual privacy review is still required).'
