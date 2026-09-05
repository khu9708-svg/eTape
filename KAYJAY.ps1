[CmdletBinding()]
param([switch]$NoOpen, [switch]$Check)
$ErrorActionPreference = 'Stop'
$kayRoot = $PSScriptRoot
$kayRepo = if (Test-Path -LiteralPath (Join-Path $kayRoot 'eTape\scripts\kayjay.mjs')) { Join-Path $kayRoot 'eTape' } else { $kayRoot }
function Test-KayPort([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try { $task = $client.ConnectAsync('127.0.0.1', $Port); return ($task.Wait(800) -and $client.Connected) } catch { return $false } finally { $client.Dispose() }
}
if ($Check) {
    foreach ($entry in @(@('eTape',8686),@('KAYJAY',8687),@('Bluelights',8787),@('JINX',8794),@('ATLAS',8080),@('Chrome',9222))) {
        '{0}: {1}' -f $entry[0], $(if(Test-KayPort $entry[1]){'LISTENING'}else{'OFFLINE'})
    }
    exit 0
}
if (!(Test-Path -LiteralPath (Join-Path $kayRepo 'ui\dist\index.html'))) { throw 'Build the cloned eTape UI first: cd eTape\ui; npm ci; npm run build' }
$kayProjects = Split-Path (Split-Path $kayRepo -Parent) -Parent
$kayBluelights = Join-Path $kayProjects 'Bluelights'
if (Test-Path -LiteralPath (Join-Path $kayBluelights 'scripts\_common.ps1')) {
    . (Join-Path $kayBluelights 'scripts\_common.ps1')
    Import-BluelightsEnv
}
if (!(Test-KayPort 8787)) {
    Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $kayBluelights 'scripts\start.ps1') + '"') -WorkingDirectory $kayBluelights -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(20)
    while (!(Test-KayPort 8787) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    if (!(Test-KayPort 8787)) { throw 'Existing Bluelights startup failed.' }
}
if (!(Test-KayPort 9222)) {
    Start-ScheduledTask -TaskName 'Bluelights Browser'
}

if (!(Test-KayPort 8765)) {
    $kayRobinhood = Join-Path (Split-Path $kayProjects -Parent) 'ROBINHOOD-MCP-GATEWAY'
    if (Test-Path -LiteralPath (Join-Path $kayRobinhood 'src\server.mjs')) {
        Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"' + (Join-Path $kayRobinhood 'src\server.mjs') + '"') -WorkingDirectory $kayRobinhood -WindowStyle Hidden -RedirectStandardOutput (Join-Path $kayRepo 'dist\robinhood.log') -RedirectStandardError (Join-Path $kayRepo 'dist\robinhood-error.log')
    }
}
if (!(Test-KayPort 8686)) {
    $exe = Join-Path $kayRepo 'dist\etape.exe'
    if (!(Test-Path -LiteralPath $exe)) { throw 'Build the matching eTape source into eTape\dist\etape.exe first.' }
    Start-Process -FilePath $exe -ArgumentList '-demo','-no-open','-dist',(Join-Path $kayRepo 'ui\dist') -WorkingDirectory $kayRepo -WindowStyle Hidden
}
if (!(Test-KayPort 8687)) {
    $node = (Get-Command node.exe).Source
    Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $kayRepo 'scripts\kayjay.mjs') + '"') -WorkingDirectory $kayRepo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $kayRepo 'dist\kayjay.log') -RedirectStandardError (Join-Path $kayRepo 'dist\kayjay-error.log')
}
$deadline = (Get-Date).AddSeconds(20)
while (!(Test-KayPort 8687) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
if (!(Test-KayPort 8687)) { throw 'KAYJAY did not start; inspect eTape\dist\kayjay-error.log.' }
if (!$NoOpen) {
    & node (Join-Path $kayRepo 'scripts\kayjay-open.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'The existing Chrome/CDP workstation could not open.' }
}
Write-Output 'KAYJAY is ready. eTape is practice-only; existing engine authority is unchanged.'
