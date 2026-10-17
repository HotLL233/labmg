$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-Sha256($file) {
    $stream = [System.IO.File]::OpenRead($file)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
}
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid package version' }
$artifacts = Join-Path $root 'artifacts'
$cache = Join-Path $artifacts "cache\$version"
$release = Join-Path $artifacts "releases\$version"
$archiveName = "labos-$version.zip"
$stage = Join-Path $cache ('build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$lock = $null
try {
    $lock = [System.IO.File]::Open((Join-Path $cache 'build.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $inputs = @()
    foreach ($directory in @('.github', 'src', 'scripts', 'deploy', 'docs', 'tests')) {
        $inputs += Get-ChildItem -LiteralPath (Join-Path $root $directory) -Recurse -File -Force
    }
    foreach ($file in @('config\.env.example', 'package.json', 'package-lock.json', 'README.md', 'AGENTS.md')) {
        $inputs += Get-Item -LiteralPath (Join-Path $root $file) -Force
    }
    $sources = @($inputs | ForEach-Object {
        $relative = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
        if ($relative -match '(^|/)(var|data|uploads|logs|artifacts|\.git|node_modules)(/|$)' -or
            $_.Name -match '\.(log|db(-wal|-shm)?)$' -or
            ($_.Name -like '.env*' -and @('config/.env.example', 'deploy/.env.example') -notcontains $relative)) { return }
        $item = $_
        while ($item.FullName -ne $root) {
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Cannot package linked path: $relative" }
            $item = Get-Item -LiteralPath (Split-Path $item.FullName -Parent)
        }
        [ordered]@{ path = $relative; size = $_.Length; sha256 = Get-Sha256 $_.FullName }
    } | Sort-Object { $_.path })
    $sourceJson = ConvertTo-Json -InputObject $sources -Depth 4 -Compress
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $sourceSha = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sourceJson)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }

    if (Test-Path -LiteralPath $release) {
        $archive = Join-Path $release $archiveName
        $manifestPath = Join-Path $release 'manifest.json'
        if (!(Test-Path -LiteralPath $archive -PathType Leaf) -or !(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            throw 'Incomplete release cache; preserve it and use a new package version.'
        }
        try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json }
        catch { throw 'Release manifest is damaged; preserve it and use a new package version.' }
        if ($manifest.version -ne $version -or $manifest.sourceSha256 -ne $sourceSha -or
            $manifest.archive -ne $archiveName -or $manifest.size -ne (Get-Item -LiteralPath $archive).Length -or
            $manifest.sha256 -ne (Get-Sha256 $archive)) {
            throw 'Release source differs or cache is damaged; preserve it and use a new package version.'
        }
        Write-Host "Reused verified $archive"
        return
    }

    $payload = Join-Path $stage 'payload'
    $ready = Join-Path $stage 'release'
    New-Item -ItemType Directory -Path $payload, $ready -Force | Out-Null
    foreach ($source in $sources) {
        $destination = Join-Path $payload $source.path
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $root $source.path) -Destination $destination
        if ((Get-Sha256 $destination) -ne $source.sha256) {
            throw 'Source changed during packaging; rerun with stable source files.'
        }
    }
    @('@echo off', 'cd /d "%~dp0"',
        'if not exist "node_modules\write-excel-file\package.json" goto install',
        'if exist "node_modules\zxing-wasm\dist\full\zxing_full.wasm" goto start',
        ':install',
        "  call npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache artifacts\cache\$version\npm",
        '  if errorlevel 1 exit /b 1', ':start', 'node src\server.js') |
        Set-Content -LiteralPath (Join-Path $payload 'start-labos.cmd') -Encoding ascii
    $archive = Join-Path $ready $archiveName
    [System.IO.Compression.ZipFile]::CreateFromDirectory($payload, $archive)
    $commit = $null
    try {
        $repository = & git -C $root rev-parse --show-toplevel 2>$null
        if ($LASTEXITCODE -eq 0 -and [System.IO.Path]::GetFullPath($repository) -eq $root) {
            $commit = & git -C $root rev-parse HEAD 2>$null
            if ($LASTEXITCODE -ne 0) { $commit = $null }
        }
    } catch { $commit = $null }
    [ordered]@{
        version = $version
        commit = $commit
        sourceSha256 = $sourceSha
        builtAtUtc = [DateTime]::UtcNow.ToString('o')
        archive = $archiveName
        size = (Get-Item -LiteralPath $archive).Length
        sha256 = Get-Sha256 $archive
        sources = $sources
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $ready 'manifest.json') -Encoding UTF8
    New-Item -ItemType Directory -Path (Split-Path $release -Parent) -Force | Out-Null
    $readyPath = [System.IO.Path]::GetFullPath($ready)
    $releasePath = [System.IO.Path]::GetFullPath($release)
    $cachePrefix = [System.IO.Path]::GetFullPath($cache) + [System.IO.Path]::DirectorySeparatorChar
    $releasePrefix = [System.IO.Path]::GetFullPath((Join-Path $artifacts 'releases')) + [System.IO.Path]::DirectorySeparatorChar
    if (!$readyPath.StartsWith($cachePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        !$releasePath.StartsWith($releasePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to publish outside the versioned artifacts directories'
    }
    if (Test-Path -LiteralPath $releasePath) { throw 'Release already exists; preserve it and use a new package version.' }
    Move-Item -LiteralPath $readyPath -Destination $releasePath
    Write-Host "Created $(Join-Path $release $archiveName)"
} finally {
    $stagePath = [System.IO.Path]::GetFullPath($stage)
    $cachePrefix = [System.IO.Path]::GetFullPath($cache) + [System.IO.Path]::DirectorySeparatorChar
    if (!$stagePath.StartsWith($cachePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($stagePath) -notmatch '^build-[a-f0-9]{32}$') {
        throw 'Refusing to remove staging directory outside this version cache'
    }
    if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
    if ($null -ne $lock) { $lock.Dispose() }
}
