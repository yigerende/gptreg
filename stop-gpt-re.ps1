$root = $PSScriptRoot
$port = 3210
$runtime = Join-Path $root '.gpt-re-state\v2\runtime'
$pidFile = Join-Path $runtime 'ui-server.pid'

$stopped = $false

if (Test-Path -LiteralPath $pidFile) {
  $savedPid = Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue
  if ($savedPid -and ($savedPid -match '^\d+$')) {
    $targetPid = [int]$savedPid
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
      Write-Host "已通过 PID $targetPid 停止 GPT-Register 服务。" -ForegroundColor Green
      $stopped = $true
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $p = [int]$listener.OwningProcess
  if ($p -gt 0) {
    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    Write-Host "已停止监听端口 $port 的进程 (PID $p)。" -ForegroundColor Green
    $stopped = $true
  }
}

if (-not $stopped) {
  Write-Host "未发现正在运行的 GPT-Register 服务 (端口 $port 空闲)。" -ForegroundColor Yellow
} else {
  Write-Host "GPT-Register 已完全停止。" -ForegroundColor Green
}
Start-Sleep -Seconds 1
