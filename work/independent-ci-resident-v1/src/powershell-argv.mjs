// The one door for starting Windows PowerShell from the resident's Node code (first-install r5 design 1.2, D2'). A freshly installed
// machine has the execution policy Restricted and the service hands node no environment (ResidentServiceHost.cs), so no child inherits
// a policy: every start says -ExecutionPolicy Bypass itself, for -File and for -Command / -EncodedCommand alike (script modules and
// CDXML cmdlets are policy-bound too). The four options are written once, here for the resident's Node code; test/ps-execution-policy.test.mjs
// scans every line of the files the package carries for one that starts PowerShell without them (the Source files it lists as exceptions
// are frozen; the first install's execution-policy baseline covers them).
export const POWERSHELL_PREFIX = Object.freeze(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
// the arguments after the executable: the four options, then the caller's
export const powershellArgs = (...rest) => [...POWERSHELL_PREFIX, ...rest];
// the whole argv: the executable, the four options, then the caller's
export const powershellArgv = (exe, ...rest) => [exe, ...POWERSHELL_PREFIX, ...rest];
