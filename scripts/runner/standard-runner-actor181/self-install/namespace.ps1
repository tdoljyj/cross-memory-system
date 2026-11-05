# Captured helper binding only; never export functions into the Host/global
# namespace. Fail before an effect if any exact captured dependency is absent.
function InstallBindPrivateCallback212([scriptblock]$callback,[string[]]$names){
 if($null -eq $callback -or $null -eq $callback.Module -or $null -eq $names -or $names.Count -gt 40){throw 'INSTALL_PRIVATE_CALLBACK_MODULE_REQUIRED'}
 $captured=@{}
 foreach($name in $names){
  if($name -cnotmatch '\A[A-Za-z][A-Za-z0-9_]{0,100}\z' -or $captured.ContainsKey($name)){throw 'INSTALL_PRIVATE_HELPER_NAME'}
  $item=Get-Item -LiteralPath ('Function:\'+$name) -ErrorAction Stop
  if($item.ScriptBlock -isnot [scriptblock]){throw 'INSTALL_PRIVATE_CAPTURED_HELPER_REQUIRED'}
  $captured[$name]=$item.ScriptBlock
 }
 & $callback.Module {param($items)foreach($name in $items.Keys){Set-Item -Path ('Function:script:'+$name) -Value $items[$name]};Export-ModuleMember -Function @()} $captured
 return $callback
}
