$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
# 仅抽取自检的纯函数。自检脚本的顶层代码会访问安装目录。
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../windows/verify-resident.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'VERIFY_SCRIPT_PARSE_FAILED' }
$names = @('Get-EffectiveCiPrincipal','Get-NodeIdentity','ConvertTo-NodeIdentityCanonical','Sha256Text',
           'Test-CurrentCiConnection','Read-CiPrivateBytes','Get-CiAdmissionTokenPin')
foreach ($name in $names) {
  $fn = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name}, $true)
  if ($null -eq $fn) { throw "PARSER_FUNCTION_MISSING $name" }
  . ([scriptblock]::Create($fn.Extent.Text))
}
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.AssignmentStatementAst] -and
      $statement.Left.Extent.Text -cin @('$NodeIdentityRefs','$NodeIdentityKeys')) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$r = $inputData.record
$id = Get-NodeIdentity $r.installation $r.accepted $r.acceptancePin
if ($inputData.PSObject.Properties.Name -ccontains 'tokenFile') {
  # 只代替临时目录不具备的安装 ACL。真实自检函数自行读盘、算指纹、解析记录并报告。
  function Get-SecretPathState($file, $controllerSid) { return 'ok' }
  function Get-SecretFileState($file, $controllerSid) { return 'ok' }
  $result = Test-CurrentCiConnection $id $inputData.tokenFile $r.accepted.node.controllerSid
  [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 3))
  return
}
$results = @(foreach ($row in $inputData.cases) {
  $bytes = $null
  if ($null -ne $row.base64) { $bytes = [Convert]::FromBase64String($row.base64) }
  try {
    $answer = Get-EffectiveCiPrincipal $id $bytes
    [ordered]@{ bindingId = $answer.bindingId; tokenPinSha256 = $answer.tokenPinSha256; generation = $answer.generation }
  } catch { $_.Exception.Message }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $results -Compress -Depth 3))
