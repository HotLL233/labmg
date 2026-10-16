param([string[]]$Architectures = @('amd64', 'arm64'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Architectures = @($Architectures | ForEach-Object { $_ -split ',' } | Select-Object -Unique)
if (!$Architectures.Count -or @($Architectures | Where-Object { $_ -notin @('amd64', 'arm64') }).Count) {
    throw 'Architectures must be amd64, arm64, or both.'
}
function Get-Sha256($file) {
    $stream = [System.IO.File]::OpenRead($file)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
}
function Get-ArtifactPath($path, $parent) {
    $absolute = [System.IO.Path]::GetFullPath($path)
    $prefix = [System.IO.Path]::GetFullPath($parent) + [System.IO.Path]::DirectorySeparatorChar
    if (!$absolute.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact path is outside its designated directory.' }
    return $absolute
}
function Invoke-Docker([string[]]$DockerArguments) {
    $ErrorActionPreference = 'Continue'
    & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed: docker $($DockerArguments -join ' ')" }
}
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid package version' }
Get-Command docker -ErrorAction Stop | Out-Null
& (Join-Path $PSScriptRoot 'package.ps1')
$artifacts = Join-Path $root 'artifacts'
$cacheRoot = Join-Path $artifacts 'cache'
$cache = Get-ArtifactPath (Join-Path $cacheRoot $version) $cacheRoot
$release = Get-ArtifactPath (Join-Path $artifacts "releases\$version") (Join-Path $artifacts 'releases')
$sourceManifest = Get-Content -LiteralPath (Join-Path $release 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$imageTag = "labos:$version"
$vcsRef = 'unknown'
if ($sourceManifest.commit) { $vcsRef = $sourceManifest.commit }
$stage = Get-ArtifactPath (Join-Path $cache ('docker-' + [guid]::NewGuid().ToString('N'))) $cache
$lock = $null
try {
    $lock = [System.IO.File]::Open((Join-Path $cache 'docker.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $context = Join-Path $stage 'context'
    New-Item -ItemType Directory -Path $stage | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $release $sourceManifest.archive), $context)
    $deploymentFiles = @{
        'deploy/docker-compose.yml' = 'docker-compose.yml'
        'deploy/.env.example' = '.env.example'
        'docs/SYNOLOGY.md' = 'SYNOLOGY.md'
    }
    foreach ($source in $deploymentFiles.Keys) {
        $destination = Get-ArtifactPath (Join-Path $release $deploymentFiles[$source]) $release
        if ((Test-Path -LiteralPath $destination) -and
            (!(Test-Path -LiteralPath $destination -PathType Leaf) -or (Get-Sha256 $destination) -ne (Get-Sha256 (Join-Path $context $source)))) {
            throw 'Deployment artifact differs; preserve it and use a new package version.'
        }
    }
    foreach ($architecture in $Architectures) {
        $baseName = "labos-$version-linux-$architecture"
        $archive = Get-ArtifactPath (Join-Path $release "$baseName.tar") $release
        $metadata = Get-ArtifactPath (Join-Path $release "$baseName.json") $release
        if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $metadata)) {
            try {
                if (!(Test-Path -LiteralPath $archive -PathType Leaf) -or !(Test-Path -LiteralPath $metadata -PathType Leaf)) { throw 'Incomplete image archive.' }
                $existing = Get-Content -LiteralPath $metadata -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($existing.version -ne $version -or $existing.commit -ne $sourceManifest.commit -or
                    $existing.sourceSha256 -ne $sourceManifest.sourceSha256 -or $existing.imageTag -ne $imageTag -or
                    $existing.os -ne 'linux' -or $existing.architecture -ne $architecture -or
                    $existing.imageId -notmatch '^sha256:[a-f0-9]{64}$' -or $existing.archive -ne "$baseName.tar" -or
                    $existing.size -ne (Get-Item -LiteralPath $archive).Length -or $existing.sha256 -ne (Get-Sha256 $archive)) { throw 'Image archive failed verification.' }
            } catch { throw 'Image archive is incomplete, differs or is damaged; preserve it and use a new package version.' }
            Write-Host "Reused verified $archive"
            continue
        }
        $buildCache = Get-ArtifactPath (Join-Path $cache "buildx-$architecture") $cache
        $importCache = $buildCache
        if (!(Test-Path -LiteralPath (Join-Path $importCache 'index.json'))) {
            $previous = Get-ChildItem -LiteralPath $cacheRoot -Directory | Where-Object {
                $_.Name -ne $version -and $_.Name -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -and
                (Test-Path -LiteralPath (Join-Path $_.FullName "buildx-$architecture\index.json"))
            } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
            if ($previous) { $importCache = Join-Path $previous.FullName "buildx-$architecture" }
        }
        $dockerArguments = @('buildx', 'build', '--platform', "linux/$architecture", '--load', '--tag', $imageTag,
            '--file', (Join-Path $context 'deploy/Dockerfile'), '--build-arg', "VERSION=$version", '--build-arg', "VCS_REF=$vcsRef",
            '--cache-to', "type=local,dest=$buildCache,mode=max")
        if (Test-Path -LiteralPath (Join-Path $importCache 'index.json')) { $dockerArguments += @('--cache-from', "type=local,src=$importCache") }
        Invoke-Docker ($dockerArguments + $context)
        $inspection = @(((Invoke-Docker @('image', 'inspect', $imageTag)) -join [Environment]::NewLine) | ConvertFrom-Json)
        if ($inspection.Count -ne 1 -or $inspection[0].Os -ne 'linux' -or $inspection[0].Architecture -ne $architecture -or
            $inspection[0].Id -notmatch '^sha256:[a-f0-9]{64}$' -or
            $inspection[0].Config.Labels.'org.opencontainers.image.version' -ne $version -or
            $inspection[0].Config.Labels.'org.opencontainers.image.revision' -ne $vcsRef) {
            throw 'Built image platform, ID or source labels do not match the release.'
        }
        $temporaryArchive = Join-Path $stage "$baseName.tar"
        $temporaryMetadata = Join-Path $stage "$baseName.json"
        Invoke-Docker @('save', '--output', $temporaryArchive, $imageTag)
        [ordered]@{
            version = $version
            commit = $sourceManifest.commit
            sourceSha256 = $sourceManifest.sourceSha256
            imageTag = $imageTag
            imageId = $inspection[0].Id
            os = 'linux'
            architecture = $architecture
            archive = "$baseName.tar"
            size = (Get-Item -LiteralPath $temporaryArchive).Length
            sha256 = Get-Sha256 $temporaryArchive
            builtAtUtc = [DateTime]::UtcNow.ToString('o')
        } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporaryMetadata -Encoding UTF8
        $temporaryArchive = Get-ArtifactPath $temporaryArchive $stage
        $temporaryMetadata = Get-ArtifactPath $temporaryMetadata $stage
        $archive = Get-ArtifactPath $archive $release
        $metadata = Get-ArtifactPath $metadata $release
        if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $metadata)) { throw 'Image release already exists; preserve it and use a new package version.' }
        Move-Item -LiteralPath $temporaryArchive -Destination $archive
        Move-Item -LiteralPath $temporaryMetadata -Destination $metadata
        Write-Host "Created $archive"
    }
    foreach ($source in $deploymentFiles.Keys) {
        $destination = Get-ArtifactPath (Join-Path $release $deploymentFiles[$source]) $release
        if (!(Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath (Join-Path $context $source) -Destination $destination }
    }
} finally {
    $stagePath = Get-ArtifactPath $stage $cache
    if ([System.IO.Path]::GetFileName($stagePath) -notmatch '^docker-[a-f0-9]{32}$') { throw 'Refusing to remove an unexpected Docker staging directory.' }
    if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
    if ($null -ne $lock) { $lock.Dispose() }
}
