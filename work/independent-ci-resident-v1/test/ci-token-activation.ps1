$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$f = [Console]::In.ReadToEnd() | ConvertFrom-Json
$scriptFile=Join-Path $PSScriptRoot '../windows/replace-ci-token.ps1'
. $scriptFile
# 只替换运行身份、安装目录的宿主权限和 HTTP 传输。正式入口使用相同的应用函数。
$testSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$testDir=Join-Path $f.root 'secrets'
$requests=New-Object Collections.ArrayList
function Get-CiHostAuthority($root,$node) { return $true }
function Get-CiFormalRoot { Join-Path $f.root 'fixture-formal-install' }
function Get-LocalCiIdentityFingerprint {
  if ($f.sampleIdentity) { return $f.sampleIdentity }
  Get-CiJwkFingerprint $f.publicJwk
}
$installedDescriptor=(Get-Command Get-CiFileDescriptor).ScriptBlock
function Get-CiFileDescriptor($sid) {
  $descriptor=& $installedDescriptor $sid
  # 实验进程没有指派 Administrators 所有者的权限。用当前 SID 代表该管理身份，其余生产 ACE 原样保留。
  $descriptor.Replace('O:BAG:BA',('O:'+$testSid)).Replace(';;;BA)',(';;;'+$testSid+')'))
}
function Get-SecretPathState($file,$sid) { if ($f.action -ceq 'plan') { return 'unreadable' }; 'ok' }
function Get-SecretFileState($file,$sid) { if ($f.action -ceq 'plan') { return 'unreadable' }; 'ok' }
function Invoke-CiHttp($uri,$key,$body) {
  if (Test-Path -LiteralPath $f.tokenFile) { throw 'TOKEN_FILE_STILL_PRESENT_AT_HTTP' }
  if ($uri -cne 'https://fixtureproject.supabase.co/rest/v1/rpc/clued_ci_connection_self_v1' -or $key -cne 'sb_publishable_fixture') { throw 'FIXTURE_ENDPOINT_CHANGED' }
  $snap=[ordered]@{}
  foreach($item in Get-ChildItem -LiteralPath $testDir -File) { $snap[$item.Name]=Sha256File $item.FullName }
  [void]$requests.Add(@{uri=$uri;body=($body|ConvertFrom-Json);snapshot=$snap})
  $text=if ($f.reply -is [string]) { $f.reply } else { ConvertTo-Json -InputObject $f.reply -Compress -Depth 6 }
  return @{ status=$f.status; text=$text }
}
$move=(Get-Command Move-CiStage).ScriptBlock
function Move-CiStage($source,$target) {
  if ($f.point -ceq 'staged' -and $target.EndsWith('.connection.json')) { throw 'FIXTURE_INTERRUPTED' }
  & $move $source $target
  if (($f.point -ceq 'record' -and $target.EndsWith('.connection.json')) -or
      ($f.point -ceq 'token' -and $target.EndsWith('.token'))) { throw 'FIXTURE_INTERRUPTED' }
}
$root=Join-Path $f.root 'resident'
try {
  if ($f.action -ceq 'installed-host') { [void][IO.Directory]::CreateDirectory((Get-CiFormalRoot)) }
  if ($f.action -ceq 'installed-file') {
    function Get-CiLocalInstall { throw 'FIXTURE_INSTALL_LOOKUP_REACHED' }
    Invoke-CiTokenReplace -Apply -TokenFile $f.tokenFile -ExpectedPlanSha256 ('0'*64)
    throw 'FIXTURE_INSTALL_ACCEPTED_FILE'
  }
  $plan=Invoke-CiTokenReplace -ResidentRoot $root
  if ($f.action -ceq 'fingerprint') {
    $key=[Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::ECDsaP256)
    try {
      $blob=$key.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
      $r=@{fingerprint=(Get-CiBlobFingerprint $blob);blob=[Convert]::ToBase64String($blob)}
    } finally { $key.Dispose() }
  } elseif ($f.action -ceq 'plan') {
    $ast=(Get-Command $scriptFile).ScriptBlock.Ast
    $r=@{parameters=@($ast.ParamBlock.Parameters.Name.VariablePath.UserPath);plan=$plan.plan;current=$plan.current}
  } else {
    $r=Invoke-CiTokenReplace -ResidentRoot $root -Apply -TokenFile $f.tokenFile -ExpectedPlanSha256 $plan.planSha256
    Add-Type -Path (Join-Path $PSScriptRoot 'CiActivationRestrictedReader.cs')
    $profile=(Get-Content (Join-Path $root 'record/acceptance.json') -Raw | ConvertFrom-Json).node
    foreach ($n in @('ci-admission.connection.json','ci-admission.token')) {
      if (![CiActivationFixture.RestrictedReader]::CanRead((Join-Path $testDir $n),$profile.controllerSid)) { throw 'CONTROL_READ_FIXTURE_FAILED' }
    }
    $r.companionCanRead=@(foreach ($n in @('ci-admission.connection.json','ci-admission.token')) {
      [CiActivationFixture.RestrictedReader]::CanRead((Join-Path $testDir $n),$profile.ownerSid)
    })
  }
} catch { $r=@{code=$_.Exception.Message;where=$_.InvocationInfo.ScriptLineNumber;trace=$_.ScriptStackTrace} }
$r.requests=@($requests)
[Console]::Out.Write(($r | ConvertTo-Json -Compress -Depth 8))
