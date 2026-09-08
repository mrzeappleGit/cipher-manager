[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServePath,
    [string]$ExpectedVersion = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$serveExe = (Resolve-Path -LiteralPath $ServePath).Path
if (-not (Test-Path -LiteralPath $serveExe -PathType Leaf)) { throw 'ServePath must be an executable file.' }
$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$smokeRoot = Join-Path $tempParent ('cipher-smoke-' + [Guid]::NewGuid().ToString('N'))
$ownedProcess = $null

function Assert-Smoke([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw "Smoke check failed: $Label" }
}

function Request-Smoke([string]$Method, [string]$Path, [string]$Body = '{}', [hashtable]$Headers = @{}) {
    $request = [Net.HttpWebRequest]::Create($script:smokeBase + $Path)
    $request.Method = $Method
    $request.Timeout = 4000
    $request.ReadWriteTimeout = 4000
    $request.AllowAutoRedirect = $false
    $request.KeepAlive = $false
    $request.Proxy = $null
    foreach ($key in $Headers.Keys) {
        if ($key -eq 'Host') { $request.Host = $Headers[$key] }
        else { $request.Headers[$key] = $Headers[$key] }
    }
    if ($Method -eq 'POST') {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
        $request.ContentType = 'application/json'
        $request.ContentLength = $bytes.Length
        $stream = $request.GetRequestStream()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    }
    try { $response = $request.GetResponse() }
    catch [Net.WebException] {
        if (-not $_.Exception.Response) { throw 'The isolated smoke server did not respond.' }
        $response = $_.Exception.Response
    }
    try {
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $text }
    } finally { $response.Dispose() }
}

try {
    # Claude's override falls back to the real profile if its directory is absent.
    # Create every scanner root before the child starts. State also isolates tokens,
    # persisted agents, task configuration and job audit paths.
    $roots = @{}
    foreach ($name in @('state', 'claude', 'codex', 'antigravity', 'profile', 'roaming', 'local')) {
        $roots[$name] = Join-Path $smokeRoot $name
        New-Item -ItemType Directory -Path $roots[$name] -Force | Out-Null
    }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $smokePort = $listener.LocalEndpoint.Port
    $listener.Stop()
    $script:smokeBase = "http://127.0.0.1:$smokePort"
    $launch = [Diagnostics.ProcessStartInfo]::new()
    $launch.FileName = $serveExe
    $launch.Arguments = "--host 127.0.0.1 --port $smokePort"
    $launch.WorkingDirectory = $smokeRoot
    $launch.UseShellExecute = $false
    $launch.CreateNoWindow = $true
    $launch.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    # .NET Framework's first getter throws if the inherited block contains both
    # Path and PATH. It leaves an initialized dictionary; rebuild it using
    # case-insensitive assignment, which safely coalesces duplicate names.
    try { $childEnvironment = $launch.get_EnvironmentVariables() }
    catch {
        if ($_.Exception.InnerException -isnot [ArgumentException]) { throw }
        $childEnvironment = $launch.get_EnvironmentVariables()
    }
    $childEnvironment.Clear()
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        $childEnvironment[$entry.Key] = $entry.Value
    }
    foreach ($pair in @{
        CIPHER_STATE_DIR = 'state'; CIPHER_CLAUDE_DIR = 'claude';
        CIPHER_CODEX_DIR = 'codex'; CIPHER_ANTIGRAVITY_DIR = 'antigravity';
        USERPROFILE = 'profile'; APPDATA = 'roaming'; LOCALAPPDATA = 'local'
    }.GetEnumerator()) { $childEnvironment[$pair.Key] = $roots[$pair.Value] }
    $ownedProcess = [Diagnostics.Process]::Start($launch)
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $health = $null
    while ([DateTime]::UtcNow -lt $deadline -and -not $ownedProcess.HasExited) {
        try {
            $reply = Request-Smoke 'GET' '/api/health'
            if ($reply.Status -eq 200) { $health = $reply.Body | ConvertFrom-Json; break }
        } catch { }
        Start-Sleep -Milliseconds 150
    }
    Assert-Smoke ($null -ne $health) 'startup health'
    Assert-Smoke ($health.application -eq 'cipher-manager-serve' -and $health.ok -and $health.protocol -eq 1) 'server identity/protocol'
    # Detect a port-claim race: never run checks against another process's server.
    Assert-Smoke ($health.instance.StartsWith([string]$ownedProcess.Id + '-')) 'owned process instance'
    Assert-Smoke ($health.version -match '^\d+\.\d+\.\d+') 'health version'
    if ($ExpectedVersion) { Assert-Smoke ($health.version -eq $ExpectedVersion) 'expected artifact version' }

    $token = [IO.File]::ReadAllText((Join-Path $roots.state 'serve-token.txt')).Trim()
    Assert-Smoke ($token.Length -ge 32) 'isolated control token created'
    $auth = @{ Authorization = "Bearer $token" }
    $stopBody = @{ instance = $health.instance } | ConvertTo-Json -Compress
    Assert-Smoke ((Request-Smoke 'GET' '/api/run_skill').Status -eq 405) 'GET cannot execute commands'
    Assert-Smoke ((Request-Smoke 'GET' '/api/health' '{}' @{ Host = 'untrusted.example' }).Status -eq 403) 'Host rebinding guard'
    Assert-Smoke ((Request-Smoke 'POST' '/api/list_projects' '{}' @{ Origin = 'https://untrusted.example' }).Status -eq 403) 'cross-origin guard'
    $projects = Request-Smoke 'POST' '/api/list_projects'
    Assert-Smoke ($projects.Status -eq 200 -and $projects.Body.Trim() -eq '[]') 'empty isolated project inventory'
    $runBody = @{
        skill = 'smoke'; label = 'Smoke'; prompt = 'Smoke';
        bin = (Join-Path $smokeRoot 'nonexistent-smoke-cli.exe'); cwd = $roots.profile
    } | ConvertTo-Json -Compress
    $denied = Request-Smoke 'POST' '/api/run_skill' $runBody
    Assert-Smoke ($denied.Status -eq 400 -and $denied.Body -match 'Acting mode is disabled') 'fresh-profile Acting mode refusal'
    Assert-Smoke ((Request-Smoke 'POST' '/api/shutdown' $stopBody).Status -eq 401) 'shutdown requires authentication'
    Assert-Smoke ((Request-Smoke 'POST' '/api/shutdown' $stopBody @{ Authorization = 'Bearer invalid-smoke-token' }).Status -eq 401) 'wrong control token rejected'
    Assert-Smoke ((Request-Smoke 'POST' '/api/shutdown' $stopBody @{ Authorization = "Bearer $token"; Origin = $script:smokeBase }).Status -eq 401) 'browser cannot issue lifecycle commands'
    Assert-Smoke ((Request-Smoke 'POST' '/api/shutdown' '{"instance":"old-instance"}' $auth).Status -eq 409) 'shutdown bound to current instance'
    Assert-Smoke ((Request-Smoke 'POST' '/api/shutdown' $stopBody $auth).Status -eq 200) 'authenticated shutdown'
    Assert-Smoke ($ownedProcess.WaitForExit(10000)) 'owned process exits after shutdown'
    Assert-Smoke ($ownedProcess.ExitCode -eq 0) 'clean server exit'
    Write-Output "PASS: isolated Windows server smoke ($($health.version)); no jobs or external integrations launched."
} finally {
    # Failure cleanup touches only the Process instance this script launched.
    if ($null -ne $ownedProcess) {
        if (-not $ownedProcess.HasExited) { $ownedProcess.Kill(); $ownedProcess.WaitForExit(5000) | Out-Null }
        $ownedProcess.Dispose()
    }
    # Verify the resolved absolute target before recursive cleanup.
    if (Test-Path -LiteralPath $smokeRoot) {
        $cleanupPath = (Resolve-Path -LiteralPath $smokeRoot).Path
        $cleanupItem = Get-Item -LiteralPath $cleanupPath -Force
        if ([IO.Path]::GetDirectoryName($cleanupPath) -ne $tempParent -or
            -not [IO.Path]::GetFileName($cleanupPath).StartsWith('cipher-smoke-') -or
            ($cleanupItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing unsafe smoke cleanup path.' }
        Remove-Item -LiteralPath $cleanupPath -Recurse -Force
    }
}
