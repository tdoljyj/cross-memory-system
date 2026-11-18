# Windows PowerShell 5.1。普通窗口看计划，Owner 本人提权应用；服务端只接收令牌哈希。
[CmdletBinding()]
param([string]$TokenFile, [switch]$Apply,
  [ValidatePattern('^[0-9a-f]{64}\z')][string]$ExpectedPlanSha256)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$env:PSModulePath=Join-Path $PSHOME 'Modules'
. (Join-Path $PSScriptRoot 'verify-resident.ps1') -FunctionsOnly

function Get-CiFileDescriptor([string]$controllerSid) {
  'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;' + $controllerSid + ')'
}
function Get-CiHostAuthority($residentRoot,$node) {
  $id=[Security.Principal.WindowsIdentity]::GetCurrent()
  $principal=New-Object Security.Principal.WindowsPrincipal($id)
  if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }
  if ([Environment]::MachineName -ine $node.hostname) { throw 'NODE_HOST_REQUIRED' }
  $operator=$node.ownerSid
  $accountFile=Join-Path $residentRoot 'install\companion-account.json'
  try { $a=Get-Item -LiteralPath $accountFile -Force -ErrorAction Stop }
  catch [Management.Automation.ItemNotFoundException] { $a=$null }
  if ($a) {
    Assert-CiRegularPath $accountFile
    $account=Get-Content -LiteralPath $accountFile -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($account.contract -cne 'clued.independent-ci.companion-account/1' -or $account.companionSid -cne $node.ownerSid -or
        $account.operatorSid -ceq $node.ownerSid) { throw 'COMPANION_ACCOUNT_RECORD_REFUSED' }
    $operator=$account.operatorSid
  }
  if ($id.User.Value -cne $operator) { throw 'OWNER_ACCOUNT_REQUIRED' }
  $true
}
function Assert-CiRegularPath([string]$file) {
  $path=[IO.Path]::GetFullPath($file)
  if ($path -notmatch '^[a-z]:\\' -or $path.Substring(2).Contains(':')) { throw 'CI_FILE_PATH_REFUSED' }
  for ($p=$path; $p; $p=[IO.Path]::GetDirectoryName($p)) {
    $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($p -ceq $path -and ($item.PSIsContainer -or $item.LinkType -eq 'HardLink')) -or
        ($p -cne $path -and !$item.PSIsContainer)) { throw 'CI_FILE_PATH_REFUSED' }
  }
}
function Get-CiJwkFingerprint($jwk) {
  if ($jwk.kty -cne 'EC' -or $jwk.crv -cne 'P-256' -or $jwk.x -cnotmatch '^[A-Za-z0-9_-]{43}\z' -or
      $jwk.y -cnotmatch '^[A-Za-z0-9_-]{43}\z') { throw 'CI_CONNECTION_LOCAL_IDENTITY_UNAVAILABLE' }
  Sha256Text (([ordered]@{crv='P-256';kty='EC';x=$jwk.x;y=$jwk.y}) | ConvertTo-Json -Compress)
}
function Get-CiBlobFingerprint([byte[]]$blob) {
  if ($blob.Length -ne 72 -or [BitConverter]::ToUInt32($blob,0) -ne 0x31534345 -or
      [BitConverter]::ToUInt32($blob,4) -ne 32) { throw 'CI_CONNECTION_LOCAL_IDENTITY_UNAVAILABLE' }
  $x=[Convert]::ToBase64String($blob,8,32).TrimEnd('=').Replace('+','-').Replace('/','_')
  $y=[Convert]::ToBase64String($blob,40,32).TrimEnd('=').Replace('+','-').Replace('/','_')
  Get-CiJwkFingerprint @{kty='EC';crv='P-256';x=$x;y=$y}
}
function Get-LocalCiIdentityFingerprint {
  $name='Clued-CI-Node-Identity-v1'
  $scope=[Security.Cryptography.CngKeyOpenOptions]::MachineKey
  foreach ($providerName in @('Microsoft Platform Crypto Provider','Microsoft Software Key Storage Provider')) {
    $provider=New-Object Security.Cryptography.CngProvider($providerName)
    try { $exists=[Security.Cryptography.CngKey]::Exists($name,$provider,$scope) } catch { continue }
    if (!$exists) { continue }
    $key=[Security.Cryptography.CngKey]::Open($name,$provider,$scope)
    try {
      $blob=$key.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
      return Get-CiBlobFingerprint $blob
    } finally { $key.Dispose() }
  }
  throw 'CI_CONNECTION_LOCAL_IDENTITY_UNAVAILABLE'
}
function Read-CiInput([string]$source,[string]$ciRoot) {
  if (!$source) {
    $c=Get-Credential -UserName 'ci-admission' -Message '请将新 CI 连接令牌粘贴到密码栏。'
    if ($null -eq $c) { throw 'CREDENTIAL_DIALOG_CANCELLED' }
    $pass=$c.Password
    $ptr=[Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($pass)
    try {
      $chars=New-Object char[] $pass.Length
      [Runtime.InteropServices.Marshal]::Copy($ptr,$chars,0,$chars.Length)
      try { return ,([Text.Encoding]::UTF8.GetBytes($chars)) } finally { [Array]::Clear($chars,0,$chars.Length) }
    } finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr); $pass.Dispose() }
  }
  $path=[IO.Path]::GetFullPath($source)
  if ($path.StartsWith($ciRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'CI_INPUT_INSIDE_INSTALLATION' }
  Assert-CiRegularPath $path
  $item=Get-Item -LiteralPath $path -Force
  if ($item.Length -lt 1 -or $item.Length -gt 4096) { throw 'CI_INPUT_SIZE_REFUSED' }
  # Windows 在同一个独占句柄关闭时删除刚读过的文件。
  $s=New-Object IO.FileStream($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None,4096,[IO.FileOptions]::DeleteOnClose)
  try {
    if ($s.Length -ne $item.Length) { throw 'CI_INPUT_SIZE_REFUSED' }
    $b=New-Object byte[] ([int]$s.Length)
    $n=0
    while ($n -lt $b.Length) { $read=$s.Read($b,$n,$b.Length-$n); if ($read -eq 0) { throw 'CI_INPUT_SIZE_REFUSED' }; $n+=$read }
    return ,$b
  } finally { $s.Dispose() }
}
function Invoke-CiHttp([string]$uri,[string]$key,[string]$body) {
  $request=[Net.HttpWebRequest]::CreateHttp($uri)
  $request.Method='POST'; $request.AllowAutoRedirect=$false; $request.Timeout=10000; $request.ReadWriteTimeout=10000
  $request.ContentType='application/json'; $request.Headers['apikey']=$key; $request.Headers['Authorization']='Bearer '+$key
  try {
    $bytes=[Text.Encoding]::UTF8.GetBytes($body)
    $s=$request.GetRequestStream()
    try { $s.Write($bytes,0,$bytes.Length) } finally { $s.Dispose() }
    $response=$request.GetResponse()
    try {
      $s=$response.GetResponseStream(); $memory=New-Object IO.MemoryStream
      try {
        $buffer=New-Object byte[] 4096
        while (($n=$s.Read($buffer,0,$buffer.Length)) -gt 0) {
          if ($memory.Length+$n -gt 16384) { throw 'CI_CONNECTION_SELF_UNAVAILABLE' }
          $memory.Write($buffer,0,$n)
        }
        @{status=[int]$response.StatusCode;text=(New-Object Text.UTF8Encoding($false,$true)).GetString($memory.ToArray())}
      } finally { $memory.Dispose(); $s.Dispose() }
    } finally { $response.Dispose() }
  } catch [Net.WebException] {
    $response=$_.Exception.Response
    if (!$response) { throw 'CI_CONNECTION_SELF_UNAVAILABLE' }
    try { @{status=[int]$response.StatusCode;text=''} } finally { $response.Dispose() }
  } finally { $request.Abort() }
}
function Assert-CiReplyKeys($object,[string[]]$keys) {
  if ($object -isnot [pscustomobject] -or @($object.PSObject.Properties).Count -ne $keys.Count) { throw 'CI_CONNECTION_SELF_UNAVAILABLE' }
  foreach ($k in $keys) { if (@($object.PSObject.Properties.Name) -cnotcontains $k) { throw 'CI_CONNECTION_SELF_UNAVAILABLE' } }
}
function Test-CiTokenInName([string]$name,[byte[]]$token) {
  $bytes=[Text.Encoding]::UTF8.GetBytes($name)
  try {
    for ($i=0;$i -le $bytes.Length-$token.Length;$i++) {
      $j=0
      while ($j -lt $token.Length -and $bytes[$i+$j] -eq $token[$j]) { $j++ }
      if ($j -eq $token.Length) { return $true }
    }
    $false
  } finally { [Array]::Clear($bytes,0,$bytes.Length) }
}
function Get-CiSelf($config,[byte[]]$token) {
  if ($config.supabaseUrl -cnotmatch '^https://[a-z0-9]+\.supabase\.co\z' -or
      $config.publishableKey -cnotmatch '^sb_publishable_[A-Za-z0-9_-]+\z' -or
      $config.scope -cnotmatch '^(global|project:[0-9a-f-]{36})\z') { throw 'CI_CONNECTION_SELF_UNAVAILABLE' }
  $body=@{p_token_hash=(Get-CiHash $token);p_input=@{scope=$config.scope}} | ConvertTo-Json -Depth 3 -Compress
  try { $response=Invoke-CiHttp ($config.supabaseUrl+'/rest/v1/rpc/clued_ci_connection_self_v1') $config.publishableKey $body }
  catch { throw 'CI_CONNECTION_SELF_UNAVAILABLE' }
  if ($response.status -in 401,403) { throw 'CI_CONNECTION_TOKEN_REFUSED' }
  if ($response.status -ne 200) { throw 'CI_CONNECTION_SELF_UNAVAILABLE' }
  try {
    # PS 5.1 的 ConvertFrom-Json 会覆盖同名键。先按 JSON 的实际成员逐层数键。
    Add-Type -AssemblyName System.Runtime.Serialization
    $reader=[Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader(
      [Text.Encoding]::UTF8.GetBytes($response.text),[Xml.XmlDictionaryReaderQuotas]::Max)
    try { $xml=New-Object Xml.XmlDocument; $xml.Load($reader) } finally { $reader.Dispose() }
    if ($xml.DocumentElement.ChildNodes.Count -ne 5) { throw 'keys' }
    $nodeElement=$xml.DocumentElement.SelectSingleNode('node')
    if (!$nodeElement -or ($nodeElement.GetAttribute('type') -ne 'null' -and $nodeElement.ChildNodes.Count -ne 6)) { throw 'keys' }
    $v=ConvertFrom-Json -InputObject $response.text
    Assert-CiReplyKeys $v @('status','contract','binding_id','connection_expires_at','node')
    $uuid='^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\z'
    if ($v.status -cne 'ok' -or $v.contract -cne 'clued.ci.connection-self/1' -or $v.binding_id -isnot [string] -or $v.binding_id -cnotmatch $uuid -or
        $v.connection_expires_at -isnot [string] -or $v.connection_expires_at -cnotmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)\z') { throw 'shape' }
    [void][DateTimeOffset]::Parse($v.connection_expires_at,[Globalization.CultureInfo]::InvariantCulture)
    $n=$v.node
    if ($null -ne $n) {
      Assert-CiReplyKeys $n @('node_id','name','identity_fingerprint','binding_generation','state','rebind_receipt_id')
      if ($n.node_id -isnot [string] -or $n.node_id -cnotmatch $uuid -or
          $n.name -isnot [string] -or !$n.name.Trim() -or $n.name.Length -gt 100 -or $n.name -match '[\x00-\x1f\x7f]' -or (Test-CiTokenInName $n.name $token) -or
          $n.identity_fingerprint -isnot [string] -or $n.identity_fingerprint -cnotmatch '^[0-9a-f]{64}\z' -or
          ($n.binding_generation -isnot [int] -and $n.binding_generation -isnot [long]) -or $n.binding_generation -lt 1 -or $n.binding_generation -gt 9007199254740991 -or
          $n.state -cnotin @('active','draining','pending') -or
          ($null -ne $n.rebind_receipt_id -and ($n.rebind_receipt_id -isnot [string] -or $n.rebind_receipt_id -cnotmatch $uuid))) { throw 'shape' }
    }
    $v
  } catch { throw 'CI_CONNECTION_SELF_UNAVAILABLE' }
}
function Get-CiHash([byte[]]$bytes) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}

function Write-CiStage([string]$file,[byte[]]$bytes,[string]$descriptor) {
  $sec=New-Object Security.AccessControl.FileSecurity
  $sec.SetSecurityDescriptorSddlForm($descriptor)
  # 崩溃可能留下不完整的临时文件。仅在本次服务端核验之后处理本工具的固定 .new 名称。
  try { $existing=Get-Item -LiteralPath $file -Force -ErrorAction Stop }
  catch [Management.Automation.ItemNotFoundException] { $existing=$null }
  if ($existing) {
    Assert-CiStageAcl $file $descriptor
    if ($existing.Length -eq $bytes.Length) {
      try { Assert-CiPlaced $file $bytes $descriptor; return }
      catch { if ($_.Exception.Message -cne 'CI_CONNECTION_READBACK_FAILED') { throw } }
    }
    [IO.File]::Delete($file)
  }
  $s=New-Object IO.FileStream($file,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,
    [IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,$sec)
  try { $s.Write($bytes,0,$bytes.Length); $s.Flush($true) } finally { $s.Dispose() }
  Assert-CiPlaced $file $bytes $descriptor
}
function Assert-CiStageAcl([string]$file,[string]$descriptor) {
  Assert-CiRegularPath $file
  $sec=New-Object Security.AccessControl.FileSecurity
  $sec.SetSecurityDescriptorSddlForm($descriptor)
  $acl=Get-Acl -LiteralPath $file
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sec.GetOwner([Security.Principal.SecurityIdentifier]) -or
      $acl.GetSecurityDescriptorSddlForm('Access') -cne $sec.GetSecurityDescriptorSddlForm('Access')) { throw 'CI_CONNECTION_ACL_READBACK_FAILED' }
}
function Assert-CiPlaced([string]$file,[byte[]]$bytes,[string]$descriptor) {
  Assert-CiStageAcl $file $descriptor
  $back=[IO.File]::ReadAllBytes($file)
  try { if ((Get-CiHash $back) -cne (Get-CiHash $bytes)) { throw 'CI_CONNECTION_READBACK_FAILED' } }
  finally { [Array]::Clear($back,0,$back.Length) }
}
function Move-CiStage([string]$source,[string]$target) {
  # 同目录单次 rename，文件描述符随临时文件移动。ReplaceFile 会合并旧 ACL。
  if (-not ('CiActivation.Move' -as [type])) {
    Add-Type -Namespace CiActivation -Name Move -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string src,string dst,int flags);'
  }
  if (![CiActivation.Move]::MoveFileEx($source,$target,9)) { throw 'CI_CONNECTION_ATOMIC_MOVE_FAILED' }
}
function Get-CiLocalInstall($residentRoot) {
  $receiptFile=Join-Path $residentRoot 'install\install-receipt.json'
  $installFile=Join-Path $residentRoot 'record\installation.json'
  $acceptedFile=Join-Path $residentRoot 'record\acceptance.json'
  foreach ($p in @($receiptFile,$installFile,$acceptedFile)) { Assert-CiRegularPath $p }
  $r=Read-ReviewedPublicJson $receiptFile (Sha256File $receiptFile)
  if ($r.contract -cnotin @('clued.independent-ci.resident-install-receipt/5','clued.independent-ci.resident-install-receipt/6')) { throw 'INSTALL_RECEIPT_REFUSED' }
  $config=Read-ReviewedPublicJson $installFile $r.installationSha256 4MB
  $accepted=Read-ReviewedPublicJson $acceptedFile $r.acceptanceSha256 4MB
  $verified=Test-NodeIdentityReceipt $r $config $accepted $r.acceptanceSha256
  if (!$verified.ok) { throw 'NODE_IDENTITY_CHANGED' }
  Assert-NodeProfile $accepted.node
  @{receipt=$r;config=$config;node=$accepted.node;identity=$verified.identity}
}
function Get-CiActivationResult($reply,$previous,$recordSha) {
  @{status='CI_CONNECTION_ACTIVATED';before=$previous;after=@{bindingId=$reply.binding_id;generation=$reply.node.binding_generation};
    nodeName=$reply.node.name;expiresAt=$reply.connection_expires_at;recordSha256=$recordSha;
    message=('已写入并读回。服务端确认：此令牌是连接 '+$reply.binding_id+'，已换绑到本节点（代次 '+$reply.node.binding_generation+'）。尚待 DESK 读回：换绑后的心跳已被接受、自检 PASS。')}
}
function Invoke-CiTokenReplace {
  param([string]$ResidentRoot='C:\ProgramData\CluedIndependentCI\resident',[switch]$Apply,[string]$ExpectedPlanSha256,[string]$TokenFile)
  $ciRoot=Split-Path -Parent $ResidentRoot
  $dir=Join-Path $ciRoot 'secrets'
  $tokenPath=Join-Path $dir 'ci-admission.token'
  $recordPath=Join-Path $dir 'ci-admission.connection.json'
  $pendingPath=$recordPath+'.pending'
  $local=Get-CiLocalInstall $ResidentRoot
  $node=$local.node; $receipt=$local.receipt; $sid=$node.controllerSid
  $sddl=Get-CiFileDescriptor $sid
  $plan=[ordered]@{contract='clued.ci.connection-self/1';recordContract='clued.independent-ci.ci-connection/1';nodeName=$node.nodeName
    installIdentity=$receipt.nodeIdentitySha256;tokenPath=$tokenPath;recordPath=$recordPath;fileSddl=$sddl
    notice='连接编号、代次、回执由服务端按令牌回答，应用时显示'}
  $planSha=Sha256Text ($plan | ConvertTo-Json -Compress)
  if (!$Apply) {
    try {
      $current=Get-EffectiveCiPrincipal $local.identity (Read-CiPrivateBytes $recordPath $sid -Optional)
      $display=@{bindingId=$current.bindingId;generation=$current.generation}
    } catch { $display='现连接：此窗口不可读，应用时核对' }
    return @{status='CI_CONNECTION_PLAN';plan=$plan;planSha256=$planSha;current=$display}
  }
  if (!(Get-CiHostAuthority $ResidentRoot $node)) { throw 'OWNER_ACCOUNT_REQUIRED' }
  if ($ExpectedPlanSha256 -cne $planSha) { throw 'PLAN_CHANGED_SINCE_REVIEW' }
  $mutex=New-Object Threading.Mutex($false,('Global\CluedCiTokenReplace-'+(Sha256Text $dir.ToUpperInvariant())))
  $locked=$false; $raw=$null; $token=$null; $actual=$null
  try {
    try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
    if (!$locked) { throw 'CI_CONNECTION_REPLACE_BUSY' }
    $oldBytes=Read-CiPrivateBytes $recordPath $sid -Optional
    $old=Get-EffectiveCiPrincipal $local.identity $oldBytes
    $actual=Read-CiPrivateBytes $tokenPath $sid
    $actualPin=Get-CiAdmissionTokenPin $actual
    $raw=Read-CiInput $TokenFile $ciRoot
    $pin=Get-CiAdmissionTokenPin $raw
    $first=0; $end=$raw.Length
    while ($first -lt $end -and $raw[$first] -in 9,10,11,12,13,32) { $first++ }
    while ($end -gt $first -and $raw[$end-1] -in 9,10,11,12,13,32) { $end-- }
    $token=New-Object byte[] ($end-$first)
    [Array]::Copy($raw,$first,$token,0,$token.Length)
    foreach ($name in @('upgradeToken','heartbeatToken')) {
      $lane=Get-Field $receipt $name
      if ($null -ne $lane -and $lane.placed) {
        if ($lane.fingerprint -cnotmatch '^[0-9a-f]{64}\z') { throw 'INSTALL_RECEIPT_REFUSED' }
        if ($lane.fingerprint -ceq $pin) { throw 'CI_CONNECTION_TOKEN_REUSED' }
      }
    }
    $pendingBytes=Read-CiPrivateBytes $pendingPath $sid -Optional
    $pending=$null
    if ($null -ne $pendingBytes) {
      $pending=([Text.Encoding]::UTF8.GetString($pendingBytes) | ConvertFrom-Json)
      if ($pending.planSha -cne $planSha -or $pending.tokenPin -cne $pin) { throw 'CI_CONNECTION_PENDING_OTHER_ACTIVATION' }
    }
    $oldHash=if ($null -ne $oldBytes) { Get-CiHash $oldBytes } else { $null }
    $installedRecord=$null -ne $pending -and $oldHash -ceq $pending.recordSha
    if ($actualPin -ceq $pin) {
      if (!$installedRecord) { throw 'CI_CONNECTION_TOKEN_REUSED' }
      if ($old.tokenPinSha256 -cne $pin -or $old.bindingId -cne $pending.answer.binding_id -or
          $old.generation -ne $pending.answer.node.binding_generation -or $old.receiptId -cne $pending.answer.node.rebind_receipt_id) {
        throw 'CI_CONNECTION_PENDING_CHANGED'
      }
      # 上次已提交两文件，只欠读回。此处只完成已经确认过的事务，不创建新记录。
      Assert-CiPlaced $recordPath $oldBytes $sddl
      Assert-CiPlaced $tokenPath $token $sddl
      [IO.File]::Delete($pendingPath)
      return Get-CiActivationResult $pending.answer $pending.before $oldHash
    }
    if (!$installedRecord -and ($old.tokenPinSha256 -ceq $pin -or $actualPin -cne $old.tokenPinSha256)) { throw 'CI_CONNECTION_CURRENT_TOKEN_REFUSED' }
    $reply=Get-CiSelf $local.config $token
    if ($null -eq $reply.node) { throw 'CI_CONNECTION_NOT_REBOUND' }
    if ((Get-LocalCiIdentityFingerprint) -cne $reply.node.identity_fingerprint) { throw 'CI_CONNECTION_OTHER_NODE' }
    if ($null -eq $reply.node.rebind_receipt_id) { throw 'CI_CONNECTION_NOT_REBOUND' }
    if ($null -ne (Get-Field $receipt 'heartbeatToken') -and $reply.binding_id -ceq $receipt.heartbeatToken.bindingId) { throw 'CI_CONNECTION_TOKEN_REUSED' }
    if (!$installedRecord -and $null -ne $old.generation -and $reply.node.binding_generation -le $old.generation) { throw 'CI_CONNECTION_GENERATION_NOT_NEWER' }
    if ($pending) {
      if ($pending.answer.binding_id -cne $reply.binding_id -or $pending.answer.node.binding_generation -ne $reply.node.binding_generation -or
          $pending.answer.node.rebind_receipt_id -cne $reply.node.rebind_receipt_id -or
          (!$installedRecord -and $oldHash -cne $pending.previousSha)) { throw 'CI_CONNECTION_PENDING_CHANGED' }
      $at=$pending.activatedAt; $previousSha=$pending.previousSha; $before=$pending.before
    } else {
      $at=[DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",[Globalization.CultureInfo]::InvariantCulture)
      $previousSha=$oldHash; $before=@{bindingId=$old.bindingId;generation=$old.generation}
    }
    $record=[ordered]@{activatedAt=$at;baseNodeIdentitySha256=$plan.installIdentity;bindingGeneration=$reply.node.binding_generation
      bindingId=$reply.binding_id;contract=$plan.recordContract;previousSha256=$previousSha;rebindReceiptId=$reply.node.rebind_receipt_id;tokenPinSha256=$pin}
    $bytes=[Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress))
    $null=Get-EffectiveCiPrincipal $local.identity $bytes
    $recordSha=Get-CiHash $bytes
    if ($pending -and $pending.recordSha -cne $recordSha) { throw 'CI_CONNECTION_PENDING_CHANGED' }
    if (!$pending) {
      $intent=@{planSha=$planSha;recordSha=$recordSha;previousSha=$previousSha;activatedAt=$at;answer=$reply;before=$before;tokenPin=$pin}
      $intentBytes=[Text.Encoding]::UTF8.GetBytes(($intent | ConvertTo-Json -Depth 6 -Compress))
      Write-CiStage ($pendingPath+'.new') $intentBytes $sddl
      Move-CiStage ($pendingPath+'.new') $pendingPath
    }
    foreach ($stage in @(@($recordPath,$bytes),@($tokenPath,$token))) {
      if ($installedRecord -and $stage[0] -ceq $recordPath) { continue }
      Write-CiStage ($stage[0]+'.new') $stage[1] $sddl
    }
    if (!$installedRecord) { Move-CiStage ($recordPath+'.new') $recordPath }
    Move-CiStage ($tokenPath+'.new') $tokenPath
    Assert-CiPlaced $recordPath $bytes $sddl
    Assert-CiPlaced $tokenPath $token $sddl
    [IO.File]::Delete($pendingPath)
    Get-CiActivationResult $reply $before $recordSha
  } finally {
    foreach ($b in @($raw,$token,$actual)) { if ($null -ne $b) { [Array]::Clear($b,0,$b.Length) } }
    if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose()
  }
}
if ($MyInvocation.InvocationName -eq '.') { return }
try {
  Invoke-CiTokenReplace -Apply:$Apply -ExpectedPlanSha256 $ExpectedPlanSha256 -TokenFile $TokenFile | ConvertTo-Json -Depth 6
} catch {
  $msg=$_.Exception.Message
  $code=if ($msg -cmatch '^[A-Z][A-Z0-9_]{2,80}\z') { $msg } else { 'CI_CONNECTION_ACTIVATION_FAILED' }
  [ordered]@{status='REFUSED';code=$code} | ConvertTo-Json -Compress
  exit 1
}
