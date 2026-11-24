# 第 18 代故障转移演练：在 TURING 上断网（任务 04f9b91b，D:/w/tmp/PLAN-failover-drill-gen18-20261124.md 第 1、5、8 节）。
# 一个提权进程从头到尾：
#   1. 记下状态为 Up 的物理网卡，写状态文件。
#   2. 注册一次性兜底任务（SYSTEM；触发：到点、开机；动作：启用记下的网卡并删掉自己），读回确认。没注册成就退出，不断网。
#   3. 待命：每 15 秒看一次放行文件（内容只有演练编号），最长 8 小时；到时不做任何事退出并删兜底任务。
#   4. 放行到了：读本机 status.json 核一次（ACTIVE、无在途批次、非 PAUSED、无 HALT、无暂停收单），不满足就删任务退出。
#   5. 把兜底任务的到点触发改成此刻 + 12 分钟并读回（不成就不断网），禁用网卡记 T0，睡 540 秒，finally 里启用网卡。
#   6. 等连通（github.com:443，最多 2 分钟）；网卡全部启用成才删兜底任务（否则留给它到点或开机再启用）；
#      写结果文件（本机 WorkDir 与共享目录各一份）。
# 真正动系统的动作收在 Get-DrillUpAdapters、Disable-DrillAdapters、Enable-DrillAdapters、Register-DrillBackstop、
# Remove-DrillBackstop 里；测试（test/failover-drill-cut.test.mjs）dot-source 本文件后换成桩。dot-source 只定义函数，不执行。
# 不停服务、不碰 companion、不碰冻结通道和生产开关。兜底任务是本脚本自己的临时任务，演练结束即删，结果文件记“已删”。
[CmdletBinding()]
param(
  [string]$DrillId,
  [string]$WorkDir = 'D:\agent-temp\failover-drill',
  [string]$SharedDir = 'G:\我的云端硬盘\Clued_资料中心\10_E_工程与平台\CI基础设施\现场工具',
  [string]$StatusFile = 'C:\ProgramData\CluedIndependentCI\resident\state\status.json',
  [string]$ReleaseFile
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$script:CutSeconds = 540              # 失联 9 分钟（第 2 节）
$script:BackstopMinutes = 12          # 兜底任务到点：断网后 12 分钟
$script:StandbyLimitSeconds = 8 * 3600
$script:PollSeconds = 15
$script:ReconnectSeconds = 120
$script:ProbeHost = 'github.com'
$script:ProbePort = 443

# --- 动系统的动作（测试换桩） ----------------------------------------------
function Get-DrillUpAdapters {
  @(Get-NetAdapter -Physical | Where-Object { [string]$_.Status -eq 'Up' } | ForEach-Object { [string]$_.Name })
}
function Disable-DrillAdapters([string[]]$Names) {
  foreach ($n in $Names) { Disable-NetAdapter -Name $n -Confirm:$false }
}
# 逐块启用，一块失败不影响其余；输出没启用成的网卡名（调用方用 @() 收）。
function Enable-DrillAdapters([string[]]$Names) {
  $failed = New-Object System.Collections.ArrayList
  foreach ($n in $Names) {
    try { Enable-NetAdapter -Name $n -Confirm:$false } catch { [void]$failed.Add($n) }
  }
  $failed
}
# 注册（或以同名覆盖）兜底任务：SYSTEM，触发为 $At 一次与开机时；动作启用 $Names 并删掉自己。读回任务与到点时刻，对得上才算成。
function Register-DrillBackstop([string]$TaskName, [string[]]$Names, [datetime]$At) {
  $quoted = @($Names | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ','
  $body = "foreach (`$n in @($quoted)) { try { Enable-NetAdapter -Name `$n -Confirm:`$false } catch { } }; " +
    "Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
  $local = $At.ToLocalTime()
  $triggers = @((New-ScheduledTaskTrigger -Once -At $local), (New-ScheduledTaskTrigger -AtStartup))
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  [void](Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force)
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) { return $false }
  $once = @($task.Triggers | Where-Object { $_.StartBoundary -and $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' })
  if (@($once).Count -ne 1) { return $false }
  [Math]::Abs(([datetime]$once[0].StartBoundary - $local).TotalSeconds) -lt 2
}
# 删兜底任务并读回；任务已不在也算删了。
function Remove-DrillBackstop([string]$TaskName) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  $null -eq (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
}
function Test-DrillConnectivity {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($script:ProbeHost, $script:ProbePort)
    $task.Wait(5000) -and $client.Connected
  } catch { $false } finally { $client.Dispose() }
}
function Get-DrillNow { [datetime]::UtcNow }
function Wait-DrillSeconds([int]$Seconds) { Start-Sleep -Seconds $Seconds }

# --- 纯逻辑 ------------------------------------------------------------------
function Get-DrillProp($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  if ($Object -is [Collections.IDictionary]) { return $Object[$Name] }
  $p = $Object.PSObject.Properties[$Name]; if ($null -ne $p) { return $p.Value }; return $null
}
function Format-DrillTime([datetime]$At) { $At.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }

# 本机 status.json 核一次：输出不满足的原因（调用方用 @() 收，空＝可以断）。读不到或不是 JSON 也算不满足。
function Get-DrillLocalProblems([string]$File) {
  try { $s = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return @("status.json 读不到：$($_.Exception.Message)") }
  $out = New-Object System.Collections.ArrayList
  $mode = Get-DrillProp (Get-DrillProp $s 'node') 'mode'
  if ($mode -cne 'ACTIVE') { [void]$out.Add("mode=$mode") }
  if ($null -ne (Get-DrillProp $s 'current')) { [void]$out.Add('有在途批次') }
  if ((Get-DrillProp $s 'paused') -eq $true) { [void]$out.Add('paused') }
  $state = Get-DrillProp (Get-DrillProp $s 'executor') 'state'
  if ($state -ceq 'PAUSED' -or $state -ceq 'HALTED') { [void]$out.Add("executor=$state") }
  if ($null -ne (Get-DrillProp $s 'halt')) { [void]$out.Add('HALT') }
  if ($null -ne (Get-DrillProp $s 'intakePause')) { [void]$out.Add('暂停收单') }
  $out
}
function Test-DrillRelease([string]$File, [string]$Id) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $false }
  try { return ((Get-Content -LiteralPath $File -Raw).Trim() -ceq $Id) } catch { return $false }
}
function Write-DrillJson([string]$File, $Value) {
  $dir = Split-Path -Parent $File
  if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
  [IO.File]::WriteAllText($File, ($Value | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
}
function Write-DrillLine([string]$Text) { Write-Host ("[{0}] {1}" -f (Format-DrillTime (Get-DrillNow)), $Text) }

# --- 主流程 ------------------------------------------------------------------
# 第 1–6 步；$r 是结果（有序字典，按引用改），任一步不满足就 return，外层照样写结果文件。
function Invoke-DrillCutSteps($r, [string]$DrillId, [string]$WorkDir, [string]$StatusFile, [string]$ReleaseFile, [string]$taskName) {
  $stateFile = Join-Path $WorkDir "failover-drill-$DrillId.state.json"
  # 1. 记下在用的物理网卡
  $names = @(Get-DrillUpAdapters)
  $r.adapters = $names
  Write-DrillJson $stateFile $r
  if (@($names).Count -eq 0) { $r.outcome = 'NO_ADAPTER'; $r.detail = '没有状态为 Up 的物理网卡'; return }
  Write-DrillLine ("在用网卡：{0}" -f ($names -join '、'))

  # 2. 兜底任务（此刻到点触发先放在待命上限之后，放行时再改到断网后 12 分钟）
  $ok = $false
  try { $ok = [bool](Register-DrillBackstop $taskName $names ((Get-DrillNow).AddSeconds($script:StandbyLimitSeconds).AddMinutes($script:BackstopMinutes))) }
  catch { $r.error = "注册兜底任务：$($_.Exception.Message)" }
  if (-not $ok) { $r.outcome = 'BACKSTOP_NOT_REGISTERED'; $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName); return }
  $r.backstopRegistered = $true
  Write-DrillJson $stateFile $r

  # 3. 待命
  Write-DrillLine "待命，等放行文件 $ReleaseFile"
  $deadline = (Get-DrillNow).AddSeconds($script:StandbyLimitSeconds)
  while (-not (Test-DrillRelease $ReleaseFile $DrillId)) {
    if ((Get-DrillNow) -ge $deadline) {
      $r.outcome = 'STANDBY_TIMEOUT'; $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName); return
    }
    Wait-DrillSeconds $script:PollSeconds
  }
  $r.releasedAt = Format-DrillTime (Get-DrillNow)

  # 4. 本机状态再核一次
  $problems = @(Get-DrillLocalProblems $StatusFile)
  if (@($problems).Count -gt 0) {
    $r.localProblems = $problems; $r.outcome = 'LOCAL_STATUS_NOT_READY'; $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName); return
  }

  # 5. 兜底到点改为此刻 + 12 分钟，读回对了才断
  $ok = $false
  try { $ok = [bool](Register-DrillBackstop $taskName $names ((Get-DrillNow).AddMinutes($script:BackstopMinutes))) }
  catch { $r.error = "改兜底任务到点：$($_.Exception.Message)" }
  if (-not $ok) { $r.outcome = 'BACKSTOP_NOT_REGISTERED'; $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName); return }

  $interrupted = $false
  try {
    $r.t0 = Format-DrillTime (Get-DrillNow)
    Write-DrillJson $stateFile $r
    Write-DrillLine "断网（T0），$($script:CutSeconds) 秒后复网"
    Disable-DrillAdapters $names
    Wait-DrillSeconds $script:CutSeconds
  } catch {
    $interrupted = $true; $r.error = "断网期间：$($_.Exception.Message)"
  } finally {
    $r.enableFailed = @(Enable-DrillAdapters $names)
    $r.restoredAt = Format-DrillTime (Get-DrillNow)
  }
  Write-DrillLine '已复网，等连通'

  # 6. 等连通、删兜底任务
  $until = (Get-DrillNow).AddSeconds($script:ReconnectSeconds)
  $r.connected = $false
  while ($true) {
    if (Test-DrillConnectivity) { $r.connected = $true; $r.connectedAt = Format-DrillTime (Get-DrillNow); break }
    if ((Get-DrillNow) -ge $until) { break }
    Wait-DrillSeconds 5
  }
  if (@($r.enableFailed).Count -eq 0) { $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName) }
  $r.outcome = if ($interrupted) { 'CUT_INTERRUPTED' } else { 'CUT_DONE' }
}

function Invoke-FailoverDrillCut {
  param([string]$DrillId, [string]$WorkDir, [string]$SharedDir, [string]$StatusFile, [string]$ReleaseFile)
  if ($DrillId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,39}$') { throw "DrillId 不合格：$DrillId" }
  if (-not $ReleaseFile) { $ReleaseFile = Join-Path $WorkDir "release-$DrillId.txt" }
  $taskName = "CluedFailoverDrillRestore-$DrillId"
  $r = [ordered]@{ drillId = $DrillId; outcome = $null; detail = $null; computer = $env:COMPUTERNAME; startedAt = (Format-DrillTime (Get-DrillNow))
    adapters = @(); backstopTask = $taskName; backstopRegistered = $false; releasedAt = $null; localProblems = @(); t0 = $null; restoredAt = $null
    enableFailed = @(); connected = $null; connectedAt = $null; backstopRemoved = $false; error = $null; sharedWritten = $null; finishedAt = $null }
  try {
    # 步骤里的杂散输出不进结果
    $null = Invoke-DrillCutSteps $r $DrillId $WorkDir $StatusFile $ReleaseFile $taskName
  } catch {
    if (-not $r.outcome) { $r.outcome = 'SCRIPT_ERROR' }
    $r.error = $_.Exception.Message
  } finally {
    $r.finishedAt = Format-DrillTime (Get-DrillNow)
    $name = "failover-drill-$DrillId.result.json"
    try { Write-DrillJson (Join-Path $WorkDir $name) $r } catch { }
    try { Write-DrillJson (Join-Path $SharedDir $name) $r; $r.sharedWritten = $true } catch { $r.sharedWritten = $false }
    try { Write-DrillJson (Join-Path $WorkDir $name) $r } catch { }
    Write-DrillLine "结束：$($r.outcome)"
  }
  [pscustomobject]$r
}

if ($MyInvocation.InvocationName -ne '.') {
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  $result = Invoke-FailoverDrillCut -DrillId $DrillId -WorkDir $WorkDir -SharedDir $SharedDir -StatusFile $StatusFile -ReleaseFile $ReleaseFile
  $result | ConvertTo-Json -Depth 6
  if ($result.outcome -cne 'CUT_DONE') { exit 1 }
}
