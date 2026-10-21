# Definitions only. Root must separately provide a newly reviewed and accepted formal binary, baseline and approval. No install, switch, Start or restore runs on dot-source.
function Wait-FixedStopped([int]$Seconds){$deadline=[DateTimeOffset]::UtcNow.AddSeconds($Seconds);do{$status=[CluedSession0ScmV2]::ReadStatus();if($status.State -eq 4 -and $status.Pid -gt 0 -and $null -eq $receipt.scm_helper_pid){$receipt.scm_helper_pid=$status.Pid;Save-Progress};if($status.State -eq 1){return $true};Start-Sleep -Milliseconds 100}while([DateTimeOffset]::UtcNow -lt $deadline);return $false}
function Restore-FixedOriginal($OriginalManifest){
 if(-not $receipt.binary_change_attempted){return}
 try{
  $script:stage='FINALLY_COMPARE_CURRENT_FIXED_CONFIG';if([CluedSession0ScmV2]::HasConflict){$receipt.configuration_conflict_detected=$true;throw 'STICKY_CONFIG_CONFLICT_RESTORE_WITHHELD'}
  $current=[CluedSession0ScmV2]::ReadSnapshot()
  if($current.Binary -ceq $HelperBinary){[CluedSession0ScmV2]::AssertExpected($current,$HelperBinary,$ExpectedStable,$false)
   if($current.Status.State -ne 1){if(-not $receipt.bounded_stop_attempted){$receipt.bounded_stop_attempted=$true;Save-Progress;[CluedSession0ScmV2]::StopOnlyFixedHelper($HelperBinary,$ExpectedStable)};if(-not (Wait-FixedStopped 15)){throw 'BOUNDED_STOP_UNCONFIRMED_RESTORE_WITHHELD'}}
   $script:stage='RESTORE_ONLY_ORIGINAL_BINARY';$receipt.binary_restore_attempted=$true;Save-Progress;[CluedSession0ScmV2]::SwitchOnlyBinary($HelperBinary,$OriginalBinary,$ExpectedStable)
  }elseif($current.Binary -cne $OriginalBinary){throw 'UNRELATED_BINARY_RESTORE_WITHHELD'}
  $script:stage='FINAL_ORIGINAL_FULL_STOPPED_READBACK';$final=Assert-CurrentOriginalHost $OriginalManifest
  if($final.StableDigest -cne $ExpectedStable){throw 'FINAL_ORIGINAL_STABLE_CONFIG_MISMATCH'};$receipt.original_binary_restored=$true;$receipt.complete_original_readback=$true
 }catch{$receipt.restore_failure_code=Safe-Code $_}
}
