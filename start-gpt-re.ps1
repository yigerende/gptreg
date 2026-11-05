param(
  # Unattended use (autostart, scheduled task): never wait for a key press.
  [switch]$Quiet,
  # How long to wait for the console to answer before giving up.
  [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$port = 3210
$baseUrl = "http://127.0.0.1:$port"
$healthUrl = "$baseUrl/api/v1/health"
$runtime = Join-Path $root '.gpt-re-state\v2\runtime'
$statusPath = Join-Path $runtime 'start-status.json'
$stdoutPath = Join-Path $runtime 'ui-server.stdout.log'
$stderrPath = Join-Path $runtime 'ui-server.stderr.log'

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
try { $Host.UI.RawUI.WindowTitle = 'GPT-Register 启动中' } catch { }

function Save-StartStatus {
  param(
    [string]$State,
    [int]$ProcessId,
    [string]$Message
  )

  $payload = [ordered]@{
    state = $State
    pid = $ProcessId
    url = $baseUrl
    message = $Message
    updatedAt = (Get-Date).ToString('o')
  }
  $json = ConvertTo-Json -InputObject $payload -Compress
  [IO.File]::WriteAllText($statusPath, $json, [Text.UTF8Encoding]::new($false))
}

function Test-PortOpen {
  param([int]$WaitMs = 200)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.ConnectAsync('127.0.0.1', $port)
    return ($pending.Wait($WaitMs) -and $client.Connected)
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Test-Health {
  param([int]$TimeoutMs = 3000)
  try {
    $request = [System.Net.HttpWebRequest]::Create($healthUrl)
    $request.Proxy = $null
    $request.Timeout = $TimeoutMs
    $request.ReadWriteTimeout = $TimeoutMs
    $response = $request.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      $body = $reader.ReadToEnd() | ConvertFrom-Json
      return [bool]$body.ok
    } finally {
      $response.Close()
    }
  } catch {
    return $false
  }
}

function Get-ListenerPid {
  $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count) { return [int]$listeners[0].OwningProcess }
  return 0
}

function Show-LogTail {
  param([string]$Path, [int]$Lines = 15)
  if (Test-Path -LiteralPath $Path) {
    $tail = @(Get-Content -LiteralPath $Path -Tail $Lines -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($tail.Count) {
      Write-Host ''
      Write-Host "---- $Path ----" -ForegroundColor DarkGray
      $tail | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
    }
  }
}

function Exit-Launcher {
  param([int]$Code)
  if ($Code -ne 0 -and -not $Quiet) {
    Write-Host ''
    Read-Host '按回车键关闭窗口' | Out-Null
  } elseif ($Code -eq 0) {
    Start-Sleep -Milliseconds 1200
  }
  exit $Code
}

if ((Test-PortOpen) -and (Test-Health)) {
  $serverPid = Get-ListenerPid
  Save-StartStatus -State 'already_running' -ProcessId $serverPid -Message 'GPT-Register is already running'
  Write-Host "GPT-Register 已在运行: $baseUrl (PID $serverPid)" -ForegroundColor Green
  try { Start-Process $baseUrl } catch { }
  Exit-Launcher 0
}

$distIndex = Join-Path $root 'web\dist\index.html'
if (-not (Test-Path -LiteralPath $distIndex)) {
  Write-Host '首次启动，正在构建前端页面 (可能需要一两分钟)...' -ForegroundColor Cyan
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $build = Start-Process `
    -FilePath $npm `
    -ArgumentList @('run', 'ui:build') `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime 'ui-build.stdout.log') `
    -RedirectStandardError (Join-Path $runtime 'ui-build.stderr.log') `
    -Wait `
    -PassThru
  if ($build.ExitCode -ne 0) {
    Save-StartStatus -State 'build_failed' -ProcessId 0 -Message "UI build exited with code $($build.ExitCode)"
    Write-Host "前端构建失败 (退出码 $($build.ExitCode))" -ForegroundColor Red
    Show-LogTail (Join-Path $runtime 'ui-build.stderr.log')
    Exit-Launcher 2
  }
}

$node = (Get-Command node.exe -ErrorAction Stop).Source

$server = Start-Process `
  -FilePath $node `
  -ArgumentList @('src/ui-server/index.js') `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru

[IO.File]::WriteAllText(
  (Join-Path $runtime 'ui-server.pid'),
  [string]$server.Id,
  [Text.UTF8Encoding]::new($false)
)
Save-StartStatus -State 'starting' -ProcessId $server.Id -Message 'Node is starting'

$watch = [Diagnostics.Stopwatch]::StartNew()
$deadlineMs = [Math]::Max(10, $TimeoutSec) * 1000
while ($watch.ElapsedMilliseconds -lt $deadlineMs) {
  $elapsed = [int]($watch.ElapsedMilliseconds / 1000)
  Write-Host -NoNewline ("`r正在启动 GPT-Register 控制台 (PID {0})，已等待 {1} 秒...   " -f $server.Id, $elapsed)

  if ($server.HasExited) {
    Write-Host ''
    if ((Test-PortOpen) -and (Test-Health)) {
      $serverPid = Get-ListenerPid
      Save-StartStatus -State 'already_running' -ProcessId $serverPid -Message 'GPT-Register is already running'
      Write-Host "GPT-Register 已在运行: $baseUrl (PID $serverPid)" -ForegroundColor Green
      try { Start-Process $baseUrl } catch { }
      Exit-Launcher 0
    }
    Save-StartStatus -State 'start_failed' -ProcessId $server.Id -Message "Node exited with code $($server.ExitCode)"
    Write-Host "启动失败：Node 进程已退出 (退出码 $($server.ExitCode))" -ForegroundColor Red
    Show-LogTail $stderrPath
    Exit-Launcher 3
  }
  if ((Test-PortOpen -WaitMs 250) -and (Test-Health)) {
    Write-Host ''
    $seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 1)
    Save-StartStatus -State 'running' -ProcessId $server.Id -Message "GPT-Register started successfully in ${seconds}s"
    Write-Host "GPT-Register 控制台已启动: $baseUrl (用时 $seconds 秒)" -ForegroundColor Green
    try { Start-Process $baseUrl } catch { }
    Exit-Launcher 0
  }
  Start-Sleep -Milliseconds 250
}

Write-Host ''
Save-StartStatus -State 'starting' -ProcessId $server.Id -Message "Node is running but the health endpoint did not answer within ${TimeoutSec}s"
Write-Host "Node 仍在运行 (PID $($server.Id))，但 $TimeoutSec 秒内未响应健康检查。" -ForegroundColor Yellow
Write-Host "可以稍后访问 $baseUrl ，或查看下面的日志。" -ForegroundColor Yellow
Show-LogTail $stdoutPath 5
Show-LogTail $stderrPath
Exit-Launcher 4
