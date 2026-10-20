#requires -Version 7.0
<#
LabOS Windows printing station. Run in the signed-in Windows user session.
Official API: BarTender 2016 ActiveX Print, SaveAs, DesignObject and MeasurementUnits.
These modes never call Print(); native templates must still come from a trusted Designer.
#>
[CmdletBinding()]
param(
    [switch]$Initialize,
    [string]$ServerUrl,
    [string]$Station,
    [switch]$Once,
    [switch]$Check,
    [switch]$CheckEngine,
    [switch]$ArchivePending,
    [string]$JobId,
    [string]$Reason,
    [switch]$AcknowledgeUnconfirmedOutput,
    [switch]$DeriveTemplate,
    [string]$MasterTemplate,
    [string]$Layout,
    [string]$OutputTemplate,
    [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '../var/printing'),
    [switch]$Library,
    [string]$WorkerRequest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:AgentVersion = '0.8.0'
$script:AgentScriptPath = $PSCommandPath
$script:LabelFields = @('Code','QRPayload','Name','CatalogCode','Specification','Unit','Region','Warehouse','Location','Batch','ExpiryDate','Status')

function Assert-StationUrl([string]$Value) {
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or
        ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.Host -in @('localhost','127.0.0.1','[::1]')))) {
        throw 'ServerUrl must be an HTTPS origin; HTTP is allowed only for localhost development.'
    }
    return $uri.GetLeftPart([UriPartial]::Authority)
}

function Write-AtomicText([string]$Path, [string]$Text) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        [IO.File]::Move($temporary, $Path, $true)
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function Save-ProtectedJson([string]$Path, $Value) {
    $secure = ConvertTo-SecureString (ConvertTo-Json -InputObject $Value -Depth 30 -Compress) -AsPlainText -Force
    try { Write-AtomicText $Path (ConvertFrom-SecureString $secure) } finally { $secure.Dispose() }
}

function Read-ProtectedJson([string]$Path) {
    $secure = ConvertTo-SecureString ([IO.File]::ReadAllText($Path))
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return ConvertFrom-Json ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) -AsHashtable
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $secure.Dispose()
    }
}

function Protect-RuntimeDirectory([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\','/')
    $root = [IO.Path]::GetPathRoot($resolved).TrimEnd('\','/')
    $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\','/')
    if ($resolved -ieq $root -or $resolved -ieq $projectRoot -or $resolved -ieq $PSScriptRoot -or $resolved -ieq [Environment]::GetFolderPath('UserProfile')) { throw 'RuntimeDirectory must be a dedicated printing directory, not a drive, project, script or user root.' }
    $ancestor = $resolved
    while ($ancestor) {
        if ([IO.Directory]::Exists($ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'RuntimeDirectory and its ancestors must not be reparse points.' }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    $marker = Join-Path $resolved '.labos-printing-runtime'
    $signature = 'LabOS printing runtime'
    if ([IO.Directory]::Exists($resolved)) {
        if ([IO.File]::Exists($marker)) { if ([IO.File]::ReadAllText($marker) -cne $signature) { throw 'RuntimeDirectory marker does not match this printing station.' } }
        elseif ([IO.Directory]::EnumerateFileSystemEntries($resolved).GetEnumerator().MoveNext()) { throw 'Existing nonempty RuntimeDirectory is not owned by this printing station; choose a new empty directory.' }
    }
    [void][IO.Directory]::CreateDirectory($Path)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    foreach ($sid in @($identity, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), $acl)
    if (-not [IO.File]::Exists($marker)) { Write-AtomicText $marker $signature }
}

function Assert-Job($Job) {
    if ($Job -isnot [Collections.IDictionary] -or [string]$Job.id -notmatch '^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$' -or
        $Job.leaseToken -isnot [string] -or $Job.leaseToken.Length -lt 16 -or $Job.leaseToken.Length -gt 512) { throw 'JOB_ID_OR_LEASE_INVALID' }
    $template = $Job.template
    if ($template -isnot [Collections.IDictionary] -or $template.fileName -isnot [string] -or
        $template.fileName -notmatch '^[^/\\:\x00-\x1f]+\.btw$' -or $template.fileName.Length -gt 200 -or
        $template.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $template.contentBase64 -isnot [string] -or
        $template.contentBase64.Length -gt 5592408) { throw 'TEMPLATE_INVALID' }
    try { $bytes = [Convert]::FromBase64String($template.contentBase64) } catch { throw 'TEMPLATE_BASE64_INVALID' }
    if ($bytes.Length -eq 0 -or $bytes.Length -gt 4MB -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)) -ine $template.sha256) { throw 'TEMPLATE_HASH_INVALID' }
    if ($template.fields -isnot [array] -or $template.fields.Count -lt 1 -or $template.fields.Count -gt 12 -or
        ('Code' -cnotin $template.fields -and 'QRPayload' -cnotin $template.fields) -or @($template.fields | Select-Object -Unique).Count -ne $template.fields.Count) { throw 'TEMPLATE_FIELDS_INVALID' }
    foreach ($field in $template.fields) { if ($field -isnot [string] -or $field -cnotin $script:LabelFields) { throw 'TEMPLATE_FIELD_UNKNOWN' } }
    if ($Job.printerName -isnot [string] -or -not $Job.printerName.Trim() -or $Job.printerName.Length -gt 256 -or
        $Job.rows -isnot [array] -or $Job.rows.Count -lt 1 -or $Job.rows.Count -gt 1000) { throw 'JOB_ROWS_OR_PRINTER_INVALID' }
    $codes = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($row in $Job.rows) {
        if ($row -isnot [Collections.IDictionary] -or @($row.Keys).Count -ne 12) { throw 'ROW_FIELDS_INVALID' }
        foreach ($field in $script:LabelFields) {
            if (-not $row.Contains($field) -or $row[$field] -isnot [string] -or $row[$field].Length -gt 4096 -or $row[$field].Contains([char]0)) { throw 'ROW_VALUE_INVALID' }
        }
        if (-not $row.Code.Trim() -or -not $row.QRPayload.Trim() -or -not $codes.Add($row.Code)) { throw 'ROW_CODE_INVALID_OR_DUPLICATE' }
    }
    $expires = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$Job.leaseExpiresAt, [ref]$expires) -or $expires -lt [DateTimeOffset]::UtcNow.AddSeconds(5)) { throw 'LEASE_EXPIRED' }
    return ,$bytes
}

function Save-TemplateCache($Job, [string]$Directory) {
    $bytes = Assert-Job $Job
    $path = Join-Path $Directory ($Job.template.sha256.ToLowerInvariant() + '.btw')
    if ([IO.File]::Exists($path)) {
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $Job.template.sha256) { throw 'CACHED_TEMPLATE_CHANGED' }
    } else {
        $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    }
    return $path
}

function Assert-Printer([string]$Name) {
    $matched = @(Get-Printer -ErrorAction Stop | Where-Object { [string]::Equals($_.Name, $Name, [StringComparison]::Ordinal) })
    if ($matched.Count -ne 1) { throw 'CONFIGURED_PRINTER_NOT_FOUND' }
}

function Assert-Layout($Value) {
    if ($Value -isnot [Collections.IDictionary] -or @($Value.Keys).Count -ne 1 -or $Value.objects -isnot [array] -or $Value.objects.Count -lt 1 -or $Value.objects.Count -gt 100) { throw 'LAYOUT_OBJECTS_REQUIRED' }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in $Value.objects) {
        if ($item -isnot [Collections.IDictionary] -or $item.name -isnot [string] -or -not $item.name.Trim() -or $item.name.Length -gt 128 -or -not $names.Add($item.name)) { throw 'LAYOUT_NAME_INVALID_OR_DUPLICATE' }
        foreach ($key in $item.Keys) {
            if ($key -ceq 'name') { continue }
            if ($key -ceq 'DoNotPrint') { if ($item[$key] -isnot [bool]) { throw 'LAYOUT_BOOLEAN_REQUIRED' }; continue }
            if ($key -cnotin @('X','Y','Width','Height','FontSize')) { throw 'LAYOUT_PROPERTY_NOT_ALLOWED' }
            $number = $item[$key]
            if (($number -isnot [long] -and $number -isnot [int] -and $number -isnot [double] -and $number -isnot [decimal]) -or
                [double]::IsNaN([double]$number) -or [double]::IsInfinity([double]$number) -or [double]$number -lt 0 -or [double]$number -gt 1000 -or
                ($key -cin @('Width','Height','FontSize') -and [double]$number -eq 0)) { throw 'LAYOUT_NUMBER_OUT_OF_RANGE' }
        }
    }
}

function Get-BarTenderRegistration {
    $key = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey('BarTender.Application/CLSID'.Replace('/','\'))
    if (-not $key) { throw 'BARTENDER_COM_NOT_REGISTERED' }
    try { $classId = [string]$key.GetValue('') } finally { $key.Dispose() }
    $server = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey("CLSID\$classId\LocalServer32")
    if (-not $server) { throw 'BARTENDER_SERVER_NOT_REGISTERED' }
    try { $command = [string]$server.GetValue('') } finally { $server.Dispose() }
    $match = [regex]::Match($command, '^\s*(?:"(?<exe>[^"]+\.exe)"|(?<exe>.*?bartend\.exe))(?:\s|$)', 'IgnoreCase')
    if (-not $match.Success) { throw 'BARTENDER_REGISTERED_PATH_INVALID' }
    $exe = $match.Groups['exe'].Value
    if ([IO.Path]::GetFileName($exe) -ine 'bartend.exe' -or -not [IO.File]::Exists($exe)) { throw 'BARTENDER_REGISTERED_EXE_NOT_FOUND' }
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
    return @{ Path = $exe; ProductVersion = $version.ProductVersion; FileVersion = $version.FileVersion }
}

function Get-BarTenderUnits([string]$Executable) {
    # Read registered vendor type-library constants; do not guess enum numeric values.
    if (-not ('LabOS.BarTenderTypeLibrary' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace LabOS {
  public static class BarTenderTypeLibrary {
    [DllImport("oleaut32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
    static extern void LoadTypeLibEx(string file, int kind, out ITypeLib library);
    public static int Millimeters(string file) {
      ITypeLib library=null;
      try {
        LoadTypeLibEx(file, 2, out library); // REGKIND_NONE: never register or modify Windows.
        for(int i=0;i<library.GetTypeInfoCount();i++) {
          TYPEKIND kind; library.GetTypeInfoType(i,out kind);
          if(kind!=TYPEKIND.TKIND_ENUM) continue;
          ITypeInfo info; library.GetTypeInfo(i,out info);
          IntPtr attr=IntPtr.Zero;
          try {
            info.GetTypeAttr(out attr);
            var type=(TYPEATTR)Marshal.PtrToStructure(attr,typeof(TYPEATTR));
            for(int n=0;n<type.cVars;n++) {
              IntPtr desc=IntPtr.Zero;
              try {
                info.GetVarDesc(n,out desc);
                var variable=(VARDESC)Marshal.PtrToStructure(desc,typeof(VARDESC));
                string name,doc,help; int context;
                info.GetDocumentation(variable.memid,out name,out doc,out context,out help);
                if(name=="btUnitsMillimeters") return Convert.ToInt32(Marshal.GetObjectForNativeVariant(variable.desc.lpvarValue));
              } finally { if(desc!=IntPtr.Zero) info.ReleaseVarDesc(desc); }
            }
          } finally { if(attr!=IntPtr.Zero) info.ReleaseTypeAttr(attr); Marshal.ReleaseComObject(info); }
        }
        throw new InvalidOperationException("BARTENDER_MILLIMETERS_ENUM_NOT_FOUND");
      } finally { if(library!=null) Marshal.ReleaseComObject(library); }
    }
  }
}
'@
    }
    return [LabOS.BarTenderTypeLibrary]::Millimeters($Executable)
}

function Assert-Supervisor($Request) {
    if ($Request.Contains('supervisorId')) {
        $supervisor = Get-Process -Id $Request.supervisorId -ErrorAction SilentlyContinue
        if (-not $supervisor -or $supervisor.StartTime.ToUniversalTime().Ticks -ne $Request.supervisorStartTicks) { throw 'STATION_SUPERVISOR_EXITED' }
    }
}

function Invoke-BarTenderEngine($Request, [scriptblock]$Factory, [scriptblock]$PrintRecord) {
    $application = $null; $format = $null; $owned = $false; $attempted = $false
    $count = 0; $stage = 'COM_CREATE'
    try {
        Assert-Supervisor $Request
        $existing = @(Get-Process -Name bartend -ErrorAction SilentlyContinue | ForEach-Object Id)
        if ($Factory) { $application = & $Factory } else { $application = New-Object -ComObject BarTender.Application }
        $engineId = [int]$application.ProcessID
        if ($engineId -le 0 -or $engineId -in $existing) { throw 'BARTENDER_SHARED_PROCESS_REFUSED' }
        $owned = $true
        if (-not $Factory) {
            $engine = Get-Process -Id $engineId -ErrorAction Stop
            Write-AtomicText $Request.progressPath (ConvertTo-Json @{pid=$engineId;startTicks=$engine.StartTime.ToUniversalTime().Ticks;attempted=$false})
        }
        $application.Visible = $false
        $edition = [string]$application.Edition
        if ($edition -notmatch 'Automation') { throw 'BARTENDER_AUTOMATION_EDITION_REQUIRED' }
        if ($Request.mode -eq 'check') { return @{status='checked';message='COM capability query succeeded';edition=$edition;version=[string]$application.FullVersion} }
        $stage = 'TEMPLATE_OPEN'
        $format = $application.Formats.Open($Request.templatePath, $false, '')
        if ($Request.mode -eq 'derive') {
            $stage = 'TEMPLATE_LAYOUT'
            Assert-Layout $Request.layout
            $format.MeasurementUnits = if ($Factory) { 3 } else { Get-BarTenderUnits (Get-BarTenderRegistration).Path }
            foreach ($item in $Request.layout.objects) {
                $object = $format.Objects.Find($item.name)
                if (-not $object) { throw 'LAYOUT_OBJECT_NOT_FOUND' }
                foreach ($key in $item.Keys) { if ($key -cne 'name') { $object.$key = $item[$key] } }
            }
            $stage = 'TEMPLATE_SAVE_AS'
            $format.SaveAs($Request.outputPath, $false)
            return @{status='derived';message='BarTender SaveAs completed; inspect and calibrate before printing'}
        }
        $job = $Request.job
        $stage = 'FIELD_PREFLIGHT'
        foreach ($field in $job.template.fields) { $stage = 'FIELD_PREFLIGHT_' + $field; [void]$format.GetNamedSubStringValue($field) }
        $stage = 'PRINT_SETUP'
        $format.Printer = $job.printerName
        if ([string]$format.Printer -cne $job.printerName) { throw 'BARTENDER_PRINTER_SUBSTITUTION_REFUSED' }
        $format.UseDatabase = $false
        $format.EnablePrompting = $false
        $format.SelectRecordsAtPrint = $false
        $format.AutoPrintAgain = $false
        $format.PrintToFile = $false
        $format.IdenticalCopiesOfLabel = 1
        $format.NumberSerializedLabels = 1
        foreach ($row in $job.rows) {
            $stage = 'FIELD_ASSIGN'
            foreach ($field in $job.template.fields) { $stage = 'FIELD_ASSIGN_' + $field; $format.SetNamedSubStringValue($field, $row[$field]) }
            if ('Code' -cin $job.template.fields -and [string]$format.GetNamedSubStringValue('Code') -cne $row.Code) { throw 'BARTENDER_CODE_CHANGED' }
            if ('QRPayload' -cin $job.template.fields -and [string]$format.GetNamedSubStringValue('QRPayload') -cne $row.QRPayload) { throw 'BARTENDER_QR_CHANGED' }
            $stage = 'PRINT'
            Assert-Supervisor $Request
            $attempted = $true
            if (-not $Factory) { Write-AtomicText $Request.progressPath (ConvertTo-Json @{pid=$engineId;startTicks=$engine.StartTime.ToUniversalTime().Ticks;attempted=$true}) }
            if ($PrintRecord) { $result = & $PrintRecord $format $row } else {
                $messages = $null
                $result = $format.Print(('LabOS-' + $job.id), $true, 30000, [ref]$messages)
            }
            if ([int]$result -ne 0) { return @{status='unknown';message=('ENGINE_RESULT_' + [int]$result + '; submitted records before interruption: ' + $count)} }
            $count++
        }
        return @{status='submitted';message=('Engine returned success for ' + $count + ' records; physical output is not confirmed')}
    } catch {
        $status = if ($attempted) { 'unknown' } else { 'failed' }
        # Never return raw COM errors: they may contain label data, paths or database credentials.
        return @{status=$status;message=($stage + '_ERROR_' + ('{0:X8}' -f ($_.Exception.HResult -band 0xffffffffL)))}
    } finally {
        if ($owned) {
            if ($format) { try { $format.Close(1) } catch {} }
            try { $application.Quit(1) } catch {}
        }
        foreach ($value in @($format, $application)) { if ($value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($value) } }
    }
}

function Invoke-EngineWorker($Request, [string]$Directory) {
    $requestPath = Join-Path $Directory 'engine-request.dpapi'
    $resultPath = Join-Path $Directory 'engine-result.dpapi'
    $progressPath = Join-Path $Directory 'engine-progress.json'
    foreach ($path in @($requestPath,$resultPath,$progressPath)) { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
    $Request.progressPath = $progressPath
    $Request.resultPath = $resultPath
    $Request.workerLockPath = Join-Path $Directory 'engine.lock'
    $Request.supervisorId = $PID
    $Request.supervisorStartTicks = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks
    Save-ProtectedJson $requestPath $Request
    $start = [Diagnostics.ProcessStartInfo]::new((Get-Command pwsh -ErrorAction Stop).Source)
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($arg in @('-NoProfile','-NonInteractive','-STA','-File',$script:AgentScriptPath,'-WorkerRequest',$requestPath)) { $start.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    try {
        if (-not $process.WaitForExit(1200000)) {
            $process.Kill($true)
            if ([IO.File]::Exists($progressPath)) {
                $progress = ConvertFrom-Json ([IO.File]::ReadAllText($progressPath)) -AsHashtable
                $engine = Get-Process -Id $progress.pid -ErrorAction SilentlyContinue
                if ($engine -and $engine.ProcessName -ieq 'bartend' -and $engine.StartTime.ToUniversalTime().Ticks -eq $progress.startTicks) { $engine.Kill() }
            }
            return @{status='unknown';message='ENGINE_PROCESS_TIMEOUT; no automatic retry'}
        }
        [void]$stdout.GetAwaiter().GetResult(); [void]$stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -or -not [IO.File]::Exists($resultPath)) { return @{status='unknown';message='ENGINE_PROCESS_INTERRUPTED; no automatic retry'} }
        return Read-ProtectedJson $resultPath
    } finally {
        $process.Dispose()
        foreach ($path in @($requestPath,$resultPath,$progressPath)) { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
    }
}

function Invoke-StationApi($Configuration, [string]$Path, $Body) {
    try {
        $response = Invoke-WebRequest -Method Post -Uri ($Configuration.serverUrl + '/api/printing/agent' + $Path) -Headers @{Authorization=('Bearer ' + $Configuration.token)} -ContentType 'application/json' -Body (ConvertTo-Json -InputObject $Body -Depth 5 -Compress) -TimeoutSec 30 -MaximumRedirection 0
        return ConvertFrom-Json $response.Content -AsHashtable
    } catch { throw 'STATION_API_UNAVAILABLE_OR_REJECTED; verify network, trusted HTTPS certificate and station token' }
}

function Complete-StationJournal($Configuration, [string]$Path, $Journal, [scriptblock]$Api) {
    $response = & $Api $Configuration ('/jobs/' + $Journal.jobId + '/result') @{leaseToken=$Journal.leaseToken;status=$Journal.result.status;message=$Journal.result.message}
    if (-not $response.ok) { throw 'RESULT_NOT_ACKNOWLEDGED' }
    [IO.File]::Delete($Path)
}

function Invoke-StationCycle($Configuration, [string]$Directory, [scriptblock]$Api, [scriptblock]$Engine, [scriptblock]$PrinterCheck) {
    $journalPath = Join-Path $Directory 'journal.dpapi'
    if ([IO.File]::Exists($journalPath)) {
        $journal = Read-ProtectedJson $journalPath
        if (-not $journal.Contains('result')) {
            $journal.result = @{status='unknown';message='STATION_RECOVERY; verify physical labels before creating a new job'}
            Save-ProtectedJson $journalPath $journal
        }
        Complete-StationJournal $Configuration $journalPath $journal $Api
        return 'recovered'
    }
    $response = & $Api $Configuration '/claim' @{agentVersion=$script:AgentVersion}
    if (-not $response.job) { return 'idle' }
    $job = $response.job
    if ([string]$job.id -notmatch '^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$' -or $job.leaseToken -isnot [string]) { throw 'SERVER_RETURNED_INVALID_JOB_ID' }
    $journal = @{jobId=$job.id;leaseToken=$job.leaseToken;stage='claimed'}
    Save-ProtectedJson $journalPath $journal
    try {
        $templatePath = Save-TemplateCache $job $Directory
        & $PrinterCheck $job.printerName
    } catch {
        $code = if ($_.Exception.Message -cmatch '^[A-Z][A-Z0-9_]{1,79}$') { $_.Exception.Message } else { 'CHECK_TEMPLATE_LEASE_AND_INSTALLED_PRINTER' }
        $journal.result = @{status='failed';message=('PREFLIGHT_REJECTED_' + $code)}
        Save-ProtectedJson $journalPath $journal
        Complete-StationJournal $Configuration $journalPath $journal $Api
        return 'failed'
    }
    $journal.stage = 'start-requested'
    Save-ProtectedJson $journalPath $journal
    try {
        $started = & $Api $Configuration ('/jobs/' + $job.id + '/start') @{leaseToken=$job.leaseToken}
        if (-not $started.ok -or $started.status -cne 'printing') { throw 'START_NOT_ACKNOWLEDGED' }
    } catch {
        $journal.result = @{status='unknown';message='START_NOT_ACKNOWLEDGED; no print was attempted by this station'}
        Save-ProtectedJson $journalPath $journal
        Complete-StationJournal $Configuration $journalPath $journal $Api
        return 'unknown'
    }
    $journal.stage = 'printing'
    Save-ProtectedJson $journalPath $journal
    try {
        $journal.result = & $Engine @{mode='print';job=$job;templatePath=$templatePath} $Directory
        if ($journal.result.status -cnotin @('submitted','failed','unknown')) { throw 'ENGINE_RESULT_INVALID' }
    } catch { $journal.result = @{status='unknown';message='ENGINE_INTERRUPTED; no automatic retry'} }
    Save-ProtectedJson $journalPath $journal
    Complete-StationJournal $Configuration $journalPath $journal $Api
    return $journal.result.status
}

if ($Library) { return }
if (-not $IsWindows) { throw 'This printing station requires Windows and PowerShell 7.' }
if ($WorkerRequest) {
    $request = Read-ProtectedJson $WorkerRequest
    $workerLock = [IO.File]::Open($request.workerLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $result = Invoke-BarTenderEngine $request
        Save-ProtectedJson $request.resultPath $result
    } finally { $workerLock.Dispose() }
    return
}
$RuntimeDirectory = [IO.Path]::GetFullPath($RuntimeDirectory)
Protect-RuntimeDirectory $RuntimeDirectory
$lock = $null
try {
    try { $lock = [IO.File]::Open((Join-Path $RuntimeDirectory 'station.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch { throw 'Another station process is using this runtime directory.' }
    try { $probe = [IO.File]::Open((Join-Path $RuntimeDirectory 'engine.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); $probe.Dispose() } catch { throw 'A previous dedicated engine worker is still running. Wait for it to finish; do not create another print job.' }
    $configPath = Join-Path $RuntimeDirectory 'station.dpapi'
    if ($ArchivePending) {
        $pendingPath = Join-Path $RuntimeDirectory 'journal.dpapi'
        if (-not $AcknowledgeUnconfirmedOutput -or -not $Reason -or $Reason.Trim().Length -lt 8 -or -not [IO.File]::Exists($pendingPath)) { throw 'Review the web job and physical labels first, then pass -ArchivePending -JobId ID -Reason REASON -AcknowledgeUnconfirmedOutput. This never reprints or changes server state.' }
        $pending = Read-ProtectedJson $pendingPath
        if ($JobId -cne $pending.jobId) { throw 'JobId does not match the pending journal.' }
        $pending.archiveReason = $Reason.Trim()
        $pending.archivedAt = [DateTimeOffset]::UtcNow.ToString('o')
        $archivePath = Join-Path $RuntimeDirectory ('archived-' + $pending.jobId + '-' + [Guid]::NewGuid().ToString('N') + '.dpapi')
        Save-ProtectedJson $archivePath $pending
        [IO.File]::Delete($pendingPath)
        Write-Output 'Local journal archived. No print was attempted and server state was not changed.'
        return
    }
    if ($Initialize) {
        $origin = Assert-StationUrl $ServerUrl
        if (-not $Station -or -not $Station.Trim()) { throw 'A station display name is required.' }
        if ([IO.File]::Exists($configPath)) { throw 'Station already initialized; use a new runtime directory or remove only station.dpapi deliberately before reinitializing.' }
        $token = Read-Host 'Paste the station token (hidden; not saved in shell history)' -AsSecureString
        $pointer = [IntPtr]::Zero
        try {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token)
            $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            if ($plain.Length -lt 24 -or $plain.Length -gt 512 -or $plain -match '\s') { throw 'Invalid station token length or whitespace.' }
            Save-ProtectedJson $configPath @{serverUrl=$origin;station=$Station;token=$plain}
        } finally { if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }; $token.Dispose(); $plain=$null }
        Write-Output 'Station configured for the current Windows user. Token is protected by Windows DPAPI.'
        return
    }
    if ($Check -or $CheckEngine) {
        $registration = Get-BarTenderRegistration
        [pscustomobject]@{BarTenderPath=$registration.Path;ProductVersion=$registration.ProductVersion;FileVersion=$registration.FileVersion;PowerShell=$PSVersionTable.PSVersion.ToString();Edition='Not queried; use -CheckEngine to start an isolated COM instance without printing'}
        Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus
        if ($CheckEngine) { [pscustomobject](Invoke-EngineWorker @{mode='check'} $RuntimeDirectory) }
        return
    }
    if ($DeriveTemplate) {
        $master = [IO.Path]::GetFullPath($MasterTemplate)
        $output = [IO.Path]::GetFullPath($OutputTemplate)
        if (-not [IO.File]::Exists($master) -or ([IO.FileInfo]$master).Length -lt 1 -or [IO.Path]::GetExtension($master) -ine '.btw' -or [IO.Path]::GetExtension($output) -ine '.btw' -or [IO.File]::Exists($output) -or $master -ieq $output) { throw 'Supply a nonempty .btw master and a new .btw output path; existing output is never overwritten.' }
        $layoutValue = ConvertFrom-Json ([IO.File]::ReadAllText([IO.Path]::GetFullPath($Layout))) -AsHashtable
        Assert-Layout $layoutValue
        $result = Invoke-EngineWorker @{mode='derive';templatePath=$master;outputPath=$output;layout=$layoutValue} $RuntimeDirectory
        [pscustomobject]$result
        if ($result.status -cne 'derived') { throw 'Template derivation failed. The master was not saved.' }
        return
    }
    if (-not [IO.File]::Exists($configPath)) { throw 'Run -Initialize -ServerUrl https://your-server:8443 -Station YOUR_STATION first.' }
    $configuration = Read-ProtectedJson $configPath
    $configuration.serverUrl = Assert-StationUrl $configuration.serverUrl
    do {
        try {
            $outcome = Invoke-StationCycle $configuration $RuntimeDirectory ${function:Invoke-StationApi} ${function:Invoke-EngineWorker} ${function:Assert-Printer}
            if ($outcome -ne 'idle') { Write-Output ('Station result: ' + $outcome + '. This does not confirm physical output.') }
        } catch {
            Write-Warning 'Station paused: pending results are retained. Check server, token, printer and trusted HTTPS. No automatic reprint.'
            $pendingPath = Join-Path $RuntimeDirectory 'journal.dpapi'
            if ([IO.File]::Exists($pendingPath)) { try { $pending=Read-ProtectedJson $pendingPath; Write-Warning ('Pending job: ' + $pending.jobId + '. Review this job before explicitly archiving a rejected or expired receipt.') } catch {} }
            if ($Once) { throw 'Station cycle could not complete; journal retained.' }
        }
        if (-not $Once) { Start-Sleep -Seconds 5 }
    } while (-not $Once)
} finally { if ($lock) { $lock.Dispose() } }
