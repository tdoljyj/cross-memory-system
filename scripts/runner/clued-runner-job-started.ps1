# Windows runner wrapper for clued-runner-job-started.mjs (see README.md).
$node = if ($env:CLUED_RUNNER_HOOK_NODE) { $env:CLUED_RUNNER_HOOK_NODE } else { "node" }
& $node (Join-Path $PSScriptRoot "clued-runner-job-started.mjs")
exit $LASTEXITCODE
