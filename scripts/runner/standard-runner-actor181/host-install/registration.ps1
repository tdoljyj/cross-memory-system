# Function library only; load after unchanged windows_task_definition181.ps1.
# Normal SID/name metadata lookup only, no token/password read or registration.
function ResolveRegistrationAccountName([string]$expectedSid){
  $sid=[Security.Principal.SecurityIdentifier]::new($expectedSid)
  $name=$sid.Translate([Security.Principal.NTAccount]).Value
  TaskDefinitionRequire ((ResolveTaskPrincipalSid $name) -ceq $sid.Value) 'REGISTRATION_ACCOUNT_SID_ROUNDTRIP_MISMATCH'
  return $name
}
function InvokeRegistrationRepresentationPreflight {
  $metadata=InvokeExactTaskDefinitionPreflight
  $name=ResolveRegistrationAccountName $metadata.expected_sid
  $metadata.registration_account_name=$name
  $metadata.registration_account_sid_roundtrip=((ResolveTaskPrincipalSid $name) -ceq $metadata.expected_sid)
  $metadata.registration_representation_only_not_prior_failure_cause=$true
  return $metadata
}
