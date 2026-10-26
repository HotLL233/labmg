#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Backup', 'Verify')][string]$Mode,
    [Parameter(Mandatory)][string]$Destination,
    [string]$ComposeFile,
    [string]$ProjectName
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-Docker([string[]]$Arguments) {
    # Compose can emit successful warnings on stderr; container IDs and JSON use stdout only.
    $result = & docker @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Docker $($Arguments[0]) failed; inspect the selected containers and the backup status before retrying." }
    return ($result | ForEach-Object { "$_" }) -join "`n"
}

function Write-JsonFile($Value, [string]$Path) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12) + "`n", [Text.UTF8Encoding]::new($false))
}

function Get-Service([string]$Name) {
    $id = (Invoke-Docker -Arguments @('compose', '--project-directory', (Split-Path -Parent $taskCompose), '--project-name', $ProjectName, '--file', $taskCompose, 'ps', '--all', '--quiet', $Name)).Trim()
    if ($id -notmatch '^[a-f0-9]{12,64}$') { throw "Expected exactly one $Name container in the selected Compose project." }
    $containers = @(ConvertFrom-Json (Invoke-Docker -Arguments @('inspect', $id)))
    if ($containers.Count -ne 1) { throw "Unexpected container identity for $Name." }
    $container = $containers[0]
    if ($container.Config.Labels.'com.docker.compose.project' -ne $ProjectName -or
        $container.Config.Labels.'com.docker.compose.service' -ne $Name -or
        !$container.Id.StartsWith($id) -or $container.Image -notmatch '^sha256:[a-f0-9]{64}$') {
        throw "Compose labels or image identity do not match $Name; no service was stopped."
    }
    if ($container.State.Status -notin @('running', 'created', 'exited')) { throw "Resolve the $Name container state before backing up." }
    return $container
}

function Get-Bind($Container, [string]$Target) {
    $mounts = @($Container.Mounts | Where-Object { $_.Destination -eq $Target })
    if ($mounts.Count -ne 1 -or $mounts[0].Type -ne 'bind' -or !$mounts[0].Source) {
        throw "Expected one bind mount at $Target. This script supports the supplied LabOS Compose layout."
    }
    return $mounts[0].Source.TrimEnd('/', '\')
}

function Copy-Archive([string]$Container, [string]$Image, [string]$Target, [string]$File, [switch]$Runtime) {
    $temporary = $null
    try {
        $arguments = @('create', '--pull', 'never', '--network', 'none', '--user', '0:0', '--volumes-from', "${Container}:ro", '--entrypoint', 'tar', $Image,
            '-czf', '/tmp/labos-files.tar.gz')
        if ($Runtime) { $arguments += '--exclude=./postgres' }
        $arguments += @('-C', $Target, '.')
        $temporary = (Invoke-Docker $arguments).Trim()
        if ($temporary -notmatch '^[a-f0-9]{12,64}$') { throw 'Unexpected temporary archive container identity.' }
        $null = Invoke-Docker -Arguments @('start', '--attach', $temporary)
        $null = Invoke-Docker -Arguments @('cp', "${temporary}:/tmp/labos-files.tar.gz", $File)
    } finally {
        if ($temporary -match '^[a-f0-9]{12,64}$') { $null = Invoke-Docker -Arguments @('rm', $temporary) }
    }
}

function Test-Backup([string]$Directory, [switch]$Pending) {
    $manifest = Get-Content -LiteralPath (Join-Path $Directory 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.format -ne 'labos-runtime-backup-v1' -or
        ($manifest.status -ne 'complete' -and !($Pending -and $manifest.status -eq 'checking')) -or
        $manifest.database.major -ne 18 -or $manifest.database.name -ne 'labos' -or
        $manifest.database.imageId -notmatch '^sha256:[a-f0-9]{64}$' -or
        $manifest.application.imageId -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Unsupported or incomplete backup manifest.' }
    $expected = @('database.dump', 'runtime.tar.gz', 'https.tar.gz', 'compose.yml')
    if ($manifest.includesEnv -eq $true) { $expected += 'compose.env' }
    $actual = @($manifest.files | ForEach-Object { $_.name })
    if (($actual | Sort-Object -Unique).Count -ne $expected.Count -or
        (@(Compare-Object ($actual | Sort-Object) ($expected | Sort-Object))).Count -ne 0) { throw 'Backup file list is incomplete or invalid.' }
    foreach ($file in $manifest.files) {
        $path = Join-Path $Directory $file.name
        if (!(Test-Path -LiteralPath $path -PathType Leaf) -or
            $file.sha256 -notmatch '^[a-f0-9]{64}$' -or $file.size -le 0 -or
            (Get-Item -LiteralPath $path).Length -ne $file.size -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {
            throw "Backup file missing or checksum differs: $($file.name)"
        }
    }
    $temporary = $null
    try {
        $temporary = (Invoke-Docker -Arguments @('create', '--pull', 'never', '--network', 'none', '--entrypoint', 'pg_restore', $manifest.database.imageId, '--list', '/tmp/database.dump')).Trim()
        if ($temporary -notmatch '^[a-f0-9]{12,64}$') { throw 'Unexpected temporary verification container identity.' }
        $null = Invoke-Docker -Arguments @('cp', (Join-Path $Directory 'database.dump'), "${temporary}:/tmp/database.dump")
        $null = Invoke-Docker -Arguments @('start', '--attach', $temporary)
    } finally {
        if ($temporary -match '^[a-f0-9]{12,64}$') { $null = Invoke-Docker -Arguments @('rm', $temporary) }
    }
    return $manifest
}

$null = Get-Command docker -ErrorAction Stop
$taskDestination = [IO.Path]::GetFullPath($Destination)
if ($Mode -eq 'Verify') {
    $null = Test-Backup $taskDestination
    Write-Output 'Backup checksums and PostgreSQL archive listing verified. Restore rehearsal is still required.'
    return
}
if (!$ComposeFile -or $ProjectName -notmatch '^[a-z0-9][a-z0-9_-]*$') { throw 'Backup requires -ComposeFile and the exact -ProjectName.' }
$taskCompose = (Resolve-Path -LiteralPath $ComposeFile).ProviderPath
if (Test-Path -LiteralPath $taskDestination) { throw 'Destination already exists. Choose a new private backup directory; existing backups are never overwritten.' }
$taskApp = Get-Service 'labos'
$taskPg = Get-Service 'postgres'
$taskHttps = Get-Service 'labos-https'
if ($taskPg.State.Status -ne 'running') { throw 'PostgreSQL must be running for a logical backup.' }
$taskRuntime = Get-Bind $taskApp '/var/lib/labos'
$taskPgSource = Get-Bind $taskPg '/var/lib/postgresql'
$taskSecretSource = Get-Bind $taskPg '/run/labos-secrets'
$taskHttpsSource = Get-Bind $taskHttps '/var/lib/labos-https'
$taskHttpsConfig = Get-Bind $taskHttps '/etc/labos-https'
$taskNormalize = { param($value) $value.Replace('\', '/').TrimEnd('/') }
if ((& $taskNormalize $taskPgSource) -ne ((& $taskNormalize $taskRuntime) + '/postgres') -or
    (& $taskNormalize $taskSecretSource) -ne ((& $taskNormalize $taskRuntime) + '/secrets') -or
    (& $taskNormalize $taskHttpsConfig) -ne ((& $taskNormalize $taskRuntime) + '/https-config')) {
    throw 'Database, secrets or HTTPS configuration do not belong to the application runtime mount.'
}
foreach ($source in @($taskRuntime, $taskHttpsSource)) {
    $normalizedDestination = (& $taskNormalize $taskDestination)
    $normalizedSource = (& $taskNormalize $source)
    if ($normalizedDestination.Equals($normalizedSource, [StringComparison]::OrdinalIgnoreCase) -or
        $normalizedDestination.StartsWith($normalizedSource + '/', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Choose a backup destination outside runtime/ and https/.'
    }
}
$taskVersionNumber = (Invoke-Docker -Arguments @('exec', $taskPg.Id, 'psql', '-U', 'labos', '-d', 'labos', '-Atqc', 'SHOW server_version_num')).Trim()
if ($taskVersionNumber -notmatch '^18\d{4}$') { throw 'The selected database is not PostgreSQL 18.' }
$taskImages = @($taskApp.Image, $taskPg.Image, $taskHttps.Image)
foreach ($image in $taskImages) { $null = Invoke-Docker -Arguments @('image', 'inspect', $image) }

New-Item -ItemType Directory -Path $taskDestination | Out-Null
$taskMarker = Join-Path $taskDestination 'INCOMPLETE'
[IO.File]::WriteAllText($taskMarker, "Backup is incomplete. Do not restore it.`n", [Text.UTF8Encoding]::new($false))
$taskStopped = [Collections.Generic.List[string]]::new()
$taskDump = '/tmp/labos-backup-' + [Guid]::NewGuid().ToString('N') + '.dump'
$taskDumpAttempted = $false
$taskSucceeded = $false
try {
    foreach ($container in @($taskHttps, $taskApp)) {
        if ($container.State.Status -eq 'running') {
            # Track before stopping: a successful stop with a lost response must still be restarted.
            $taskStopped.Add($container.Id)
            $null = Invoke-Docker -Arguments @('stop', '--time', '60', $container.Id)
        }
    }
    $taskDumpAttempted = $true
    $null = Invoke-Docker -Arguments @('exec', $taskPg.Id, 'pg_dump', '-U', 'labos', '-d', 'labos', '--format=custom', '--no-owner', '--no-acl', '--file', $taskDump)
    $null = Invoke-Docker -Arguments @('cp', "$($taskPg.Id):$taskDump", (Join-Path $taskDestination 'database.dump'))
    Copy-Archive $taskApp.Id $taskApp.Image '/var/lib/labos' (Join-Path $taskDestination 'runtime.tar.gz') -Runtime
    Copy-Archive $taskHttps.Id $taskApp.Image '/var/lib/labos-https' (Join-Path $taskDestination 'https.tar.gz')
    Copy-Item -LiteralPath $taskCompose -Destination (Join-Path $taskDestination 'compose.yml')
    $taskEnv = Join-Path (Split-Path -Parent $taskCompose) '.env'
    $taskHasEnv = Test-Path -LiteralPath $taskEnv -PathType Leaf
    if ($taskHasEnv) { Copy-Item -LiteralPath $taskEnv -Destination (Join-Path $taskDestination 'compose.env') }
    $taskFiles = @('database.dump', 'runtime.tar.gz', 'https.tar.gz', 'compose.yml')
    if ($taskHasEnv) { $taskFiles += 'compose.env' }
    $taskManifest = [ordered]@{
        format = 'labos-runtime-backup-v1'; status = 'checking'; createdAtUtc = [DateTime]::UtcNow.ToString('o')
        project = $ProjectName; includesEnv = $taskHasEnv
        database = @{ major = 18; serverVersionNum = $taskVersionNumber; name = 'labos'; imageId = $taskPg.Image; containerId = $taskPg.Id }
        application = @{ imageId = $taskApp.Image; containerId = $taskApp.Id; user = $taskApp.Config.User; ports = $taskApp.HostConfig.PortBindings }
        https = @{ imageId = $taskHttps.Image; containerId = $taskHttps.Id; ports = $taskHttps.HostConfig.PortBindings }
        runtime = @{ source = $taskRuntime; excluded = @('postgres/') }; httpsSource = $taskHttpsSource
        stoppedServices = @($taskStopped)
        files = @($taskFiles | ForEach-Object { $path = Join-Path $taskDestination $_; @{ name = $_; size = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() } })
    }
    Write-JsonFile $taskManifest (Join-Path $taskDestination 'manifest.json')
    $null = Test-Backup $taskDestination -Pending
    $taskManifest.status = 'complete'
    Write-JsonFile $taskManifest (Join-Path $taskDestination 'manifest.json')
    $taskSucceeded = $true
} finally {
    $taskCleanupErrors = [Collections.Generic.List[string]]::new()
    if ($taskDumpAttempted) {
        try { $null = Invoke-Docker -Arguments @('exec', $taskPg.Id, 'rm', '-f', $taskDump) } catch { $taskCleanupErrors.Add('Temporary database dump cleanup failed.') }
    }
    foreach ($container in @($taskApp, $taskHttps)) {
        if ($taskStopped.Contains($container.Id)) {
            try { $null = Invoke-Docker -Arguments @('start', $container.Id) } catch { $taskCleanupErrors.Add('An originally running service could not be restarted; inspect the selected project.') }
        }
    }
    if ($taskSucceeded) { Remove-Item -LiteralPath $taskMarker -Force }
    if ($taskCleanupErrors.Count) { throw ($taskCleanupErrors -join ' ') }
}
Write-Output "Complete private backup created at $taskDestination. Keep its secrets and certificate keys offline; perform a restore rehearsal before relying on it."
