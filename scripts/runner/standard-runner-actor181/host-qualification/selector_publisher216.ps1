# Private owned RELAY publication. JSON is correlation, never authority.
function InvokePublishSelector216($selector,$capturedInitial){
 E214Keys $selector @('schema','attempt_id','root_pid','root_start','root_sid','packet_sha256','owner_receipt_id','source_acceptance_ref')
 $b=$capturedInitial.binding;$owner=$capturedInitial.owner_packet;$t=SelfTarget ([Environment]::MachineName)
 E214Require ($null -ne $owner -and [object]::ReferenceEquals($capturedInitial,$script:OwnedEffects214.captured) -and (E214Same $selector.schema 'clued.node-ingress-selector212/1') -and (E214Same $capturedInitial.target_sid $t.sid)) 'PUBLISH_ACTUAL_PRIVATE_ROOT_CAPTURE'
 foreach($k in @('attempt_id','packet_sha256','owner_receipt_id')){E214Require (E214Same $selector.$k $b.$k) 'PUBLISH_CAPTURED_SUBJECT'}
 E214Require ((E214Same $selector.source_acceptance_ref $owner.source_acceptance_ref) -and $selector.root_pid -is [int] -and $selector.root_pid -eq $PID -and $selector.root_start -is [string] -and $selector.root_sid -is [string]) 'PUBLISH_SOURCE_AND_ACTUAL_PID'
 $held=[CluedQualification181.HeldProcess]::new($PID)
 try{$own=$held.Observe();E214Require ($own.Elevated -eq 1 -and $own.Sid -cne 'S-1-5-18' -and (E214Same $selector.root_start $own.CreationFileTime.ToString()) -and (E214Same $selector.root_sid $own.Sid)) 'PUBLISH_REAL_OWNED_ELEVATED_RELAY'}finally{$held.Dispose()}
 # Root's actual Host handler refreshed all three gates immediately before this
 # fixed command. Neither selector fields nor a local flag supply that gate.
 [byte[]]$raw=[Text.UTF8Encoding]::new($false).GetBytes(($selector|ConvertTo-Json -Compress));$v=[CluedSelectorPublisher216.Publisher]::Publish($raw,$t.sid)
 E214Require ($v.Status -is [string] -and $v.Status -ceq 'CREATED_PUBLIC_ROOT_LOCATOR_NOT_AUTHORITY' -and $v.Published -is [bool] -and $v.Published -and $v.DirectoryCreated -is [bool] -and $v.DirectoryCreated -and $v.FileCreated -is [bool] -and $v.FileCreated -and -not $v.ParentAclChanged -and -not $v.AutomaticRetry) 'PUBLISH_READBACK_UNKNOWN_PRESERVE_NO_RETRY'
 return [pscustomobject]@{status=$v.Status;path='C:\ProgramData\CluedIndependentCI\standard-runner-actor\root-node-selector212.json';payload_sha256=$v.PayloadSha256;directory_created=$v.DirectoryCreated;file_created=$v.FileCreated;parent_acl_changed=$v.ParentAclChanged;automatic_retry=$v.AutomaticRetry;execution_authority=$false}
}
if($MyInvocation.InvocationName -ne '.'){throw 'CAPTURED_ROOT_OWNED_SELECTOR_PUBLISHER_ONLY'}
