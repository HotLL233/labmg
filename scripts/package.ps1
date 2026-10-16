$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid package version' }
$artifacts = Join-Path $root 'artifacts'
$stage = Join-Path $artifacts ('.package-' + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $artifacts "labos-$version.zip"
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
    foreach ($directory in @('src', 'scripts', 'deploy', 'docs', 'tests')) {
        Copy-Item -LiteralPath (Join-Path $root $directory) -Destination $stage -Recurse
    }
    New-Item -ItemType Directory -Path (Join-Path $stage 'config') | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'config\.env.example') -Destination (Join-Path $stage 'config')
    foreach ($file in @('package.json', 'README.md')) {
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage
    }
    @('@echo off', 'cd /d "%~dp0"', 'node src\server.js') |
        Set-Content -LiteralPath (Join-Path $stage 'start-labos.cmd') -Encoding ascii
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
    Write-Host "Created $archive"
} finally {
    $stagePath = [System.IO.Path]::GetFullPath($stage)
    $artifactsPrefix = [System.IO.Path]::GetFullPath($artifacts) + [System.IO.Path]::DirectorySeparatorChar
    if (!$stagePath.StartsWith($artifactsPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to remove staging directory outside artifacts'
    }
    if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
}
