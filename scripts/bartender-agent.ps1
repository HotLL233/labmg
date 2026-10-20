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
    [switch]$Console,
    [switch]$InstallStartup,
    [switch]$UninstallStartup,
    [switch]$StopBackground,
    [switch]$Background,
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
$script:AgentVersion = '0.8.2'
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
    if ($Job.Contains('kind') -and $Job.kind -cnotin @('print','preview')) { throw 'JOB_KIND_INVALID' }
    if ($Job.Contains('kind') -and $Job.kind -ceq 'preview' -and $Job.rows.Count -ne 1) { throw 'PREVIEW_REQUIRES_ONE_UNIT' }
    if ($Job.Contains('paper') -and $null -ne $Job.paper) { Assert-Paper $Job.paper }
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
    if ($Value -isnot [Collections.IDictionary] -or @($Value.Keys | Where-Object { $_ -cnotin @('objects','paper') }).Count -gt 0 -or $Value.objects -isnot [array] -or $Value.objects.Count -gt 100 -or ($Value.objects.Count -lt 1 -and (-not $Value.Contains('paper') -or $null -eq $Value.paper))) { throw 'LAYOUT_OBJECTS_REQUIRED' }
    if ($Value.Contains('paper') -and $null -ne $Value.paper) { Assert-Paper $Value.paper }
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

function Assert-Paper($Paper) {
    if ($Paper -isnot [Collections.IDictionary] -or @($Paper.Keys).Count -ne 3 -or $Paper.orientation -cnotin @('portrait','landscape')) { throw 'PAPER_SETTINGS_INVALID' }
    foreach ($key in @('widthMm','heightMm')) {
        if (-not $Paper.Contains($key)) { throw 'PAPER_SETTINGS_INVALID' }
        $value = $Paper[$key]
        if (($value -isnot [int] -and $value -isnot [long] -and $value -isnot [double] -and $value -isnot [decimal]) -or
            [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value) -or [double]$value -lt 5 -or [double]$value -gt 300 -or [Math]::Abs([double]$value - [Math]::Round([double]$value,3)) -gt 0.0000001) { throw 'PAPER_DIMENSION_OUT_OF_RANGE' }
    }
    if (($Paper.orientation -ceq 'portrait' -and $Paper.widthMm -gt $Paper.heightMm) -or ($Paper.orientation -ceq 'landscape' -and $Paper.widthMm -lt $Paper.heightMm)) { throw 'PAPER_ORIENTATION_DIMENSION_MISMATCH' }
}

function Invoke-BarTenderDimension($Page, [string]$Name, [double]$Value, [switch]$Set) {
    if ($Set) { [void]$Page.GetType().InvokeMember($Name, [Reflection.BindingFlags]::SetProperty, $null, $Page, @([int]3,[single]$Value)); return }
    return [double]$Page.GetType().InvokeMember($Name, [Reflection.BindingFlags]::GetProperty, $null, $Page, @([int]3))
}

function Apply-BarTenderPaper($Format, $Paper) {
    Assert-Paper $Paper
    $page = $Format.PageSetup
    # X/Y use configurable object reference points, so guessing bounds could silently crop a label.
    if ((Invoke-BarTenderDimension $page 'LabelWidth') -gt ([double]$Paper.widthMm + 0.05) -or
        (Invoke-BarTenderDimension $page 'LabelHeight') -gt ([double]$Paper.heightMm + 0.05)) { throw 'PAPER_REQUIRES_MATCHING_NATIVE_TEMPLATE' }
    $page.Orientation = if ($Paper.orientation -ceq 'portrait') { 0 } else { 1 }
    $page.LabelRows = 1; $page.LabelColumns = 1
    $page.LabelSizeManual = $true; $page.LabelGapManual = $true
    foreach ($name in @('MarginTop','MarginBottom','MarginLeft','MarginRight','LabelGapHorizontal','LabelGapVertical')) { Invoke-BarTenderDimension $page $name 0 -Set }
    Invoke-BarTenderDimension $page 'PaperWidth' $Paper.widthMm -Set
    Invoke-BarTenderDimension $page 'PaperHeight' $Paper.heightMm -Set
    Invoke-BarTenderDimension $page 'LabelWidth' $Paper.widthMm -Set
    Invoke-BarTenderDimension $page 'LabelHeight' $Paper.heightMm -Set
    if (-not $page.Valid -or $page.Orientation -ne $(if ($Paper.orientation -ceq 'portrait') { 0 } else { 1 })) { throw 'PAPER_SETUP_INVALID_OR_CHANGED' }
    foreach ($name in @('PaperWidth','LabelWidth','PaperHeight','LabelHeight')) {
        $expected = if ($name.EndsWith('Width')) { $Paper.widthMm } else { $Paper.heightMm }
        if ([Math]::Abs((Invoke-BarTenderDimension $page $name) - $expected) -gt 0.05) { throw 'PAPER_DRIVER_CHANGED_REQUESTED_DIMENSIONS' }
    }
}

function Read-PreviewPng([string]$Path) {
    if (-not [IO.File]::Exists($Path) -or ([IO.FileInfo]$Path).Length -lt 33 -or ([IO.FileInfo]$Path).Length -gt 2MB) { throw 'PREVIEW_FILE_MISSING_OR_TOO_LARGE' }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ([Convert]::ToHexString($bytes[0..15]) -cne '89504E470D0A1A0A0000000D49484452' -or
        [Convert]::ToHexString($bytes[($bytes.Length-12)..($bytes.Length-1)]) -cne '0000000049454E44AE426082') { throw 'PREVIEW_PNG_HEADER_INVALID' }
    $width = [long]$bytes[16]*16777216 + [long]$bytes[17]*65536 + [long]$bytes[18]*256 + $bytes[19]
    $height = [long]$bytes[20]*16777216 + [long]$bytes[21]*65536 + [long]$bytes[22]*256 + $bytes[23]
    if ($width -lt 1 -or $width -gt 4096 -or $height -lt 1 -or $height -gt 4096) { throw 'PREVIEW_DIMENSIONS_OUT_OF_RANGE' }
    return [Convert]::ToBase64String($bytes)
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
    public static int Value(string file, string constant) {
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
                if(String.Equals(name,constant,StringComparison.OrdinalIgnoreCase)) return Convert.ToInt32(Marshal.GetObjectForNativeVariant(variable.desc.lpvarValue));
              } finally { if(desc!=IntPtr.Zero) info.ReleaseVarDesc(desc); }
            }
          } finally { if(attr!=IntPtr.Zero) info.ReleaseTypeAttr(attr); Marshal.ReleaseComObject(info); }
        }
        throw new InvalidOperationException("BARTENDER_ENUM_NOT_FOUND");
      } finally { if(library!=null) Marshal.ReleaseComObject(library); }
    }
  }
}
'@
    }
    return [LabOS.BarTenderTypeLibrary]::Value($Executable, 'btUnitsMillimeters')
}

function Assert-Supervisor($Request) {
    if ($Request.Contains('supervisorId')) {
        $supervisor = Get-Process -Id $Request.supervisorId -ErrorAction SilentlyContinue
        if (-not $supervisor -or $supervisor.StartTime.ToUniversalTime().Ticks -ne $Request.supervisorStartTicks) { throw 'STATION_SUPERVISOR_EXITED' }
    }
}

function Get-BarTenderWindowProcessId($Application) {
    $window = $null
    try {
        $window = $Application.GetType().InvokeMember('Window', [Reflection.BindingFlags]::GetProperty, $null, $Application, $null)
        $handle = $window.GetType().InvokeMember('Handle', [Reflection.BindingFlags]::GetProperty, $null, $window, $null)
        if (-not $handle) { return 0 }
        if (-not ('LabOS.BarTenderWindow' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace LabOS { public static class BarTenderWindow {
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  public static int ProcessId(long handle) { uint process; GetWindowThreadProcessId(new IntPtr(handle),out process); return checked((int)process); }
} }
'@
        }
        return [LabOS.BarTenderWindow]::ProcessId([long]$handle)
    } catch { return 0 }
    finally { if ($window -and [Runtime.InteropServices.Marshal]::IsComObject($window)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($window) } }
}

function Get-BarTenderProcessMetadata([int]$EngineId) {
    $process = Get-Process -Id $EngineId -ErrorAction Stop
    $native = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $EngineId) -ErrorAction Stop
    $owner = Invoke-CimMethod -InputObject $native -MethodName GetOwnerSid -ErrorAction Stop
    return @{id=$process.Id;name=$process.ProcessName;path=[string]$native.ExecutablePath;session=$process.SessionId;sid=[string]$owner.Sid;started=$process.StartTime.ToUniversalTime()}
}

function Get-BarTenderEngineIdentity($Application, [int[]]$Existing, [DateTime]$RequestedAt, [string]$RegisteredPath) {
    $engineId = 0
    try {
        $engineId = if ([Runtime.InteropServices.Marshal]::IsComObject($Application)) {
            [int]$Application.GetType().InvokeMember('ProcessId', [Reflection.BindingFlags]::GetProperty, $null, $Application, $null)
        } else { [int]$Application.ProcessId }
    } catch {}
    $windowId = Get-BarTenderWindowProcessId $Application
    if ($engineId -gt 0 -and $windowId -gt 0 -and $engineId -ne $windowId) { throw 'BARTENDER_PROCESS_AND_WINDOW_DISAGREE' }
    if ($engineId -le 0) { $engineId = $windowId }
    if ($engineId -le 0) { throw 'BARTENDER_PROCESS_ID_UNAVAILABLE_CHECK_LICENSE_AND_COM' }
    if ($engineId -in $Existing) { throw 'BARTENDER_SHARED_PROCESS_REFUSED' }
    $identity = Get-BarTenderProcessMetadata $engineId
    if ($identity.id -ne $engineId -or $identity.name -ine 'bartend' -or $identity.path -ine $RegisteredPath -or
        $identity.sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
        $identity.session -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or
        $identity.started -lt $RequestedAt.AddSeconds(-1) -or $identity.started -gt [DateTime]::UtcNow.AddSeconds(1)) { throw 'BARTENDER_PROCESS_IDENTITY_NOT_PROVEN' }
    return $identity
}

function Invoke-BarTenderEngine($Request, [scriptblock]$Factory, [scriptblock]$PrintRecord) {
    $application = $null; $format = $null; $owned = $false; $attempted = $false
    $count = 0; $stage = 'COM_CREATE'
    try {
        Assert-Supervisor $Request
        $existing = @(Get-Process -Name bartend -ErrorAction SilentlyContinue | ForEach-Object Id)
        $registeredPath = if ($Factory) { 'MOCK-ONLY-BARTEND.EXE' } else { (Get-BarTenderRegistration).Path }
        $requestedAt = [DateTime]::UtcNow
        if ($Factory) { $application = & $Factory } else { $application = New-Object -ComObject BarTender.Application }
        $stage = 'COM_IDENTITY'
        $identity = Get-BarTenderEngineIdentity $application $existing $requestedAt $registeredPath
        $engineId = $identity.id
        $owned = $true
        if (-not $Factory) {
            Write-AtomicText $Request.progressPath (ConvertTo-Json @{pid=$engineId;startTicks=$identity.started.Ticks;attempted=$false})
        }
        $application.Visible = $false
        $stage = 'COM_LICENSE'
        $edition = [string]$application.Edition
        if ($edition -notmatch 'Automation') { throw 'BARTENDER_AUTOMATION_EDITION_REQUIRED' }
        if ($Request.mode -eq 'check') { return @{status='checked';message='COM capability query succeeded';edition=$edition;version=[string]$application.FullVersion} }
        $stage = 'TEMPLATE_OPEN'
        $format = $application.Formats.Open($Request.templatePath, $false, '')
        if ($Request.mode -eq 'derive') {
            $stage = 'TEMPLATE_LAYOUT'
            Assert-Layout $Request.layout
            $format.MeasurementUnits = if ($Factory) { 3 } else { Get-BarTenderUnits (Get-BarTenderRegistration).Path }
            if ($Request.layout.Contains('paper') -and $null -ne $Request.layout.paper) { Apply-BarTenderPaper $format $Request.layout.paper }
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
        if ($job.Contains('paper') -and $null -ne $job.paper) {
            $stage = 'PAPER_SETUP'
            Apply-BarTenderPaper $format $job.paper
        }
        foreach ($row in $job.rows) {
            $stage = 'FIELD_ASSIGN'
            foreach ($field in $job.template.fields) { $stage = 'FIELD_ASSIGN_' + $field; $format.SetNamedSubStringValue($field, $row[$field]) }
            if ('Code' -cin $job.template.fields -and [string]$format.GetNamedSubStringValue('Code') -cne $row.Code) { throw 'BARTENDER_CODE_CHANGED' }
            if ('QRPayload' -cin $job.template.fields -and [string]$format.GetNamedSubStringValue('QRPayload') -cne $row.QRPayload) { throw 'BARTENDER_QR_CHANGED' }
            if ($job.Contains('kind') -and $job.kind -ceq 'preview') {
                $stage = 'NATIVE_TEMPLATE_PREVIEW'
                Assert-Supervisor $Request
                if (-not $Request.Contains('previewPath') -or [IO.File]::Exists($Request.previewPath)) { throw 'PREVIEW_OUTPUT_PATH_INVALID' }
                $colors = if ($Factory) { 4 } else { [void](Get-BarTenderUnits (Get-BarTenderRegistration).Path); [LabOS.BarTenderTypeLibrary]::Value((Get-BarTenderRegistration).Path,'btColors24Bit') }
                # Automation supports template images. This is not Enterprise PrintPreview and never invokes Print.
                $format.ExportToFile($Request.previewPath, 'PNG', $colors, 150, 1)
                return @{status='submitted';message='NATIVE_TEMPLATE_PREVIEW; template image only; NOT_PHYSICAL_PRINT_OR_ENTERPRISE_PRINT_PREVIEW';previewBase64=(Read-PreviewPng $Request.previewPath)}
            }
            $stage = 'PRINT'
            Assert-Supervisor $Request
            $attempted = $true
            if (-not $Factory) { Write-AtomicText $Request.progressPath (ConvertTo-Json @{pid=$engineId;startTicks=$identity.started.Ticks;attempted=$true}) }
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
        $code = if ($_.Exception.Message -cmatch '^[A-Z][A-Z0-9_]{1,79}$') { $_.Exception.Message } else { 'ERROR_' + ('{0:X8}' -f ($_.Exception.HResult -band 0xffffffffL)) }
        return @{status=$status;message=($stage + '_' + $code)}
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
    $previewPath = Join-Path $Directory ('native-preview-' + [Guid]::NewGuid().ToString('N') + '.png')
    $Request.previewPath = $previewPath
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
        foreach ($path in @($requestPath,$resultPath,$progressPath,$previewPath)) { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
    }
}

function Invoke-StationApi($Configuration, [string]$Path, $Body) {
    try {
        $response = Invoke-WebRequest -Method Post -Uri ($Configuration.serverUrl + '/api/printing/agent' + $Path) -Headers @{Authorization=('Bearer ' + $Configuration.token)} -ContentType 'application/json' -Body (ConvertTo-Json -InputObject $Body -Depth 5 -Compress) -TimeoutSec 30 -MaximumRedirection 0
        return ConvertFrom-Json $response.Content -AsHashtable
    } catch {
        $response = $_.Exception.PSObject.Properties['Response']
        if ($response -and $response.Value) {
            $status = [int]$response.Value.StatusCode
            switch ($status) {
                401 { throw 'STATION_HTTP_401; 站点令牌无效或已更换，请核对网页站点及本机配置。' }
                403 { throw 'STATION_HTTP_403; 站点被停用或没有操作权限，请检查网页打印站。' }
                409 { throw 'STATION_HTTP_409; 任务状态或租约已改变，请先核对网页任务和待回执，勿重复打印。' }
                { $_ -ge 300 -and $_ -lt 400 } { throw 'STATION_REDIRECT_REFUSED; 地址发生重定向，请使用系统最终 HTTPS 地址。' }
                default { throw ('STATION_HTTP_' + $status + '; 服务器拒绝请求，请检查服务状态和版本。') }
            }
        }
        throw 'STATION_CONNECTION_FAILED; 无法连接服务器，请检查地址、网络和 Windows 对 HTTPS 根证书的信任。'
    }
}

function Get-StationDiagnostic($Failure) {
    $message = [string]$Failure.Exception.Message
    # Only our controlled errors are shown; raw transport/COM errors can contain credentials or label data.
    if ($message -match '^STATION_[A-Z0-9_]+; [^\r\n]{1,200}$' -or
        $message -match '^[A-Z][A-Z0-9_]{1,79}$') { return $message }
    if ($message.StartsWith('Run -Initialize ')) { return '尚未初始化打印站。请在菜单选择 2，填写系统 HTTPS 地址、站点名称，并粘贴一次性令牌。' }
    if ($message.StartsWith('Station already initialized;')) { return '打印站已经初始化；保留原运行目录直接启动即可。更换令牌前请先核对未完成任务。' }
    if ($message.StartsWith('Another station process')) { return '此运行目录已有助手运行；请在原窗口查看结果，不要重复启动。' }
    if ($message.StartsWith('A previous dedicated engine worker')) { return '上一个专用引擎仍在运行；请先等待并核对任务状态。' }
    if ($message.StartsWith('ServerUrl must be')) { return '系统地址必须是 HTTPS 的源地址（含实际端口，不含路径）。仅 localhost 开发允许 HTTP。' }
    if ($message -eq 'A station display name is required.') { return '请填写打印站名称。' }
    if ($message -eq 'Invalid station token length or whitespace.') { return '令牌格式有误，请粘贴网页新建或更换打印站时显示的完整令牌。' }
    return ('本机检查或配置失败；错误代码 0x' + ('{0:X8}' -f ($Failure.Exception.HResult -band 0xffffffffL)) + '。请核对运行目录权限、PowerShell 7、BarTender 安装和打印机。')
}

function Write-StationLog([string]$Directory, [string]$Event, [string]$Detail = '') {
    if ($Event -cnotmatch '^[A-Z_]{1,50}$') { return }
    try {
        $path = Join-Path $Directory 'agent.log'
        if ([IO.File]::Exists($path) -and ([IO.FileInfo]$path).Length -ge 1MB) { [IO.File]::Move($path, $path + '.1', $true) }
        $line = [DateTimeOffset]::Now.ToString('o') + ' ' + $Event
        if ($Detail) { $line += ' ' + ($Detail -replace '[\x00-\x1f\x7f]',' ').Substring(0,[Math]::Min($Detail.Length,400)) }
        [IO.File]::AppendAllText($path, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    } catch {} # Logging must never turn an acknowledged label into another print attempt.
}

function Get-StartupDefinition([string]$Directory) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $directoryPath = [IO.Path]::GetFullPath($Directory)
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($identity.User.Value + '|' + $directoryPath.ToLowerInvariant()))).Substring(0,16)
    $scriptPath = Join-Path $directoryPath 'agent/bin/bartender-agent.ps1'
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '" -Background -RuntimeDirectory "' + $directoryPath + '"'
    return @{name=('LabOSPrinting-' + $hash);description=('LabOS printing agent; SID=' + $identity.User.Value + '; runtime=' + $directoryPath);user=$identity.Name;sid=$identity.User.Value;executable=(Get-Command pwsh -ErrorAction Stop).Source;arguments=$arguments;script=$scriptPath;directory=$directoryPath}
}

function Get-OwnedStartupTask($Definition) {
    $task = Get-ScheduledTask -TaskName $Definition.name -TaskPath '\' -ErrorAction SilentlyContinue
    if ($task -and ($task.Description -cne $Definition.description -or @($task.Actions).Count -ne 1 -or
        $task.Actions[0].Execute -ine $Definition.executable -or $task.Actions[0].Arguments -cne $Definition.arguments -or
        $task.Principal.UserId -notin @($Definition.user,$Definition.sid))) { throw 'STARTUP_TASK_OWNERSHIP_MISMATCH' }
    return $task
}

function Install-StationStartup([string]$Directory) {
    if (-not [IO.File]::Exists((Join-Path $Directory 'station.dpapi'))) { throw 'Run -Initialize -ServerUrl https://your-server:8443 -Station YOUR_STATION first.' }
    $definition = Get-StartupDefinition $Directory
    [void](Get-OwnedStartupTask $definition)
    $agentDirectory = [IO.Path]::GetDirectoryName($definition.script)
    $ancestor = $agentDirectory
    while ($ancestor -and $ancestor -ine $definition.directory) {
        if ([IO.Directory]::Exists($ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'STARTUP_SCRIPT_DIRECTORY_REPARSE_POINT' }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    [void][IO.Directory]::CreateDirectory($agentDirectory)
    Write-AtomicText $definition.script ([IO.File]::ReadAllText($script:AgentScriptPath))
    $action = New-ScheduledTaskAction -Execute $definition.executable -Argument $definition.arguments -WorkingDirectory $definition.directory
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $definition.user
    $principal = New-ScheduledTaskPrincipal -UserId $definition.user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -DisallowHardTerminate
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $definition.description
    Register-ScheduledTask -TaskName $definition.name -TaskPath '\' -InputObject $task -Force | Out-Null
    Write-StationLog $Directory 'STARTUP_REGISTERED'
    [pscustomobject]@{TaskName=$definition.name;Script=$definition.script;Starts='当前用户下次登录后后台运行；本次没有启动或领取任务。'}
}

function Request-StationBackgroundStop([string]$Directory) {
    Write-AtomicText (Join-Path $Directory 'stop-background') 'Stop after the current cycle; never terminate BarTender.'
    Write-StationLog $Directory 'BACKGROUND_STOP_REQUESTED'
    Write-Output '已请求后台在当前任务回执处理后退出；不会终止 BarTender、重印或删除配置。'
}

function Uninstall-StationStartup([string]$Directory) {
    $definition = Get-StartupDefinition $Directory
    $task = Get-OwnedStartupTask $definition
    Request-StationBackgroundStop $Directory
    if ($task) { Unregister-ScheduledTask -TaskName $definition.name -TaskPath '\' -Confirm:$false }
    Write-StationLog $Directory 'STARTUP_UNREGISTERED'
    Write-Output '已移除当前运行目录的登录后台任务；配置、模板和待回执均保留。'
}

function Start-StationConsole([string]$Directory) {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    Write-Host ('LabOS BarTender 打印助手 ' + $script:AgentVersion)
    Write-Host ('运行目录：' + [IO.Path]::GetFullPath($Directory))
    Write-Host '此菜单不会自动领取任务。首次使用先检查，再初始化。'
    do {
        Write-Host ''
        Write-Host '1  本机检查（不启动 BarTender、不打印）'
        Write-Host '2  初始化打印站（隐藏输入令牌）'
        Write-Host '3  开始领取并打印网页队列（Ctrl+C 停止）'
        Write-Host '4  安装／更新当前用户登录后台（仅登记，下次登录生效）'
        Write-Host '5  请求后台在当前任务后停止'
        Write-Host '6  移除登录后台（保留配置和待回执）'
        Write-Host '0  退出'
        $choice = Read-Host '请选择'
        try {
            switch ($choice) {
                '1' { & $script:AgentScriptPath -Check -RuntimeDirectory $Directory | Format-List | Out-Host }
                '2' {
                    $origin = Read-Host '系统 HTTPS 地址，例如 https://192.168.1.10:8443'
                    $name = Read-Host '网页打印站名称'
                    & $script:AgentScriptPath -Initialize -ServerUrl $origin -Station $name -RuntimeDirectory $Directory | Out-Host
                }
                '3' { & $script:AgentScriptPath -RuntimeDirectory $Directory | Out-Host; return }
                '4' { & $script:AgentScriptPath -InstallStartup -RuntimeDirectory $Directory | Format-List | Out-Host }
                '5' { & $script:AgentScriptPath -StopBackground -RuntimeDirectory $Directory | Out-Host }
                '6' { & $script:AgentScriptPath -UninstallStartup -RuntimeDirectory $Directory | Out-Host }
                '0' { return }
                '' { return }
                default { Write-Host '请输入 0 到 6。' }
            }
        } catch { Write-Host (Get-StationDiagnostic $_) -ForegroundColor Red }
    } while ($true)
}

function Complete-StationJournal($Configuration, [string]$Path, $Journal, [scriptblock]$Api) {
    $body = @{leaseToken=$Journal.leaseToken;status=$Journal.result.status;message=$Journal.result.message}
    if ($Journal.result.Contains('previewBase64')) { $body.previewBase64 = $Journal.result.previewBase64 }
    $response = & $Api $Configuration ('/jobs/' + $Journal.jobId + '/result') $body
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
    if ($response.Contains('blockedReason') -and $response.blockedReason -ceq 'AGENT_UPGRADE_REQUIRED') { throw 'STATION_AGENT_UPGRADE_REQUIRED; 当前任务需要新版打印助手，请下载与服务器配套的 PS1 和 CMD 后更新。' }
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
if ($Console) { Start-StationConsole $RuntimeDirectory; return }
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
if ($InstallStartup) { Install-StationStartup $RuntimeDirectory; return }
if ($UninstallStartup) { Uninstall-StationStartup $RuntimeDirectory; return }
if ($StopBackground) { Request-StationBackgroundStop $RuntimeDirectory; return }
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
        [pscustomobject]@{AgentVersion=$script:AgentVersion;RuntimeDirectory=$RuntimeDirectory;Initialized=[IO.File]::Exists($configPath);PendingReceipt=[IO.File]::Exists((Join-Path $RuntimeDirectory 'journal.dpapi'));BackgroundLog=(Join-Path $RuntimeDirectory 'agent.log')}
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
    $stopPath = Join-Path $RuntimeDirectory 'stop-background'
    if ($Background) {
        if ([IO.File]::Exists($stopPath)) { [IO.File]::Delete($stopPath) }
        Write-StationLog $RuntimeDirectory 'BACKGROUND_STARTED'
    }
    do {
        if ($Background -and [IO.File]::Exists($stopPath)) { Write-StationLog $RuntimeDirectory 'BACKGROUND_STOPPED'; break }
        try {
            $outcome = Invoke-StationCycle $configuration $RuntimeDirectory ${function:Invoke-StationApi} ${function:Invoke-EngineWorker} ${function:Assert-Printer}
            if ($outcome -ne 'idle') { Write-Output ('Station result: ' + $outcome + '. This does not confirm physical output.') }
            if ($Background -and $outcome -cne 'idle') { Write-StationLog $RuntimeDirectory ('CYCLE_' + $outcome.ToUpperInvariant()) }
        } catch {
            if ($Background) { Write-StationLog $RuntimeDirectory 'CYCLE_PAUSED' (Get-StationDiagnostic $_) }
            Write-Warning (Get-StationDiagnostic $_)
            Write-Warning 'Station paused: pending results are retained. Check server, token, printer and trusted HTTPS. No automatic reprint.'
            $pendingPath = Join-Path $RuntimeDirectory 'journal.dpapi'
            if ([IO.File]::Exists($pendingPath)) { try { $pending=Read-ProtectedJson $pendingPath; Write-Warning ('Pending job: ' + $pending.jobId + '. Review this job before explicitly archiving a rejected or expired receipt.') } catch {} }
            if ($Once) { throw 'Station cycle could not complete; journal retained.' }
        }
        if (-not $Once) { Start-Sleep -Seconds 5 }
    } while (-not $Once)
} catch {
    if ($Background) { Write-StationLog $RuntimeDirectory 'BACKGROUND_FAILED' (Get-StationDiagnostic $_) }
    throw
} finally { if ($lock) { $lock.Dispose() } }
