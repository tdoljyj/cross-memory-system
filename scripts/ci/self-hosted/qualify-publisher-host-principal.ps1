#requires -Version 5.1
<#
Observe the existing company Windows CI principal. Inventory is read-only.
S4UCanary creates only its own finite, no-secret task and qualification folder.
Neither mode imports a distro, changes CI, grants access, nor qualifies production.
#>
[CmdletBinding()]
param(
    [ValidateSet('Inventory', 'S4UCanary')]
    [string]$Mode = 'Inventory',
    [guid]$QualificationId = [guid]::Empty,
    [guid]$IsolationCanaryId = [guid]::Empty,
    [guid]$ExpectedQualificationVm = [guid]::Empty,
    # Internal fixed protocol for bounded child processes, never arbitrary commands.
    [Parameter(DontShow = $true)]
    [ValidateSet('', 'Scheduler', 'Callback', 'Cleanup', 'VmRead')]
    [string]$InternalPhase = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:ExpectedSid = 'S-1-5-21-858977881-4031698862-3006450925-1005'
$script:ExpectedHost = 'DESK-W-591'
$script:QualificationRoot = 'C:\Users\clued-runner\AppData\Local\CluedPublisherQualification'
$script:WslPath = 'C:\Program Files\WSL\wsl.exe'
$script:ExpectedWslVersion = '2.7.13.0'
$script:TaskPrefix = 'Clued-Publisher-Principal-Canary-'
$script:SchemaPrefix = 'clued.publisher-host-principal'
$script:SourcePath = $PSCommandPath
$script:Budget = [Diagnostics.Stopwatch]::StartNew()

function Initialize-ProbeModules {
    if ($env:OS -cne 'Windows_NT' -or $PSVersionTable.PSEdition -cne 'Desktop' -or
        $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or
        -not [Environment]::Is64BitProcess) { throw 'SYSTEM_WINDOWS_POWERSHELL_51_REQUIRED' }
    $systemPs = [IO.Path]::Combine([Environment]::GetFolderPath('System'), 'WindowsPowerShell\v1.0')
    if ([IO.Path]::GetFullPath($PSHOME) -ine $systemPs) { throw 'SYSTEM_WINDOWS_POWERSHELL_51_REQUIRED' }
    $script:PowerShellPath = [IO.Path]::Combine($systemPs, 'powershell.exe')
    $manifest = [IO.Path]::Combine($systemPs, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
    foreach ($loaded in @(Get-Module -Name Microsoft.PowerShell.Utility)) {
        if ([IO.Path]::GetFullPath($loaded.Path) -ine $manifest) { throw 'INCOMPATIBLE_LOADED_UTILITY_MODULE' }
    }
    Import-Module -Name $manifest -Scope Global -ErrorAction Stop
    $script:PSModuleAutoloadingPreference = 'None'
}
function Write-ProbeResult($Value) { $Value | ConvertTo-Json -Depth 14 -Compress }
function Get-ErrorEvidence($ErrorRecord) {
    $ex = $ErrorRecord.Exception
    return [ordered]@{ type = $ex.GetType().FullName; hresult = $ex.HResult; error_id = $ErrorRecord.FullyQualifiedErrorId }
}
function Get-ProbeIdentity {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $groups = @($identity.Groups | ForEach-Object { $_.Value })
    return [ordered]@{
        host = [Environment]::MachineName; account = $identity.Name; sid = $identity.User.Value
        session_id = [Diagnostics.Process]::GetCurrentProcess().SessionId
        administrator_token_member = ($groups -contains 'S-1-5-32-544' -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
        hyper_v_token_member = ($groups -contains 'S-1-5-32-578')
    }
}
function Assert-ProbeIdentity($Identity) {
    if ($Identity.host -cne $script:ExpectedHost) { throw 'WRONG_HOST' }
    if ($Identity.sid -cne $script:ExpectedSid) { throw 'WRONG_WINDOWS_PRINCIPAL' }
    if ($Identity.administrator_token_member -or $Identity.hyper_v_token_member) { throw 'PRIVILEGED_CI_TOKEN_REFUSED' }
    if ($Identity.session_id -ne 0) { throw 'ACTUAL_CI_SESSION_ZERO_REQUIRED' }
}
function Get-ProbeGitHubContext {
    # These values are observations supplied by the reviewed workflow/runtime.
    # They do not authenticate a workflow or replace its external admission.
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'tdoljyj/cross-memory-system' -or
        $env:RUNNER_NAME -cne 'clued-ci-company-win-01' -or $env:RUNNER_OS -cne 'Windows' -or
        $env:RUNNER_ARCH -cne 'X64' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or
        $env:GITHUB_REF -cne 'refs/heads/main' -or $env:GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]{0,19}$' -or
        $env:GITHUB_RUN_ATTEMPT -cnotmatch '^[1-9][0-9]{0,5}$' -or
        $env:GITHUB_JOB -cnotmatch '^[A-Za-z_][A-Za-z0-9_-]{0,99}$' -or
        $env:GITHUB_SHA -cnotmatch '^[0-9a-fA-F]{40}$' -or
        $env:GITHUB_WORKFLOW_REF -cnotmatch '^tdoljyj/cross-memory-system/\.github/workflows/[a-z0-9][a-z0-9-]{0,79}\.ya?ml@refs/heads/main$') {
        throw 'FIXED_COMPANY_WORKFLOW_CONTEXT_REQUIRED'
    }
    return [ordered]@{
        repository = $env:GITHUB_REPOSITORY; run_id = $env:GITHUB_RUN_ID; run_attempt = $env:GITHUB_RUN_ATTEMPT
        job_key = $env:GITHUB_JOB; provider_job_id = 'UNKNOWN'; sha = $env:GITHUB_SHA.ToLowerInvariant()
        workflow_ref = $env:GITHUB_WORKFLOW_REF; runner_name = $env:RUNNER_NAME
        provenance = 'workflow_environment_observation; not cryptographic admission'
    }
}
function Get-ProbeSha256([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::Open($Path, 'Open', 'Read', 'Read')
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Invoke-FixedProcess([string]$Executable, [string]$Arguments, [int]$TimeoutMilliseconds = 8000, [switch]$UnicodeOutput) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable; $start.Arguments = $Arguments
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    if ($UnicodeOutput) { $start.StandardOutputEncoding = [Text.Encoding]::Unicode; $start.StandardErrorEncoding = [Text.Encoding]::Unicode }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { return [ordered]@{ result = 'UNKNOWN'; reason = 'PROCESS_NOT_STARTED' } }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            # Kill only this exact child, not a distro, service or other CI job.
            try { $process.Kill() } catch {}
            return [ordered]@{ result = 'UNKNOWN'; reason = 'FIXED_PROCESS_TIMEOUT' }
        }
        $out = $stdout.GetAwaiter().GetResult(); $err = $stderr.GetAwaiter().GetResult()
        if ($out.Length + $err.Length -gt 16384) {
            return [ordered]@{ result = 'UNKNOWN'; reason = 'FIXED_PROCESS_OUTPUT_LIMIT'; exit_code = $process.ExitCode }
        }
        return [ordered]@{ result = 'OBSERVED'; exit_code = $process.ExitCode; stdout = $out; stderr = $err }
    } catch { return [ordered]@{ result = 'UNKNOWN'; reason = 'FIXED_PROCESS_FAILED'; error = (Get-ErrorEvidence $_) } }
    finally { $process.Dispose() }
}
function Get-WslVersionEvidence {
    if (-not [IO.File]::Exists($script:WslPath)) { return [ordered]@{ result = 'UNKNOWN'; reason = 'PINNED_WSL_EXE_MISSING' } }
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($script:WslPath).FileVersion
    if ($version -cne $script:ExpectedWslVersion) {
        return [ordered]@{ result = 'UNKNOWN'; reason = 'WSL_VERSION_CHANGED'; file_version = $version }
    }
    $run = Invoke-FixedProcess $script:WslPath '--version' -TimeoutMilliseconds 8000 -UnicodeOutput
    return [ordered]@{ executable = $script:WslPath; file_version = $version; invocation = $run
        result = $(if ($run.result -eq 'OBSERVED' -and $run.exit_code -eq 0 -and $run.stdout.Contains($script:ExpectedWslVersion)) { 'OBSERVED' } else { 'UNKNOWN' }) }
}
function Get-OwnWslRegistrations {
    $key = $null
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Lxss', $false)
        if ($null -eq $key) { return [ordered]@{ result = 'OBSERVED'; registration_state = 'NO_REGISTRATION_VISIBLE'; distributions = @() } }
        $names = @($key.GetSubKeyNames())
        if ($names.Count -gt 32) { return [ordered]@{ result = 'UNKNOWN'; reason = 'OWN_REGISTRATION_LIMIT' } }
        $rows = @(foreach ($name in $names) {
            $id = [guid]::Empty
            if (-not [guid]::TryParse($name, [ref]$id)) { throw 'UNEXPECTED_OWN_REGISTRATION_KEY' }
            $child = $key.OpenSubKey($name, $false)
            try { [ordered]@{ id = $id.ToString('D'); name = $child.GetValue('DistributionName'); base_path = $child.GetValue('BasePath'); version = $child.GetValue('Version') } }
            finally { if ($null -ne $child) { $child.Dispose() } }
        })
        return [ordered]@{ result = 'OBSERVED'; registration_state = 'OWN_USER_ONLY'; distributions = $rows }
    } catch { return [ordered]@{ result = 'UNKNOWN'; reason = 'OWN_REGISTRATION_UNAVAILABLE'; error = (Get-ErrorEvidence $_) } }
    finally { if ($null -ne $key) { $key.Dispose() } }
}
function Get-PublicCanaryReadEvidence([guid]$Id) {
    if ($Id -eq [guid]::Empty) { return [ordered]@{ result = 'NOT_REQUESTED' } }
    $path = 'D:\CluedProductionPublisher\isolation-canaries\' + $Id.ToString('D') + '\public-canary.json'
    $stream = $null
    try {
        # Opening for read is already an exposure failure. Never read any bytes.
        $stream = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
        return [ordered]@{ result = 'FAIL'; reason = 'PUBLISHER_CANARY_READABLE'; canary_id = $Id.ToString('D'); bytes_read = 0 }
    } catch [UnauthorizedAccessException] {
        return [ordered]@{ result = 'PASS'; reason = 'EXPLICIT_ACCESS_DENIED'; canary_id = $Id.ToString('D')
            trusted_host_existence_proof = 'REQUIRED_SEPARATELY'; production_qualified = $false }
    } catch { return [ordered]@{ result = 'UNKNOWN'; reason = 'CANARY_READ_NOT_PROVEN_DENIED'; canary_id = $Id.ToString('D'); error = (Get-ErrorEvidence $_) } }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}
function Get-ExactVmReadEvidence([guid]$Id) {
    if ($Id -eq [guid]::Empty) { return [ordered]@{ result = 'NOT_REQUESTED' } }
    $manifest = [IO.Path]::Combine($PSHOME, 'Modules\Hyper-V\2.0.0.0\Hyper-V.psd1')
    $queryStarted = $false
    try {
        if (-not [IO.File]::Exists($manifest)) { return [ordered]@{ result = 'UNKNOWN'; reason = 'HYPER_V_MODULE_MISSING'; vm_id = $Id.ToString('D'); production_qualified = $false } }
        Import-Module -Name $manifest -Scope Local -ErrorAction Stop
        $queryStarted = $true
        $vm = @(Hyper-V\Get-VM -Id $Id -ErrorAction Stop)
        if ($vm.Count -eq 1 -and $vm[0].Id -eq $Id) { return [ordered]@{ result = 'FAIL'; reason = 'EXACT_VM_READABLE'; vm_id = $Id.ToString('D'); production_qualified = $false } }
        return [ordered]@{ result = 'UNKNOWN'; reason = 'VM_QUERY_NOT_UNIQUE'; vm_id = $Id.ToString('D'); production_qualified = $false }
    } catch {
        # AccessDenied category / native E_ACCESSDENIED is specific; missing VM,
        # missing namespace/module and unrelated provider errors remain UNKNOWN.
        $errorRecord = $_
        if (-not $queryStarted) {
            return [ordered]@{ result = 'UNKNOWN'; reason = 'HYPER_V_MODULE_UNAVAILABLE'; vm_id = $Id.ToString('D'); production_qualified = $false; error = (Get-ErrorEvidence $errorRecord) }
        }
        $nativeDenied = $false; $ex = $errorRecord.Exception
        while ($null -ne $ex) {
            if ($ex -is [UnauthorizedAccessException] -or $ex.HResult -eq -2147024891) { $nativeDenied = $true }
            $ex = $ex.InnerException
        }
        if ($nativeDenied -or $errorRecord.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::PermissionDenied) {
            return [ordered]@{ result = 'PASS'; reason = 'EXPLICIT_VM_QUERY_ACCESS_DENIED'; vm_id = $Id.ToString('D')
                management_mutation_denial = 'NOT_TESTED'; trusted_host_existence_proof = 'REQUIRED_SEPARATELY'; production_qualified = $false }
        }
        return [ordered]@{ result = 'UNKNOWN'; reason = 'VM_READ_NOT_PROVEN_DENIED'; vm_id = $Id.ToString('D'); production_qualified = $false; error = (Get-ErrorEvidence $errorRecord) }
    }
}
function Get-BoundedExactVmReadEvidence([guid]$Id, [guid]$ProbeId) {
    if ($Id -eq [guid]::Empty) { return [ordered]@{ result = 'NOT_REQUESTED' } }
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script:SourcePath +
        '" -Mode Inventory -QualificationId ' + $ProbeId.ToString('D') +
        ' -ExpectedQualificationVm ' + $Id.ToString('D') + ' -InternalPhase VmRead'
    $child = Invoke-FixedProcess $script:PowerShellPath $arguments 6000
    try {
        if ($child.result -ne 'OBSERVED' -or $child.exit_code -ne 0) { throw 'VM_READ_HELPER_UNAVAILABLE' }
        $value = $child.stdout | ConvertFrom-Json
        foreach ($name in @('result', 'vm_id', 'reason', 'production_qualified')) {
            if ($null -eq $value -or $null -eq $value.PSObject.Properties[$name]) { throw 'VM_READ_HELPER_BINDING_MISSING' }
        }
        if ($value.result -cnotin @('PASS', 'FAIL', 'UNKNOWN') -or $value.vm_id -cne $Id.ToString('D') -or
            $value.production_qualified -isnot [bool] -or $value.production_qualified -ne $false) { throw 'VM_READ_HELPER_BINDING_MISMATCH' }
        if ($value.result -ceq 'PASS' -and
            ($value.reason -cne 'EXPLICIT_VM_QUERY_ACCESS_DENIED' -or
             $null -eq $value.PSObject.Properties['management_mutation_denial'] -or
             $value.management_mutation_denial -cne 'NOT_TESTED')) { throw 'VM_READ_HELPER_DENIAL_NOT_PROVEN' }
        if ($value.result -ceq 'FAIL' -and $value.reason -cne 'EXACT_VM_READABLE') { throw 'VM_READ_HELPER_FAILURE_NOT_BOUND' }
        return $value
    } catch { return [ordered]@{ result = 'UNKNOWN'; reason = 'VM_READ_HELPER_UNAVAILABLE_OR_UNBOUND'
        vm_id = $Id.ToString('D'); production_qualified = $false } }
}
function Get-QualificationFolder([guid]$Id, [switch]$MustExist) {
    if ($Id -eq [guid]::Empty) { throw 'QUALIFICATION_GUID_REQUIRED' }
    $folder = [IO.Path]::Combine($script:QualificationRoot, $Id.ToString('D'))
    Assert-QualificationPath $folder -MustExist:$MustExist
    return $folder
}
function Assert-QualificationPath([string]$Path, [switch]$MustExist) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -ine $script:QualificationRoot -and -not $full.StartsWith($script:QualificationRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'QUALIFICATION_PATH_ESCAPE'
    }
    if ($full.IndexOf(':', 2) -ge 0) { throw 'QUALIFICATION_ADS_FORBIDDEN' }
    # Local fixed ancestors only; reject links before all directory/file effects.
    $cursor = $full
    while ($cursor.Length -gt 3) {
        try {
            $attributes = [IO.File]::GetAttributes($cursor)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'QUALIFICATION_REPARSE_FORBIDDEN' }
        } catch [IO.FileNotFoundException] {} catch [IO.DirectoryNotFoundException] {}
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    if ($MustExist -and -not [IO.Directory]::Exists($full) -and -not [IO.File]::Exists($full)) { throw 'QUALIFICATION_PATH_MISSING' }
}
function Write-NewQualificationJson([string]$Folder, [ValidateSet('request.json', 'registration-intent.json', 'callback.json', 'scheduler.json', 'cleanup.json', 'result.json')][string]$Name, $Value) {
    $path = [IO.Path]::Combine($Folder, $Name)
    Assert-QualificationPath $path
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Value | ConvertTo-Json -Depth 14))
    $stream = [IO.File]::Open($path, 'CreateNew', 'Write', 'None')
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
}
function Read-QualificationJson([string]$Folder, [ValidateSet('request.json', 'registration-intent.json', 'callback.json', 'scheduler.json', 'cleanup.json')][string]$Name) {
    $path = [IO.Path]::Combine($Folder, $Name)
    Assert-QualificationPath $path -MustExist
    if ((New-Object IO.FileInfo($path)).Length -gt 32768) { throw 'QUALIFICATION_JSON_TOO_LARGE' }
    return ([IO.File]::ReadAllText($path) | ConvertFrom-Json)
}
function Read-QualificationRequest([guid]$Id) {
    $folder = Get-QualificationFolder $Id -MustExist
    $request = Read-QualificationJson $folder 'request.json'
    if ($request.schema -cne ($script:SchemaPrefix + '.request/1') -or $request.qualification_id -cne $Id.ToString('D') -or
        $request.expected_sid -cne $script:ExpectedSid -or $request.production_qualified -ne $false -or
        $request.source_sha256 -cne (Get-ProbeSha256 $script:SourcePath)) { throw 'QUALIFICATION_REQUEST_MISMATCH' }
    $age = [DateTime]::UtcNow - [DateTime]::Parse($request.created_utc).ToUniversalTime()
    if ($age.TotalSeconds -lt -5 -or $age.TotalMinutes -gt 10) { throw 'QUALIFICATION_REQUEST_EXPIRED' }
    return $request
}
function Assert-PhaseReport($Value, [string]$Phase, [guid]$Id, [string]$SourceHash, $GitHub, $Identity) {
    foreach ($name in @('schema', 'qualification_id', 'result', 'production_qualified', 'source_sha256', 'github', 'identity')) {
        if ($null -eq $Value -or $null -eq $Value.PSObject.Properties[$name]) { throw 'PHASE_REPORT_FIELD_MISSING' }
    }
    if ($Value.schema -cne ($script:SchemaPrefix + '.' + $Phase + '/1') -or
        $Value.qualification_id -cne $Id.ToString('D') -or $SourceHash -cnotmatch '^[0-9a-f]{64}$' -or
        $Value.source_sha256 -cne $SourceHash -or $Value.production_qualified -isnot [bool] -or
        $Value.production_qualified -ne $false) { throw 'PHASE_REPORT_BINDING_MISMATCH' }
    foreach ($name in @('repository', 'run_id', 'run_attempt', 'job_key', 'provider_job_id', 'sha', 'workflow_ref', 'runner_name', 'provenance')) {
        if ($null -eq $Value.github -or $null -eq $Value.github.PSObject.Properties[$name] -or
            [string]::IsNullOrEmpty($GitHub[$name]) -or $Value.github.$name -cne $GitHub[$name]) { throw 'PHASE_GITHUB_BINDING_MISMATCH' }
    }
    foreach ($name in @('host', 'account', 'sid', 'session_id', 'administrator_token_member', 'hyper_v_token_member')) {
        if ($null -eq $Value.identity -or $null -eq $Value.identity.PSObject.Properties[$name] -or
            $Value.identity.$name -cne $Identity[$name]) { throw 'PHASE_IDENTITY_BINDING_MISMATCH' }
    }
    if ($Value.identity.session_id -isnot [int] -or $Value.identity.administrator_token_member -isnot [bool] -or
        $Value.identity.hyper_v_token_member -isnot [bool]) { throw 'PHASE_IDENTITY_TYPES_INVALID' }
    Assert-ProbeIdentity $Value.identity
    if ($Phase -eq 'callback' -and $Value.result -eq 'OBSERVED') {
        if ($null -eq $Value.PSObject.Properties['wsl_version'] -or $null -eq $Value.wsl_version) { throw 'CALLBACK_WSL_EVIDENCE_MISSING' }
        $version = $Value.wsl_version
        foreach ($name in @('result', 'executable', 'file_version', 'invocation')) {
            if ($null -eq $version.PSObject.Properties[$name]) { throw 'CALLBACK_WSL_EVIDENCE_MISSING' }
        }
        if ($version.result -cne 'OBSERVED' -or $version.executable -cne $script:WslPath -or
            $version.file_version -cne $script:ExpectedWslVersion -or $null -eq $version.invocation) { throw 'CALLBACK_WSL_NOT_OBSERVED' }
        foreach ($name in @('result', 'exit_code', 'stdout', 'stderr')) {
            if ($null -eq $version.invocation.PSObject.Properties[$name]) { throw 'CALLBACK_WSL_INVOCATION_MISSING' }
        }
        if ($version.invocation.result -cne 'OBSERVED' -or $version.invocation.exit_code -isnot [int] -or
            $version.invocation.exit_code -ne 0 -or $version.invocation.stdout -isnot [string] -or
            -not $version.invocation.stdout.Contains($script:ExpectedWslVersion)) { throw 'CALLBACK_WSL_INVOCATION_NOT_OBSERVED' }
    }
    if ($Phase -eq 'scheduler' -and $Value.result -eq 'OBSERVED') {
        foreach ($name in @('task_was_absent_before_registration', 'task_registered', 'task_ownership_verified', 'task_run_requested')) {
            if ($null -eq $Value.PSObject.Properties[$name] -or $Value.$name -isnot [bool] -or $Value.$name -ne $true) {
                throw 'SCHEDULER_FACT_NOT_PROVEN'
            }
        }
        if ($null -eq $Value.PSObject.Properties['last_task_result'] -or
            ($Value.last_task_result -isnot [int] -and $Value.last_task_result -isnot [long]) -or
            $Value.last_task_result -ne 0) { throw 'SCHEDULER_RESULT_NOT_SUCCESSFUL' }
        $instance = [guid]::Empty
        if ($null -eq $Value.PSObject.Properties['instance_guid'] -or
            -not [guid]::TryParse($Value.instance_guid, [ref]$instance) -or $instance -eq [guid]::Empty) { throw 'SCHEDULER_INSTANCE_NOT_PROVEN' }
    }
    if ($Phase -eq 'cleanup' -and $Value.result -eq 'ABSENT_CONFIRMED') {
        foreach ($name in @('registration_intent_verified', 'task_was_present', 'task_ownership_verified', 'deleted_own_task', 'task_absent_confirmed')) {
            if ($null -eq $Value.PSObject.Properties[$name] -or $Value.$name -isnot [bool] -or $Value.$name -ne $true) {
                throw 'CLEANUP_FACT_NOT_PROVEN'
            }
        }
    }
}
function Get-CanaryTaskDescription([guid]$Id, [string]$SourceHash) {
    return ('clued.publisher-host-principal.s4u/1; id=' + $Id.ToString('D') + '; source=' + $SourceHash + '; no secrets; no production')
}
function Get-CanaryTaskArguments([guid]$Id, [string]$Folder) {
    return ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + [IO.Path]::Combine($Folder, 'probe.ps1') +
        '" -Mode Inventory -QualificationId ' + $Id.ToString('D') + ' -InternalPhase Callback')
}
function Get-SchedulerTaskOrMissing($RootFolder, [string]$Name) {
    try { return $RootFolder.GetTask($Name) }
    catch {
        $ex = $_.Exception
        while ($null -ne $ex) {
            if ($ex.HResult -eq -2147024894) { return $null }
            $ex = $ex.InnerException
        }
        throw
    }
}
function Assert-OwnedCanaryTask($Task, [guid]$Id, [string]$Folder, [string]$SourceHash) {
    $definition = $Task.Definition
    if ($definition.Principal.UserId -match '^S-1-') { $sid = $definition.Principal.UserId }
    else { $sid = (New-Object Security.Principal.NTAccount($definition.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value }
    $owner = (New-Object Security.AccessControl.RawSecurityDescriptor($Task.GetSecurityDescriptor(1))).Owner.Value
    if ($Task.Name -cne ($script:TaskPrefix + $Id.ToString('N')) -or $sid -cne $script:ExpectedSid -or $owner -cne $script:ExpectedSid -or
        $definition.Principal.LogonType -ne 2 -or $definition.Principal.RunLevel -ne 0 -or
        $definition.RegistrationInfo.Description -cne (Get-CanaryTaskDescription $Id $SourceHash) -or
        $definition.Actions.Count -ne 1 -or $definition.Triggers.Count -ne 0 -or
        $definition.Actions.Item(1).Path -ine $script:PowerShellPath -or
        $definition.Actions.Item(1).Arguments -cne (Get-CanaryTaskArguments $Id $Folder) -or
        $definition.Actions.Item(1).WorkingDirectory -ine $Folder -or $definition.Settings.ExecutionTimeLimit -cne 'PT45S') {
        throw 'CANARY_TASK_OWNERSHIP_MISMATCH'
    }
}
function Invoke-SchedulerPhase([guid]$Id, [string]$Folder, $Request) {
    $outcome = [ordered]@{ schema = ($script:SchemaPrefix + '.scheduler/1'); qualification_id = $Id.ToString('D')
        result = 'UNKNOWN'; task_was_absent_before_registration = $false; task_registered = $false
        task_ownership_verified = $false; task_run_requested = $false; production_qualified = $false
        source_sha256 = $Request.source_sha256; github = $Request.github; identity = (Get-ProbeIdentity)
        requested_execution_time_limit = 'PT45S'; execution_time_limit_enforced_for_demand_start = $false
        callback_wsl_process_timeout_ms = 8000; parent_scheduler_process_timeout_ms = 35000; cleanup_process_timeout_ms = 8000 }
    try {
        $service = New-Object -ComObject 'Schedule.Service'; $service.Connect()
        $root = $service.GetFolder('\'); $name = $script:TaskPrefix + $Id.ToString('N')
        if ($null -ne (Get-SchedulerTaskOrMissing $root $name)) { throw 'CANARY_TASK_ALREADY_EXISTS' }
        $outcome.task_was_absent_before_registration = $true
        $definition = $service.NewTask(0)
        $definition.RegistrationInfo.Description = Get-CanaryTaskDescription $Id $Request.source_sha256
        $definition.Principal.UserId = $script:ExpectedSid; $definition.Principal.LogonType = 2; $definition.Principal.RunLevel = 0
        $definition.Settings.Enabled = $true; $definition.Settings.AllowDemandStart = $true
        $definition.Settings.ExecutionTimeLimit = 'PT45S'; $definition.Settings.MultipleInstances = 2
        $definition.Settings.DisallowStartIfOnBatteries = $false; $definition.Settings.StopIfGoingOnBatteries = $false
        $action = $definition.Actions.Create(0); $action.Path = $script:PowerShellPath
        $action.Arguments = Get-CanaryTaskArguments $Id $Folder; $action.WorkingDirectory = $Folder
        # Persist intent only after the exact task was observed absent, before
        # TASK_CREATE. Cleanup without this exact intent never touches a task.
        Write-NewQualificationJson $Folder 'registration-intent.json' ([ordered]@{
            schema = ($script:SchemaPrefix + '.registration-intent/1')
            qualification_id = $Id.ToString('D'); task_name = $name
            source_sha256 = $Request.source_sha256; task_was_absent = $true
            created_utc = [DateTime]::UtcNow.ToString('o'); production_qualified = $false
        })
        # TASK_CREATE (2), never UPDATE or CREATE_OR_UPDATE. No password supplied.
        $task = $root.RegisterTaskDefinition($name, $definition, 2, $script:ExpectedSid, $null, 2, $null)
        $outcome.task_registered = $true
        Assert-OwnedCanaryTask $task $Id $Folder $Request.source_sha256
        $outcome.task_ownership_verified = $true
        # Demand-start bypasses Task Scheduler's ExecutionTimeLimit. PT45S is
        # only a requested setting/identity check, never a hard task deadline.
        # Normal containment is the callback's fixed process timeout and the
        # parent's bounded exact-task Stop/Delete. Parent loss needs inspection.
        $instance = $task.Run($null); $outcome.task_run_requested = $true
        $outcome.instance_guid = [string]$instance.InstanceGuid
        while ($script:Budget.Elapsed.TotalSeconds -lt 30) {
            $task = Get-SchedulerTaskOrMissing $root $name
            if ($null -eq $task) { throw 'CANARY_TASK_DISAPPEARED' }
            Assert-OwnedCanaryTask $task $Id $Folder $Request.source_sha256
            $callbackPath = [IO.Path]::Combine($Folder, 'callback.json')
            if ([IO.File]::Exists($callbackPath) -and [int]$task.State -ne 4 -and [int]$task.State -ne 2) {
                $outcome.last_task_result = [long]$task.LastTaskResult
                $outcome.result = $(if ($outcome.last_task_result -eq 0) { 'OBSERVED' } else { 'FAIL' })
                break
            }
            Start-Sleep -Milliseconds 200
        }
        if ($outcome.result -eq 'UNKNOWN') {
            $outcome.reason = 'CANARY_TASK_DID_NOT_COMPLETE_IN_WINDOW'
            $outcome.last_task_result = [long]$task.LastTaskResult
        }
    } catch { $outcome.reason = 'SCHEDULER_CREATE_OR_RUN_UNAVAILABLE'; $outcome.error = Get-ErrorEvidence $_ }
    Write-NewQualificationJson $Folder 'scheduler.json' $outcome
}
function Invoke-CleanupPhase([guid]$Id, [string]$Folder, $Request) {
    $outcome = [ordered]@{ schema = ($script:SchemaPrefix + '.cleanup/1'); qualification_id = $Id.ToString('D')
        result = 'UNKNOWN'; registration_intent_verified = $false; task_was_present = $false
        task_ownership_verified = $false; deleted_own_task = $false; task_absent_confirmed = $false
        source_sha256 = $Request.source_sha256; github = $Request.github; identity = (Get-ProbeIdentity); production_qualified = $false }
    try {
        $intent = Read-QualificationJson $Folder 'registration-intent.json'
        if ($intent.schema -cne ($script:SchemaPrefix + '.registration-intent/1') -or
            $intent.qualification_id -cne $Id.ToString('D') -or
            $intent.task_name -cne ($script:TaskPrefix + $Id.ToString('N')) -or
            $intent.source_sha256 -cne $Request.source_sha256 -or $intent.task_was_absent -ne $true -or
            $intent.production_qualified -ne $false) { throw 'OWN_REGISTRATION_INTENT_NOT_PROVEN' }
        $outcome.registration_intent_verified = $true
        $service = New-Object -ComObject 'Schedule.Service'; $service.Connect()
        $root = $service.GetFolder('\'); $name = $script:TaskPrefix + $Id.ToString('N')
        $task = Get-SchedulerTaskOrMissing $root $name
        if ($null -ne $task) {
            $outcome.task_was_present = $true
            Assert-OwnedCanaryTask $task $Id $Folder $Request.source_sha256
            $outcome.task_ownership_verified = $true
            if ([int]$task.State -eq 4 -or [int]$task.State -eq 2) { $task.Stop(0) }
            $root.DeleteTask($name, 0); $outcome.deleted_own_task = $true
        }
        if ($null -eq (Get-SchedulerTaskOrMissing $root $name)) { $outcome.result = 'ABSENT_CONFIRMED'; $outcome.task_absent_confirmed = $true }
        else { $outcome.reason = 'OWN_TASK_STILL_PRESENT' }
    } catch { $outcome.reason = 'OWN_TASK_CLEANUP_NOT_CONFIRMED'; $outcome.error = Get-ErrorEvidence $_ }
    Write-NewQualificationJson $Folder 'cleanup.json' $outcome
}
function Invoke-InternalChild([guid]$Id, [string]$Folder, [ValidateSet('Scheduler', 'Cleanup')][string]$Phase, [int]$Timeout) {
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + [IO.Path]::Combine($Folder, 'probe.ps1') +
        '" -Mode Inventory -QualificationId ' + $Id.ToString('D') + ' -InternalPhase ' + $Phase
    return Invoke-FixedProcess $script:PowerShellPath $arguments $Timeout
}
function Invoke-S4UCanary([guid]$Id, $Identity, $GitHub, [guid]$CanaryId, [guid]$VmId) {
    $folder = Get-QualificationFolder $Id
    if ([IO.Directory]::Exists($folder) -or [IO.File]::Exists($folder)) { throw 'QUALIFICATION_ID_ALREADY_USED' }
    [IO.Directory]::CreateDirectory($folder) | Out-Null
    Assert-QualificationPath $folder -MustExist
    $sourceCopy = [IO.Path]::Combine($folder, 'probe.ps1')
    [IO.File]::Copy($script:SourcePath, $sourceCopy, $false)
    $sourceHash = Get-ProbeSha256 $sourceCopy
    if ($sourceHash -cne (Get-ProbeSha256 $script:SourcePath)) { throw 'SOURCE_COPY_CHANGED' }
    $request = [ordered]@{ schema = ($script:SchemaPrefix + '.request/1'); qualification_id = $Id.ToString('D')
        created_utc = [DateTime]::UtcNow.ToString('o'); expected_sid = $script:ExpectedSid
        source_sha256 = $sourceHash; github = $GitHub; production_qualified = $false }
    Write-NewQualificationJson $folder 'request.json' $request
    $report = [ordered]@{ schema = ($script:SchemaPrefix + '.s4u/1'); qualification_id = $Id.ToString('D')
        result = 'UNKNOWN'; identity = $Identity; github = $GitHub; source_sha256 = $sourceHash
        task_name = ($script:TaskPrefix + $Id.ToString('N')); report_directory = $folder
        distro_import = 'NOT_TESTED'; ci_migration = 'NOT_PERFORMED'; production_qualified = $false
        requested_execution_time_limit = 'PT45S'; execution_time_limit_enforced_for_demand_start = $false
        callback_wsl_process_timeout_ms = 8000; parent_scheduler_process_timeout_ms = 35000; cleanup_process_timeout_ms = 8000
        parent_loss_cleanup = 'NOT_GUARANTEED; inspect and clean only the exact owned task' }
    $report.public_canary_read = Get-PublicCanaryReadEvidence $CanaryId
    $report.exact_vm_read = Get-BoundedExactVmReadEvidence $VmId $Id
    if ($report.public_canary_read.result -in @('FAIL', 'UNKNOWN') -or $report.exact_vm_read.result -in @('FAIL', 'UNKNOWN')) {
        $report.result = $(if ($report.public_canary_read.result -eq 'FAIL' -or $report.exact_vm_read.result -eq 'FAIL') { 'FAIL' } else { 'UNKNOWN' })
        $report.reason = 'ACCESS_BOUNDARY_PRECHECK_NOT_PASSED; S4U_TASK_NOT_ATTEMPTED'
        $report.elapsed_milliseconds = $script:Budget.ElapsedMilliseconds
        Write-NewQualificationJson $folder 'result.json' $report
        return $report
    }
    try {
        # A stuck local COM call cannot keep this parent waiting indefinitely.
        $report.scheduler_process = Invoke-InternalChild $Id $folder 'Scheduler' 35000
    } finally {
        # A separate bounded helper inspects only this exact owned new task.
        $report.cleanup_process = Invoke-InternalChild $Id $folder 'Cleanup' 8000
    }
    foreach ($entry in @(@('scheduler', 'scheduler.json'), @('callback', 'callback.json'), @('cleanup', 'cleanup.json'))) {
        try {
            $phaseReport = Read-QualificationJson $folder $entry[1]
            Assert-PhaseReport $phaseReport $entry[0] $Id $sourceHash $GitHub $Identity
            $report[$entry[0]] = $phaseReport
        } catch {
            $report[$entry[0]] = [ordered]@{ schema = ($script:SchemaPrefix + '.' + $entry[0] + '/1')
                qualification_id = $Id.ToString('D'); production_qualified = $false
                result = 'UNKNOWN'; reason = 'PHASE_REPORT_UNAVAILABLE'; error = (Get-ErrorEvidence $_) }
        }
    }
    $callback = $report.callback
    if ($report.scheduler_process.result -eq 'OBSERVED' -and $report.scheduler_process.exit_code -eq 0 -and
        $report.cleanup_process.result -eq 'OBSERVED' -and $report.cleanup_process.exit_code -eq 0 -and
        $report.scheduler.schema -ceq ($script:SchemaPrefix + '.scheduler/1') -and
        $report.scheduler.qualification_id -ceq $Id.ToString('D') -and $report.scheduler.production_qualified -eq $false -and
        $report.scheduler.result -eq 'OBSERVED' -and $callback.result -eq 'OBSERVED' -and
        $callback.schema -ceq ($script:SchemaPrefix + '.callback/1') -and $callback.source_sha256 -ceq $sourceHash -and
        $callback.production_qualified -eq $false -and
        $callback.qualification_id -ceq $Id.ToString('D') -and $callback.identity.sid -ceq $script:ExpectedSid -and
        $callback.identity.session_id -eq 0 -and -not $callback.identity.administrator_token_member -and
        -not $callback.identity.hyper_v_token_member -and
        $report.cleanup.schema -ceq ($script:SchemaPrefix + '.cleanup/1') -and
        $report.cleanup.qualification_id -ceq $Id.ToString('D') -and $report.cleanup.production_qualified -eq $false -and
        $report.cleanup.result -eq 'ABSENT_CONFIRMED') {
        $report.result = 'S4U_AND_WSL_VERSION_OBSERVED'
    }
    $report.elapsed_milliseconds = $script:Budget.ElapsedMilliseconds
    $report.followup = @('Actual distro import/rootfs', 'WSL startup/keepalive/network', 'all four old listeners safe drain',
        'actual Windows and Linux publisher ACL/Hyper-V mutation/serial IPC denial', 'cold-start and cleanup qualification')
    Write-NewQualificationJson $folder 'result.json' $report
    return $report
}

try {
    Initialize-ProbeModules
    $identity = Get-ProbeIdentity
    Assert-ProbeIdentity $identity
    if ($QualificationId -eq [guid]::Empty) { throw 'QUALIFICATION_GUID_REQUIRED' }
    if ($InternalPhase -ne '') {
        if ($IsolationCanaryId -ne [guid]::Empty) { throw 'INTERNAL_PHASE_PARAMETER_MISMATCH' }
        if ($InternalPhase -eq 'VmRead') {
            if ($ExpectedQualificationVm -eq [guid]::Empty) { throw 'EXACT_VM_GUID_REQUIRED' }
            Write-ProbeResult (Get-ExactVmReadEvidence $ExpectedQualificationVm)
            exit 0
        }
        if ($ExpectedQualificationVm -ne [guid]::Empty) { throw 'INTERNAL_PHASE_PARAMETER_MISMATCH' }
        $folder = Get-QualificationFolder $QualificationId -MustExist
        $request = Read-QualificationRequest $QualificationId
        if ($InternalPhase -eq 'Callback') {
            # Callback does nothing except observe identity/version and write one
            # fixed no-secret report in its original qualification directory.
            $version = Get-WslVersionEvidence
            $callback = [ordered]@{ schema = ($script:SchemaPrefix + '.callback/1'); qualification_id = $QualificationId.ToString('D')
                result = $version.result; identity = $identity; wsl_version = $version
                created_utc = [DateTime]::UtcNow.ToString('o'); source_sha256 = $request.source_sha256
                github = $request.github; production_qualified = $false }
            Write-NewQualificationJson $folder 'callback.json' $callback
            if ($callback.result -ne 'OBSERVED') { exit 2 }; exit 0
        }
        if ($InternalPhase -eq 'Scheduler') { Invoke-SchedulerPhase $QualificationId $folder $request; exit 0 }
        if ($InternalPhase -eq 'Cleanup') { Invoke-CleanupPhase $QualificationId $folder $request; exit 0 }
    }
    $github = Get-ProbeGitHubContext
    if ($Mode -eq 'S4UCanary') {
        $result = Invoke-S4UCanary $QualificationId $identity $github $IsolationCanaryId $ExpectedQualificationVm
        Write-ProbeResult $result
        if ($result.result -ne 'S4U_AND_WSL_VERSION_OBSERVED') { exit 2 }; exit 0
    }
    $version = Get-WslVersionEvidence
    $status = $(if ($version.result -eq 'OBSERVED') { Invoke-FixedProcess $script:WslPath '--status' -UnicodeOutput } else { [ordered]@{ result = 'UNKNOWN'; reason = 'VERSION_NOT_OBSERVED' } })
    $list = $(if ($version.result -eq 'OBSERVED') { Invoke-FixedProcess $script:WslPath '--list --verbose' -UnicodeOutput } else { [ordered]@{ result = 'UNKNOWN'; reason = 'VERSION_NOT_OBSERVED' } })
    $registrations = Get-OwnWslRegistrations
    $canary = Get-PublicCanaryReadEvidence $IsolationCanaryId
    $vm = Get-BoundedExactVmReadEvidence $ExpectedQualificationVm $QualificationId
    $observed = ($version.result -eq 'OBSERVED' -and $status.result -eq 'OBSERVED' -and $status.exit_code -eq 0 -and
        $list.result -eq 'OBSERVED' -and $list.exit_code -eq 0 -and $registrations.result -eq 'OBSERVED')
    $badProbe = ($canary.result -eq 'FAIL' -or $vm.result -eq 'FAIL')
    $unknownProbe = ($canary.result -eq 'UNKNOWN' -or $vm.result -eq 'UNKNOWN')
    Write-ProbeResult ([ordered]@{ schema = ($script:SchemaPrefix + '.inventory/1'); mode = $Mode
        qualification_id = $QualificationId.ToString('D'); result = $(if ($badProbe) { 'FAIL' } elseif ($observed -and -not $unknownProbe) { 'INVENTORY_OBSERVED' } else { 'UNKNOWN' })
        identity = $identity; github = $github; source_sha256 = (Get-ProbeSha256 $script:SourcePath)
        wsl_version = $version; wsl_status = $status; wsl_list = $list; own_wsl_registrations = $registrations
        public_canary_read = $canary; exact_vm_read = $vm; side_effects = $false; distro_import = 'NOT_TESTED'
        s4u_start = 'NOT_TESTED'; serial_ipc = 'NOT_TESTED'; production_qualified = $false
        elapsed_milliseconds = $script:Budget.ElapsedMilliseconds })
    if ($badProbe) { exit 1 }; if (-not $observed -or $unknownProbe) { exit 2 }; exit 0
} catch {
    # Fixed values only: do not echo command lines, environment or private bodies.
    $failure = [ordered]@{ schema = 'clued.publisher-host-principal.failure/1'; result = 'REFUSED_OR_UNKNOWN'
        mode = $Mode; internal_phase = $InternalPhase; qualification_id = $QualificationId.ToString('D')
        error = (Get-ErrorEvidence $_); production_qualified = $false; elapsed_milliseconds = $script:Budget.ElapsedMilliseconds }
    try { Write-ProbeResult $failure } catch { [Console]::Error.WriteLine('HOST_PRINCIPAL_PROBE_REFUSED') }
    exit 20
}
