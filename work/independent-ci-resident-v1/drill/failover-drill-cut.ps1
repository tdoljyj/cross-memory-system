# 第 18 代故障转移演练：在 TURING 上断网（任务 04f9b91b；方案 D:/w/tmp/PLAN-failover-drill-gen18-20261124.md 第 1、5、8 节，
# 定案 D:/w/tmp/PLAN-failover-drill-gen18-addendum-20261124.md 第 1 节第 1、3、5 条，独立复核 D:/w/tmp/claude-review-failover-drill-gen18-fable.md M1、M2、S1；
# 补充二第 2 条 S2、S4；补充三“读回出错”）。
# 本轮的 error 字段记最近一次失败的原因；后面重试成了也留着，配合 backstopRetries 看。
# 一个提权进程从头到尾，只碰 TURING 本机路径（共享目录那份结果文件尽力写）：
#   0. 放行文件所在目录探针写一次，写不进就退出（不空等）。
#   1. 记下状态为 Up 的物理网卡，写状态文件。其中有不是有线（PhysicalMediaType 不是 802.3）的就退出：断了可能连不回，
#      兜底任务只会启用、救不了（S2）。
#   2. 注册兜底任务（原地最多试 3 次、间隔 5 秒，补充三；SYSTEM；触发：到点起每 2 分钟重复一天、开机；动作：启用记下的网卡，读回都不是 Disabled 才删掉自己），读回确认。
#      没注册成就退出，不断网。注册成了，进入待命前最后一步清放行文件：此刻已有的（上一次留下的、待命前或注册重试期间写的）
#      都删掉，删不掉就删兜底任务退出（只在这一处清）。
#   3. 待命：每 15 秒看一次放行文件（内容只有演练编号；只认待命之后写的，第 2 步末尾已清掉旧的），最长 8 小时；到时删兜底任务退出。
#      放行到了先读本机 status.json 核一次（ACTIVE、无在途批次、非 PAUSED、无 HALT、无暂停收单；这几个键和 writtenAt 缺一个
#      就算不满足，writtenAt 距此刻超过 120 秒也算不满足，S4）：不满足就删掉这份放行文件、
#      把原因写进状态文件、回到待命；放行文件删不掉才退出。满足就删掉放行文件（用过即删）往下走。
#   4. 重列在用网卡，与第 1 步的取并集；此刻有非有线网卡在用就删兜底任务退出，不断网（S2）；
#      把兜底任务按并集、到点改成此刻 + 12 分钟重注册并读回，
#      抛错或读回不对就不断网、回到待命（放行文件已删、兜底任务留着，等重新放行，8 小时上限不变；补充三），
#      按并集禁用网卡记 T0，睡 540 秒，finally 里按并集启用网卡并读回。
#   5. 等连通（github.com:443，最多 2 分钟）；网卡全部读回已启用才删兜底任务（否则留给它重复触发或开机再启用）；
#      写结果文件（本机 WorkDir 与共享目录各一份）。
# 真正动系统的动作收在 Get-DrillUpAdapters、Get-DrillNonWiredUp、Disable-DrillAdapters、Enable-DrillAdapters、Register-DrillBackstop、
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
$script:BackstopRepeatMinutes = 2     # 到点之后每 2 分钟再触发一次，持续 1 天（复核 M1）
$script:BackstopTries = 5             # 每次触发里启用并读回最多 5 遍，间隔 10 秒
$script:StandbyLimitSeconds = 8 * 3600
$script:RegisterTries = 3             # 待命前注册兜底任务原地最多试 3 次（补充三）
$script:RegisterGapSeconds = 5
$script:PollSeconds = 15
$script:ReconnectSeconds = 120
$script:ProbeHost = 'github.com'
$script:ProbePort = 443
$script:StatusFreshSeconds = 120      # 本机 status.json 的 writtenAt 距此刻不超过 120 秒（S4；与门侧的 120 秒各写各的）

# --- 动系统的动作（测试换桩） ----------------------------------------------
function Get-DrillUpAdapters {
  @(Get-NetAdapter -Physical | Where-Object { [string]$_.Status -eq 'Up' } | ForEach-Object { [string]$_.Name })
}
# 状态为 Up、PhysicalMediaType 不是 802.3（有线）的物理网卡名（S2）。
function Get-DrillNonWiredUp {
  @(Get-NetAdapter -Physical | Where-Object { [string]$_.Status -eq 'Up' -and [string]$_.PhysicalMediaType -ne '802.3' } | ForEach-Object { [string]$_.Name })
}
function Disable-DrillAdapters([string[]]$Names) {
  foreach ($n in $Names) { Disable-NetAdapter -Name $n -Confirm:$false }
}
# 逐块启用，一块失败不影响其余；启用后读回，仍是 Disabled 或读不到的也算没启用成（复核 M1）。输出没启用成的网卡名（调用方用 @() 收）。
function Enable-DrillAdapters([string[]]$Names) {
  $failed = New-Object System.Collections.ArrayList
  foreach ($n in $Names) {
    try { Enable-NetAdapter -Name $n -Confirm:$false -ErrorAction Stop } catch { [void]$failed.Add($n); continue }
    try { $back = [string](Get-NetAdapter -Name $n -ErrorAction Stop).Status } catch { $back = $null }
    if ($null -eq $back -or $back -eq 'Disabled') { [void]$failed.Add($n) }
  }
  $failed
}
# 兜底任务的动作（PowerShell 文本）：逐块启用，读回全部不是 Disabled 才删掉任务；否则隔 10 秒再来，几遍都不成就留着任务等下一次触发。
function Get-DrillBackstopCommand([string]$TaskName, [string[]]$Names) {
  $quoted = @($Names | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ','
  $task = "'" + ($TaskName -replace "'", "''") + "'"
  # 兜底动作在独立 PowerShell 进程运行，命令须自带等待函数。
  "function Wait-DrillSeconds { ${function:Wait-DrillSeconds} }; " +
  "`$names = @($quoted); " +
  "for (`$i = 0; `$i -lt $($script:BackstopTries); `$i++) { " +
    "foreach (`$n in `$names) { try { Enable-NetAdapter -Name `$n -Confirm:`$false -ErrorAction Stop } catch { } }; " +
    "`$left = @(`$names | Where-Object { `$s = `$null; try { `$s = [string](Get-NetAdapter -Name `$_ -ErrorAction Stop).Status } catch { }; (`$null -eq `$s) -or (`$s -eq 'Disabled') }); " +
    "if (`$left.Count -eq 0) { Unregister-ScheduledTask -TaskName $task -Confirm:`$false; break }; " +
    "Wait-DrillSeconds 10 }"
}
# 到点触发（起每 2 分钟重复，持续 1 天）与开机触发。
function New-DrillBackstopTriggers([datetime]$At) {
  $local = $At.ToLocalTime()
  @((New-ScheduledTaskTrigger -Once -At $local -RepetitionInterval (New-TimeSpan -Minutes $script:BackstopRepeatMinutes) -RepetitionDuration (New-TimeSpan -Days 1)),
    (New-ScheduledTaskTrigger -AtStartup))
}
# 注册（或以同名覆盖）兜底任务：SYSTEM，读回任务、到点时刻与重复间隔，对得上才算成。
function Register-DrillBackstop([string]$TaskName, [string[]]$Names, [datetime]$At) {
  $body = Get-DrillBackstopCommand $TaskName $Names
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
  $local = $At.ToLocalTime()
  $triggers = @(New-DrillBackstopTriggers $At)
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  [void](Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force)
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) { return $false }
  $once = @($task.Triggers | Where-Object { $_.StartBoundary -and $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' })
  if (@($once).Count -ne 1) { return $false }
  if ([string]$once[0].Repetition.Interval -ne ('PT{0}M' -f $script:BackstopRepeatMinutes)) { return $false }
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
function Wait-DrillSeconds { param([int]$Seconds) Start-Sleep -Seconds $Seconds }

# --- 纯逻辑 ------------------------------------------------------------------
function Get-DrillProp($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  if ($Object -is [Collections.IDictionary]) { return $Object[$Name] }
  $p = $Object.PSObject.Properties[$Name]; if ($null -ne $p) { return $p.Value }; return $null
}
function Format-DrillTime([datetime]$At) { $At.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }

function Test-DrillHasProp($Object, [string]$Name) {
  if ($null -eq $Object) { return $false }
  if ($Object -is [Collections.IDictionary]) { return $Object.Contains($Name) }
  $null -ne $Object.PSObject.Properties[$Name]
}
# 时刻文本（或 5.1 以外的 ConvertFrom-Json 已转好的 DateTime）转成 UTC；解析不了给 $null。
function ConvertTo-DrillUtc($Value) {
  if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
  try { return [DateTimeOffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime } catch { return $null }
}

# 本机 status.json 核一次：输出不满足的原因（调用方用 @() 收，空＝可以断）。读不到或不是 JSON 也算不满足；
# 要核的键缺一个就记“缺 <键>”，writtenAt 距此刻超过 120 秒或解析不了记“status.json 不新鲜”（S4）。
function Get-DrillLocalProblems([string]$File) {
  try { $s = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return @("status.json 读不到：$($_.Exception.Message)") }
  $out = New-Object System.Collections.ArrayList
  $node = Get-DrillProp $s 'node'; $executor = Get-DrillProp $s 'executor'
  # 键路径 → 它所在的对象；父键缺了只记父键
  $where = [ordered]@{ 'node' = $s; 'node.mode' = $node; 'current' = $s; 'paused' = $s; 'halt' = $s; 'intakePause' = $s
    'executor' = $s; 'executor.state' = $executor; 'writtenAt' = $s }
  $missing = New-Object System.Collections.ArrayList
  foreach ($k in $where.Keys) {
    $parts = $k.Split('.')
    if ($parts.Count -gt 1 -and $missing.Contains($parts[0])) { continue }
    if (-not (Test-DrillHasProp $where[$k] $parts[-1])) { [void]$missing.Add($k); [void]$out.Add("缺 $k") }
  }
  if (-not $missing.Contains('node') -and -not $missing.Contains('node.mode')) {
    $mode = Get-DrillProp $node 'mode'; if ($mode -cne 'ACTIVE') { [void]$out.Add("mode=$mode") }
  }
  if ($null -ne (Get-DrillProp $s 'current')) { [void]$out.Add('有在途批次') }
  if ((Get-DrillProp $s 'paused') -eq $true) { [void]$out.Add('paused') }
  $state = Get-DrillProp $executor 'state'
  if ($state -ceq 'PAUSED' -or $state -ceq 'HALTED') { [void]$out.Add("executor=$state") }
  if ($null -ne (Get-DrillProp $s 'halt')) { [void]$out.Add('HALT') }
  if ($null -ne (Get-DrillProp $s 'intakePause')) { [void]$out.Add('暂停收单') }
  if (-not $missing.Contains('writtenAt')) {
    $written = ConvertTo-DrillUtc (Get-DrillProp $s 'writtenAt')
    if ($null -eq $written -or [Math]::Abs(((Get-DrillNow).ToUniversalTime() - $written).TotalSeconds) -gt $script:StatusFreshSeconds) { [void]$out.Add('status.json 不新鲜') }
  }
  $out
}
function Test-DrillRelease([string]$File, [string]$Id) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $false }
  try { return ((Get-Content -LiteralPath $File -Raw).Trim() -ceq $Id) } catch { return $false }
}
# 删放行文件并读回；本来就不在也算删了。
function Remove-DrillRelease([string]$File) {
  try { if (Test-Path -LiteralPath $File) { Remove-Item -LiteralPath $File -Force -ErrorAction Stop } } catch { }
  -not (Test-Path -LiteralPath $File)
}
# 放行文件所在目录能不能写：建目录（没有的话）、写一个探针文件再删掉。
function Test-DrillDirWritable([string]$Dir) {
  try {
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { [void](New-Item -ItemType Directory -Path $Dir -Force -ErrorAction Stop) }
    $probe = Join-Path $Dir (".probe-{0}.tmp" -f [guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($probe, 'probe')
    Remove-Item -LiteralPath $probe -Force -ErrorAction Stop
    return $true
  } catch { return $false }
}
function Write-DrillJson([string]$File, $Value) {
  $dir = Split-Path -Parent $File
  if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
  [IO.File]::WriteAllText($File, ($Value | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
}
function Write-DrillLine([string]$Text) { Write-Host ("[{0}] {1}" -f (Format-DrillTime (Get-DrillNow)), $Text) }

# --- 主流程 ------------------------------------------------------------------
# 第 0–5 步；$r 是结果（有序字典，按引用改），任一步不满足就 return，外层照样写结果文件。
function Invoke-DrillCutSteps($r, [string]$DrillId, [string]$WorkDir, [string]$StatusFile, [string]$ReleaseFile, [string]$taskName) {
  $stateFile = Join-Path $WorkDir "failover-drill-$DrillId.state.json"
  # 0. 放行文件所在目录写得进（旧放行文件在第 2 步末尾、进入待命前清）
  if (-not (Test-DrillDirWritable (Split-Path -Parent $ReleaseFile))) {
    $r.outcome = 'RELEASE_DIR_NOT_WRITABLE'; $r.detail = "放行文件所在目录写不进：$ReleaseFile"; return
  }

  # 1. 记下在用的物理网卡；有不是有线的就不断（S2）
  $names = @(Get-DrillUpAdapters)
  $r.adapters = $names
  Write-DrillJson $stateFile $r
  if (@($names).Count -eq 0) { $r.outcome = 'NO_ADAPTER'; $r.detail = '没有状态为 Up 的物理网卡'; return }
  $nonWired = @(Get-DrillNonWiredUp)
  if (@($nonWired).Count -gt 0) { $r.outcome = 'NON_WIRED_ADAPTER'; $r.detail = "在用的非有线网卡：$($nonWired -join '、')"; return }
  Write-DrillLine ("在用网卡：{0}" -f ($names -join '、'))

  # 2. 兜底任务（此刻到点触发先放在待命上限之后，放行时再改到断网后 12 分钟）；原地最多试 3 次，间隔 5 秒（补充三）
  $ok = $false
  for ($try = 1; $try -le $script:RegisterTries; $try++) {
    $why = '读回不对'
    try { $ok = [bool](Register-DrillBackstop $taskName $names ((Get-DrillNow).AddSeconds($script:StandbyLimitSeconds).AddMinutes($script:BackstopMinutes))) }
    catch { $ok = $false; $why = $_.Exception.Message }
    if ($ok) { break }
    $r.error = "注册兜底任务（第 $try 次）：$why"
    if ($try -lt $script:RegisterTries) { Wait-DrillSeconds $script:RegisterGapSeconds }
  }
  if (-not $ok) { $r.outcome = 'BACKSTOP_NOT_REGISTERED'; $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName); return }
  $r.backstopRegistered = $true
  # 进入待命前最后一步：清掉此刻已有的放行文件（上一次留下的、待命前或注册重试期间写的都不算；只在这一处清）
  if (Test-Path -LiteralPath $ReleaseFile) {
    if (-not (Remove-DrillRelease $ReleaseFile)) {
      $r.outcome = 'RELEASE_PREEXISTS'; $r.detail = "待命前就有放行文件且删不掉：$ReleaseFile"; $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName); return
    }
    $r.staleReleaseRemoved = $true
  }
  $r.standbySince = Format-DrillTime (Get-DrillNow)
  Write-DrillJson $stateFile $r

  # 3. 待命；放行到了本机状态不满足就删掉这份放行文件、回到待命
  # 4.（在待命循环里）重列网卡取并集（待命期间新连上的也要断）；兜底到点改为此刻 + 12 分钟，读回对了才断，
  #    读回不对就回到待命，兜底任务原样留着（补充三）
  Write-DrillLine "待命，等放行文件 $ReleaseFile"
  $deadline = (Get-DrillNow).AddSeconds($script:StandbyLimitSeconds)
  while ($true) {
    if (Test-DrillRelease $ReleaseFile $DrillId) {
      $problems = @(Get-DrillLocalProblems $StatusFile)
      if (@($problems).Count -eq 0) {
        if (-not (Remove-DrillRelease $ReleaseFile)) {
          $r.outcome = 'RELEASE_NOT_REMOVED'; $r.detail = "放行文件用后删不掉：$ReleaseFile"; $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName); return
        }
        $r.releasedAt = Format-DrillTime (Get-DrillNow)
        $union = New-Object System.Collections.ArrayList
        foreach ($n in @($names) + @(Get-DrillUpAdapters)) { if ($n -and -not $union.Contains($n)) { [void]$union.Add($n) } }
        $names = @($union)
        $r.adapters = $names
        Write-DrillJson $stateFile $r
        if (@($names).Count -eq 0) { $r.outcome = 'NO_ADAPTER'; $r.detail = '没有状态为 Up 的物理网卡'; $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName); return }
        $nonWired = @(Get-DrillNonWiredUp)
        if (@($nonWired).Count -gt 0) {
          $r.outcome = 'NON_WIRED_ADAPTER'; $r.detail = "待命期间连上的非有线网卡：$($nonWired -join '、')"; $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName); return
        }
        $ok = $false; $why = '读回不对'
        try { $ok = [bool](Register-DrillBackstop $taskName $names ((Get-DrillNow).AddMinutes($script:BackstopMinutes))) }
        catch { $ok = $false; $why = $_.Exception.Message }
        if ($ok) { break }
        $r.error = "改兜底任务到点：$why"
        $r.backstopRetries = [int]$r.backstopRetries + 1
        Write-DrillLine "$($r.error)，不断网，回到待命"
        Write-DrillJson $stateFile $r
      } else {
        $r.localProblems = $problems
        $r.releasesRefused = [int]$r.releasesRefused + 1
        $r.lastRefusedAt = Format-DrillTime (Get-DrillNow)
        if (-not (Remove-DrillRelease $ReleaseFile)) {
          $r.outcome = 'LOCAL_STATUS_NOT_READY'; $r.detail = "本机状态不满足且放行文件删不掉：$ReleaseFile"; $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName); return
        }
        Write-DrillLine ("本机状态不满足（{0}），已删放行文件，回到待命" -f ($problems -join '、'))
        Write-DrillJson $stateFile $r
      }
    }
    if ((Get-DrillNow) -ge $deadline) {
      $r.outcome = 'STANDBY_TIMEOUT'; $r.backstopRemoved = [bool](Remove-DrillBackstop $taskName); return
    }
    Wait-DrillSeconds $script:PollSeconds
  }

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

  # 5. 等连通、删兜底任务
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
    releaseFile = $ReleaseFile; staleReleaseRemoved = $false; adapters = @(); backstopTask = $taskName; backstopRegistered = $false; standbySince = $null
    releasesRefused = 0; lastRefusedAt = $null; backstopRetries = 0; localProblems = @(); releasedAt = $null; t0 = $null; restoredAt = $null
    enableFailed = @(); connected = $null; connectedAt = $null; backstopRemoved = $false; error = $null; sharedWritten = $null; finishedAt = $null }
  try {
    # 步骤里的杂散输出不进结果
    $null = Invoke-DrillCutSteps $r $DrillId $WorkDir $StatusFile $ReleaseFile $taskName
  } catch {
    if (-not $r.outcome) { $r.outcome = 'SCRIPT_ERROR' }
    $r.error = $_.Exception.Message
  } finally {
    # 放行文件只用一次：任何结局都不留给下一次（尽力删；下一次启动第 0 步还会再清）
    try { $null = Remove-DrillRelease $ReleaseFile } catch { }
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
