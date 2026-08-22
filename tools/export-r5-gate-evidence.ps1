param(
    [Parameter(Mandatory = $true)][string]$Receipt,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$root = (& git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw 'not inside a Git repository' }

$receiptPath = [IO.Path]::GetFullPath((Join-Path $root $Receipt))
$rootPrefix = [IO.Path]::GetFullPath($root).TrimEnd('\\') + '\\'
if (-not $receiptPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'receipt path escapes repository'
}
$receiptObject = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
foreach ($commit in $receiptObject.portable_evidence.required_commit_objects) {
    & git cat-file -e ($commit + '^{commit}')
    if ($LASTEXITCODE -ne 0) { throw ('missing required commit object: ' + $commit) }
    & git merge-base --is-ancestor $commit HEAD
    if ($LASTEXITCODE -ne 0) { throw ('required commit not anchored by HEAD: ' + $commit) }
}

$output = [IO.Path]::GetFullPath($OutputPath)
$outputDir = Split-Path -Parent $output
if (-not (Test-Path -LiteralPath $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}
& git bundle create $output --all
if ($LASTEXITCODE -ne 0) { throw 'git bundle create failed' }
& git bundle verify $output
if ($LASTEXITCODE -ne 0) { throw 'git bundle verify failed' }

$bundleHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    schema_version = 1
    bundle = [IO.Path]::GetFileName($output)
    sha256 = $bundleHash
    generated_at_utc = [DateTime]::UtcNow.ToString('o')
    source_head = (& git rev-parse HEAD).Trim()
    receipt = $Receipt.Replace('\\', '/')
    required_commit_objects = @($receiptObject.portable_evidence.required_commit_objects)
}
$manifestPath = $output + '.sha256.json'
[IO.File]::WriteAllText(
    $manifestPath,
    (($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
)
Write-Output ('BUNDLE=' + $output)
Write-Output ('SHA256=' + $bundleHash)
Write-Output ('MANIFEST=' + $manifestPath)

