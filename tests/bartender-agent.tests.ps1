#requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/bartender-agent.ps1') -Library
Add-Type -TypeDefinition @'
using System;
using System.Reflection;
using System.Reflection.Emit;
public class LabOSPageValues {
  public bool Valid=true, LabelSizeManual=false, LabelGapManual=false;
  public int Orientation=0, LabelRows=2, LabelColumns=2;
  public float ReadbackDelta=0;
}
public static class LabOSIndexedPageFixture {
  static Type type;
  public static object Create() {
    if(type==null) {
      var assembly=AssemblyBuilder.DefineDynamicAssembly(new AssemblyName("LabOSTestIndexedPage"),AssemblyBuilderAccess.Run);
      var builder=assembly.DefineDynamicModule("Main").DefineType("IndexedPage",TypeAttributes.Public,typeof(LabOSPageValues));
      foreach(string name in new[]{"PaperWidth","PaperHeight","LabelWidth","LabelHeight","MarginTop","MarginBottom","MarginLeft","MarginRight","LabelGapHorizontal","LabelGapVertical"}) {
        var field=builder.DefineField("_"+name,typeof(float),FieldAttributes.Private);
        var property=builder.DefineProperty(name,PropertyAttributes.None,typeof(float),new[]{typeof(int)});
        var getter=builder.DefineMethod("get_"+name,MethodAttributes.Public|MethodAttributes.SpecialName|MethodAttributes.HideBySig,typeof(float),new[]{typeof(int)});
        var get=getter.GetILGenerator(); get.Emit(OpCodes.Ldarg_0); get.Emit(OpCodes.Ldfld,field);
        if(name=="PaperWidth") {get.Emit(OpCodes.Ldarg_0);get.Emit(OpCodes.Ldfld,typeof(LabOSPageValues).GetField("ReadbackDelta"));get.Emit(OpCodes.Add);}
        get.Emit(OpCodes.Ret); property.SetGetMethod(getter);
        var setter=builder.DefineMethod("set_"+name,MethodAttributes.Public|MethodAttributes.SpecialName|MethodAttributes.HideBySig,null,new[]{typeof(int),typeof(float)});
        var set=setter.GetILGenerator();set.Emit(OpCodes.Ldarg_0);set.Emit(OpCodes.Ldarg_2);set.Emit(OpCodes.Stfld,field);set.Emit(OpCodes.Ret);property.SetSetMethod(setter);
      }
      type=builder.CreateType();
    }
    return Activator.CreateInstance(type);
  }
}
'@
$checks = [Collections.Generic.List[string]]::new()
function Assert-True($Value, [string]$Name) { if (-not $Value) { throw ('FAIL: ' + $Name) }; $checks.Add($Name) }
function Assert-Throws([scriptblock]$Action, [string]$Name) { $threw=$false; try { & $Action | Out-Null } catch { $threw=$true }; Assert-True $threw $Name }
function New-TestJob {
    $content = [Text.Encoding]::UTF8.GetBytes('MOCK-ONLY; NOT A BARTENDER TEMPLATE')
    $rows = foreach ($number in 1,2) {
        $row=@{}; foreach($field in $script:LabelFields) { $row[$field]='' }
        $row.Code=('00000'+$number); $row.QRPayload=('labos:unit:00000'+$number); $row.Name='合成测试物资'
        if($number -eq 1) { $row.Location='合成柜 A' }
        $row
    }
    return @{
        id=[Guid]::NewGuid().ToString(); leaseToken='MOCK-ONLY-LEASE-NOT-A-REAL-TOKEN'
        leaseExpiresAt=[DateTimeOffset]::UtcNow.AddMinutes(2).ToString('o')
        printerName='MOCK-ONLY-PRINTER'
        template=@{id=[Guid]::NewGuid().ToString();fileName='mock.btw';sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($content)).ToLowerInvariant();contentBase64=[Convert]::ToBase64String($content);fields=@('Code','QRPayload','Name','Location')}
        rows=@($rows)
    }
}
function New-MockApplication($Fields) {
    $values=@{}; foreach($field in $Fields){$values[$field]='OLD'}
    $page=[LabOSIndexedPageFixture]::Create()
    foreach($name in @('PaperWidth','LabelWidth')){Invoke-BarTenderDimension $page $name 20 -Set}
    foreach($name in @('PaperHeight','LabelHeight')){Invoke-BarTenderDimension $page $name 10 -Set}
    $format=[pscustomobject]@{Values=$values;Printer='';UseDatabase=$true;EnablePrompting=$true;SelectRecordsAtPrint=$true;AutoPrintAgain=$true;PrintToFile=$true;IdenticalCopiesOfLabel=20;NumberSerializedLabels=20;Closed=$false;MeasurementUnits=0;Saved='';Objects=$null;PageSetup=$page;ExportCalled=$false;ExportFails=$false;ExportValues=$null}
    $format | Add-Member ScriptMethod GetNamedSubStringValue {param($name) if(-not $this.Values.ContainsKey($name)){throw 'missing'}; return $this.Values[$name]}
    $format | Add-Member ScriptMethod SetNamedSubStringValue {param($name,$value) $this.Values[$name]=$value}
    $format | Add-Member ScriptMethod Close {param($save) if($save -ne 1){throw 'must not save'}; $this.Closed=$true}
    $format | Add-Member ScriptMethod SaveAs {param($path,$overwrite) if($overwrite){throw 'must not overwrite'}; $this.Saved=$path}
    $format | Add-Member ScriptMethod ExportToFile {
        param($path,$type,$colors,$dpi,$save)
        if($this.ExportFails){throw 'MOCK ONLY sensitive export failure'}
        if($type -cne 'PNG' -or $colors -ne 4 -or $dpi -ne 150 -or $save -ne 1){throw 'wrong export signature'}
        $this.ExportCalled=$true; $this.ExportValues=@{}; foreach($key in $this.Values.Keys){$this.ExportValues[$key]=$this.Values[$key]}
        [IO.File]::WriteAllBytes($path,[Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmRoAAAAASUVORK5CYII='))
    }
    $objects=[pscustomobject]@{Fixture=[pscustomobject]@{X=1;Y=1;Width=2;Height=2;FontSize=8;DoNotPrint=$false}}
    $objects | Add-Member ScriptMethod Find {param($name) if($name -ceq 'Existing'){return $this.Fixture}; return $null}
    $format.Objects=$objects
    $formats=[pscustomobject]@{Format=$format}
    $formats | Add-Member ScriptMethod Open {param($path,$reset,$printer) return $this.Format}
    $app=[pscustomobject]@{ProcessId=2147483645;WindowProcessId=0;Visible=$true;Edition='Automation';FullVersion='MOCK';Formats=$formats;QuitCalled=$false}
    $app | Add-Member ScriptMethod Quit {param($save) if($save -ne 1){throw 'must not save'}; $this.QuitCalled=$true}
    return $app
}
$script:MockProcessOverrides=@{}
function Get-BarTenderWindowProcessId($Application) { return $Application.WindowProcessId }
function Get-BarTenderProcessMetadata([int]$EngineId) {
    $value=@{id=$EngineId;name='bartend';path='MOCK-ONLY-BARTEND.EXE';session=[Diagnostics.Process]::GetCurrentProcess().SessionId;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;started=[DateTime]::UtcNow}
    foreach($key in $script:MockProcessOverrides.Keys){$value[$key]=$script:MockProcessOverrides[$key]}
    return $value
}
$cacheRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts/cache/0.8.2/bartender-agent-tests'))
[void][IO.Directory]::CreateDirectory($cacheRoot)
$testRoot=Join-Path $cacheRoot ([Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
try {
    Assert-True ((Assert-StationUrl 'https://example.invalid:8443') -ceq 'https://example.invalid:8443') 'HTTPS origin accepted'
    Assert-True ((Assert-StationUrl 'http://127.0.0.1:9999') -ceq 'http://127.0.0.1:9999') 'loopback development accepted'
    foreach($url in @('http://192.168.1.2:3000','https://user:pass@example.invalid','https://example.invalid/api','https://example.invalid/?token=secret','https://example.invalid/#token','ftp://localhost')) { Assert-Throws {Assert-StationUrl $url} ('untrusted URL rejected '+$checks.Count) }
    $job=New-TestJob
    Assert-True ((Assert-Job $job).Length -gt 0) 'valid job accepted'
    $job.template.fields=@('QRPayload'); Assert-True ((Assert-Job $job).Length -gt 0) 'QR only template accepted'; $job=New-TestJob
    $job.template.fileName='../escape.btw'; Assert-Throws {Assert-Job $job} 'template traversal rejected'; $job=New-TestJob
    $job.template.contentBase64='!'; Assert-Throws {Assert-Job $job} 'invalid base64 rejected'; $job=New-TestJob
    $job.template.sha256=('0'*64); Assert-Throws {Assert-Job $job} 'template hash mismatch rejected'; $job=New-TestJob
    $job.template.fields=@('Code','Password'); Assert-Throws {Assert-Job $job} 'unknown named source rejected'; $job=New-TestJob
    $job.rows[1].Code=$job.rows[0].Code; Assert-Throws {Assert-Job $job} 'duplicate unit rejected'; $job=New-TestJob
    $job.rows[0].Location=$null; Assert-Throws {Assert-Job $job} 'nonstring field rejected'; $job=New-TestJob
    $job.leaseExpiresAt=[DateTimeOffset]::UtcNow.AddMinutes(-1).ToString('o'); Assert-Throws {Assert-Job $job} 'expired lease rejected'
    Assert-Throws {Assert-Layout @{objects=@(@{name='Existing';Code='replace'})}} 'layout cannot rewrite encoded identity'
    Assert-Throws {Assert-Layout @{objects=@(@{name='Existing';PicturePath='C:\secret'})}} 'layout cannot add external content'
    Assert-Throws {Assert-Layout @{objects=@(@{name='Existing';DoNotPrint='false'})}} 'layout requires boolean'
    Assert-Throws {Assert-Layout @{objects=@(@{name='Existing';Width=0})}} 'layout requires positive dimensions'
    Assert-Layout @{objects=@(@{name='Existing';X=5;Y=7.5;FontSize=9;DoNotPrint=$true})}
    Assert-True $true 'controlled layout accepted'
    $paper=@{widthMm=60;heightMm=40;orientation='landscape'}
    Assert-Paper $paper
    Assert-True $true 'explicit native paper accepted'
    Assert-Throws {Assert-Paper @{widthMm=60;heightMm=40;orientation='portrait'}} 'orientation must match actual width and height'
    Assert-Throws {Assert-Paper @{widthMm='60';heightMm=40;orientation='landscape'}} 'paper requires numeric values'
    Assert-Throws {Assert-Paper @{widthMm=60.0001;heightMm=40;orientation='landscape'}} 'paper limits precision to three decimals'
    Assert-Throws {Assert-Paper @{widthMm=301;heightMm=40;orientation='landscape'}} 'paper bounds enforced'
    $app=New-MockApplication @('Code');Apply-BarTenderPaper $app.Formats.Format $paper
    Assert-True ((Invoke-BarTenderDimension $app.Formats.Format.PageSetup 'PaperWidth') -eq 60 -and (Invoke-BarTenderDimension $app.Formats.Format.PageSetup 'LabelHeight') -eq 40 -and $app.Formats.Format.PageSetup.Orientation -eq 1 -and $app.Formats.Format.PageSetup.LabelColumns -eq 1) 'indexed SetProperty and GetProperty apply exact millimetre paper'
    $app.Formats.Format.PageSetup.ReadbackDelta=0.25
    Assert-Throws {Apply-BarTenderPaper $app.Formats.Format $paper} 'driver dimension substitution rejected by indexed readback'
    $app=New-MockApplication @('Code');$app.Formats.Format.PageSetup.Valid=$false
    Assert-Throws {Apply-BarTenderPaper $app.Formats.Format $paper} 'inconsistent native PageSetup rejected'
    $app=New-MockApplication @('Code');Invoke-BarTenderDimension $app.Formats.Format.PageSetup 'LabelWidth' 80 -Set
    Assert-Throws {Apply-BarTenderPaper $app.Formats.Format $paper} 'smaller paper requires matching native master and never silently crops'
    $job=New-TestJob
    $path=Save-TemplateCache $job $testRoot
    Assert-True ((Split-Path $path -Leaf) -ceq ($job.template.sha256+'.btw')) 'cache uses verified digest as filename'
    [IO.File]::WriteAllText($path,'tamper'); Assert-Throws {Save-TemplateCache $job $testRoot} 'changed cache rejected'; [IO.File]::Delete($path)
    $secretPath=Join-Path $testRoot 'protected.dpapi'; Save-ProtectedJson $secretPath @{token='MOCK-ONLY-SECRET';rows=$job.rows}
    Assert-True (-not [IO.File]::ReadAllText($secretPath).Contains('MOCK-ONLY-SECRET')) 'DPAPI file contains no plaintext token'
    Assert-True ((Read-ProtectedJson $secretPath).token -ceq 'MOCK-ONLY-SECRET') 'DPAPI round trip'
    Assert-Supervisor @{supervisorId=$PID;supervisorStartTicks=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks}
    Assert-True $true 'worker accepts its live original supervisor'
    Assert-Throws {Assert-Supervisor @{supervisorId=$PID;supervisorStartTicks=1}} 'worker rejects recycled supervisor PID'
    $identityApp=New-MockApplication @('Code');$identityApp.ProcessId=0;$identityApp.WindowProcessId=2147483645
    $proven=Get-BarTenderEngineIdentity $identityApp @() ([DateTime]::UtcNow) 'MOCK-ONLY-BARTEND.EXE'
    Assert-True ($proven.id -eq 2147483645) 'COM window handle PID fallback proves process identity without process-difference guessing'
    $identityApp.ProcessId=2147483644;Assert-Throws {Get-BarTenderEngineIdentity $identityApp @() ([DateTime]::UtcNow) 'MOCK-ONLY-BARTEND.EXE'} 'COM process ID and window owner must agree'
    $identityApp.ProcessId=0;$identityApp.WindowProcessId=0;Assert-Throws {Get-BarTenderEngineIdentity $identityApp @() ([DateTime]::UtcNow) 'MOCK-ONLY-BARTEND.EXE'} 'no usable COM identity fails safely'
    $identityApp.ProcessId=2147483645;Assert-Throws {Get-BarTenderEngineIdentity $identityApp @(2147483645) ([DateTime]::UtcNow) 'MOCK-ONLY-BARTEND.EXE'} 'preexisting Designer PID never becomes owned'
    foreach($entry in @(@{name='unrelated'},@{path='C:\unrelated.exe'},@{session=-1},@{sid='S-1-0-0'},@{started=[DateTime]::UtcNow.AddHours(-1)},@{id=2147483644})) {
        $script:MockProcessOverrides=$entry;Assert-Throws {Get-BarTenderEngineIdentity $identityApp @() ([DateTime]::UtcNow) 'MOCK-ONLY-BARTEND.EXE'} ('native process identity validates '+@($entry.Keys)[0])
    }
    $script:MockProcessOverrides=@{}
    $identityApp.ProcessId=0;$identityApp.WindowProcessId=0;$identityCalls=@{count=0}
    $identityResult=Invoke-BarTenderEngine @{mode='check'} {$identityApp}.GetNewClosure() {$identityCalls.count++;return 0}.GetNewClosure()
    Assert-True ($identityResult.status -ceq 'failed' -and -not $identityApp.QuitCalled -and $identityApp.Visible -and $identityCalls.count -eq 0 -and $identityResult.message.Contains('PROCESS_ID_UNAVAILABLE')) 'unproven instance is never hidden, closed or printed and returns actionable identity failure'
    $job=New-TestJob; $application=New-MockApplication $job.template.fields
    $seen=[Collections.Generic.List[object]]::new()
    $result=Invoke-BarTenderEngine @{mode='print';job=$job;templatePath='mock-only.btw'} {$application}.GetNewClosure() {
        param($format,$row)
        $snapshot=@{}; foreach($field in $format.Values.Keys){$snapshot[$field]=$format.Values[$field]}; $seen.Add($snapshot)
        if($format.UseDatabase -or $format.EnablePrompting -or $format.SelectRecordsAtPrint -or $format.AutoPrintAgain -or $format.PrintToFile -or $format.IdenticalCopiesOfLabel -ne 1 -or $format.NumberSerializedLabels -ne 1){throw 'unsafe setup'}
        return 0
    }.GetNewClosure()
    Assert-True ($result.status -ceq 'submitted' -and $seen.Count -eq 2) 'mock engine submits exactly one record per unit'
    Assert-True ($seen[0].Code -ceq '000001' -and $seen[1].Code -ceq '000002') 'leading zero identity retained'
    Assert-True ($seen[1].Location -ceq '') 'empty value clears previous label data'
    Assert-True ($application.QuitCalled -and $application.Formats.Format.Closed) 'only owned mock instance closed without save'
    $qrJob=New-TestJob; $qrJob.template.fields=@('QRPayload');$application=New-MockApplication @('QRPayload')
    $result=Invoke-BarTenderEngine @{mode='print';job=$qrJob;templatePath='mock-only.btw'} {$application}.GetNewClosure() {return 0}
    Assert-True ($result.status -ceq 'submitted') 'QR only engine never requires absent Code source'
    $previewJob=New-TestJob; $previewJob.kind='preview';$previewJob.rows=@($previewJob.rows[0]);$previewJob.paper=$paper
    Assert-True ((Assert-Job $previewJob).Length -gt 0) 'preview accepts exactly one selected unit and explicit paper'
    $previewJob.rows=@((New-TestJob).rows);Assert-Throws {Assert-Job $previewJob} 'preview rejects multiple units';$previewJob.rows=@($previewJob.rows[0])
    $previewPath=Join-Path $testRoot 'preview.png';$app=New-MockApplication $previewJob.template.fields;$printCalls=@{count=0}
    $result=Invoke-BarTenderEngine @{mode='print';job=$previewJob;templatePath='mock-only.btw';previewPath=$previewPath} {$app}.GetNewClosure() {$printCalls.count++;throw 'preview must never print'}.GetNewClosure()
    Assert-True ($result.status -ceq 'submitted' -and $printCalls.count -eq 0 -and $app.Formats.Format.ExportCalled -and $app.Formats.Format.ExportValues.Code -ceq $previewJob.rows[0].Code -and $result.previewBase64 -ceq (Read-PreviewPng $previewPath)) 'native template preview assigns selected unit and exports PNG without Print'
    [IO.File]::Delete($previewPath);$app=New-MockApplication $previewJob.template.fields;$app.Formats.Format.ExportFails=$true
    $result=Invoke-BarTenderEngine @{mode='print';job=$previewJob;templatePath='mock-only.btw';previewPath=$previewPath} {$app}.GetNewClosure() {$printCalls.count++;return 0}.GetNewClosure()
    Assert-True ($result.status -ceq 'failed' -and $printCalls.count -eq 0 -and -not $result.message.Contains('sensitive')) 'export failure never calls Print and redacts original exception'
    [IO.File]::WriteAllBytes($previewPath,[byte[]]::new(2MB+1));Assert-Throws {Read-PreviewPng $previewPath} 'preview PNG size cap enforced'
    [IO.File]::WriteAllBytes($previewPath,[byte[]]::new(40));Assert-Throws {Read-PreviewPng $previewPath} 'preview PNG signature enforced'
    [IO.File]::WriteAllBytes($previewPath,[Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmRoAAAAASUVORK5CYII='))
    $png=[IO.File]::ReadAllBytes($previewPath);$png[16]=1;[IO.File]::WriteAllBytes($previewPath,$png);Assert-Throws {Read-PreviewPng $previewPath} 'preview PNG pixel bounds enforced';[IO.File]::Delete($previewPath)
    $application=New-MockApplication @('Code'); $calls=@{count=0}
    $result=Invoke-BarTenderEngine @{mode='print';job=$job;templatePath='mock-only.btw'} {$application}.GetNewClosure() {$calls.count++;return 0}.GetNewClosure()
    Assert-True ($result.status -ceq 'failed' -and $calls.count -eq 0) 'missing named source fails before print'
    $application=New-MockApplication $job.template.fields
    $result=Invoke-BarTenderEngine @{mode='print';job=$job;templatePath='mock-only.btw'} {$application}.GetNewClosure() {return 1}
    Assert-True ($result.status -ceq 'unknown') 'engine timeout never retries'
    $application=New-MockApplication $job.template.fields;$calls=@{count=0}
    $request=@{mode='print';job=$job;templatePath='mock-only.btw';supervisorId=$PID;supervisorStartTicks=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks}
    $result=Invoke-BarTenderEngine $request {$application}.GetNewClosure() {$calls.count++;$request.supervisorStartTicks=1;return 0}.GetNewClosure()
    Assert-True ($result.status -ceq 'unknown' -and $calls.count -eq 1) 'supervisor loss stops subsequent records without reprint'
    $application=New-MockApplication $job.template.fields
    $result=Invoke-BarTenderEngine @{mode='print';job=$job;templatePath='mock-only.btw'} {$application}.GetNewClosure() {throw 'MOCK-ONLY business data must not escape'}
    Assert-True ($result.status -ceq 'unknown' -and -not $result.message.Contains('business')) 'print exception returns conservative redacted status'
    $application=New-MockApplication $job.template.fields
    $result=Invoke-BarTenderEngine @{mode='derive';templatePath='mock-only.btw';outputPath='new-mock-only.btw';layout=@{objects=@(@{name='Existing';X=12.5;FontSize=10;DoNotPrint=$true})}} {$application}.GetNewClosure()
    Assert-True ($result.status -ceq 'derived' -and $application.Formats.Format.Saved -ceq 'new-mock-only.btw' -and $application.Formats.Format.Objects.Fixture.X -eq 12.5 -and $application.Formats.Format.MeasurementUnits -eq 3) 'derive modifies existing object and calls nonoverwriting SaveAs'
    $configuration=@{serverUrl='http://127.0.0.1';token='MOCK-ONLY-TOKEN'}
    $state=@{claims=0;starts=0;prints=0;results=[Collections.Generic.List[object]]::new();job=(New-TestJob);failResult=$false;failStart=$false}
    $api={param($config,$path,$body)
        if($path -eq '/claim'){$state.claims++;return @{job=$state.job}}
        if($path.EndsWith('/start')){$state.starts++;if($state.failStart){throw 'mock network failure'};return @{ok=$true;status='printing'}}
        if($path.EndsWith('/result')){if($state.failResult){throw 'mock network failure'};$state.results.Add($body);return @{ok=$true;status=$body.status}}
        throw 'unexpected API'
    }.GetNewClosure()
    $engine={param($request,$directory) $state.prints++; return @{status='submitted';message='MOCK ONLY'}}.GetNewClosure()
    $printer={param($name) if($name -cne 'MOCK-ONLY-PRINTER'){throw 'invalid mock printer'}}
    $outcome=Invoke-StationCycle $configuration $testRoot $api $engine $printer
    Assert-True ($outcome -ceq 'submitted' -and $state.claims -eq 1 -and $state.starts -eq 1 -and $state.prints -eq 1 -and $state.results[0].status -ceq 'submitted') 'mock API claim start engine result chain'
    $state.failStart=$true
    $outcome=Invoke-StationCycle $configuration $testRoot $api $engine $printer
    Assert-True ($outcome -ceq 'unknown' -and $state.prints -eq 1 -and $state.results[1].status -ceq 'unknown') 'unacknowledged start never prints'
    $state.failStart=$false;$state.failResult=$true
    Assert-Throws {Invoke-StationCycle $configuration $testRoot $api $engine $printer} 'failed result acknowledgment retains journal'
    Assert-True ([IO.File]::Exists((Join-Path $testRoot 'journal.dpapi')) -and $state.prints -eq 2) 'pending terminal result persisted'
    $state.failResult=$false;$beforeClaims=$state.claims
    $outcome=Invoke-StationCycle $configuration $testRoot $api $engine $printer
    Assert-True ($outcome -ceq 'recovered' -and $state.claims -eq $beforeClaims -and $state.prints -eq 2 -and $state.results[-1].status -ceq 'submitted') 'recovery resends stored terminal result without claim or print'
    Save-ProtectedJson (Join-Path $testRoot 'journal.dpapi') @{jobId=$state.job.id;leaseToken=$state.job.leaseToken;result=@{status='submitted';message='NATIVE_TEMPLATE_PREVIEW';previewBase64='MOCK-ONLY-PREVIEW'}}
    $outcome=Invoke-StationCycle $configuration $testRoot $api $engine $printer
    Assert-True ($outcome -ceq 'recovered' -and $state.claims -eq $beforeClaims -and $state.prints -eq 2 -and $state.results[-1].previewBase64 -ceq 'MOCK-ONLY-PREVIEW') 'preview receipt retry preserves image and never claims or prints again'
    Save-ProtectedJson (Join-Path $testRoot 'journal.dpapi') @{jobId=$state.job.id;leaseToken=$state.job.leaseToken;stage='printing'}
    $outcome=Invoke-StationCycle $configuration $testRoot $api $engine $printer
    Assert-True ($outcome -ceq 'recovered' -and $state.prints -eq 2 -and $state.results[-1].status -ceq 'unknown') 'crash recovery marks unknown without reprint'
    $state.job.template.sha256=('0'*64)
    $outcome=Invoke-StationCycle $configuration $testRoot $api $engine $printer
    Assert-True ($outcome -ceq 'failed' -and $state.prints -eq 2 -and $state.results[-1].status -ceq 'failed') 'preflight failure reports failed before engine'
    $lockPath=Join-Path $testRoot 'test.lock';$first=[IO.File]::Open($lockPath,'OpenOrCreate','ReadWrite','None')
    try { Assert-Throws {[IO.File]::Open($lockPath,'OpenOrCreate','ReadWrite','None')} 'exclusive station lock prevents duplicate worker' } finally {$first.Dispose()}
    Assert-Throws {Protect-RuntimeDirectory ([IO.Path]::GetPathRoot($testRoot))} 'drive root cannot be used as runtime'
    Assert-Throws {Protect-RuntimeDirectory ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))} 'project root cannot be used as runtime'
    Assert-Throws {Protect-RuntimeDirectory $testRoot} 'existing nonempty unmarked directory cannot be used as runtime'
    $owned=Join-Path $testRoot 'owned-runtime'; Protect-RuntimeDirectory $owned; Protect-RuntimeDirectory $owned
    Assert-True ([IO.File]::Exists((Join-Path $owned '.labos-printing-runtime'))) 'only dedicated marked runtime receives restricted ACL'
    $taskState=@{task=$null;registrations=0;unregistrations=0}
    function Get-ScheduledTask {param($TaskName,$TaskPath,$ErrorAction) return $taskState.task}
    function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory) return [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory}}
    function New-ScheduledTaskTrigger {param([switch]$AtLogOn,$User) return @{AtLogOn=[bool]$AtLogOn;User=$User}}
    function New-ScheduledTaskPrincipal {param($UserId,$LogonType,$RunLevel) return [pscustomobject]@{UserId=$UserId;LogonType=$LogonType;RunLevel=$RunLevel}}
    function New-ScheduledTaskSettingsSet {param($MultipleInstances,$ExecutionTimeLimit,[switch]$StartWhenAvailable,[switch]$DisallowHardTerminate) return @{MultipleInstances=$MultipleInstances;ExecutionTimeLimit=$ExecutionTimeLimit;StartWhenAvailable=[bool]$StartWhenAvailable;DisallowHardTerminate=[bool]$DisallowHardTerminate}}
    function New-ScheduledTask {param($Action,$Trigger,$Principal,$Settings,$Description) return [pscustomobject]@{Actions=@($Action);Trigger=$Trigger;Principal=$Principal;Settings=$Settings;Description=$Description}}
    function Register-ScheduledTask {param($TaskName,$TaskPath,$InputObject,[switch]$Force) $taskState.task=$InputObject;$taskState.registrations++;return $InputObject}
    function Unregister-ScheduledTask {param($TaskName,$TaskPath,[switch]$Confirm) $taskState.unregistrations++;$taskState.task=$null}
    function Start-ScheduledTask {throw 'must not start a real or mock task during registration'}
    function Stop-ScheduledTask {throw 'must not terminate an in-flight task or BarTender'}
    Assert-Throws {Install-StationStartup $owned} 'startup requires explicit prior station initialization'
    Save-ProtectedJson (Join-Path $owned 'station.dpapi') @{serverUrl='https://example.invalid';token='MOCK-ONLY-STARTUP-TOKEN'}
    Install-StationStartup $owned | Out-Null
    $definition=Get-StartupDefinition $owned
    Assert-True ($taskState.registrations -eq 1 -and $taskState.task.Principal.LogonType -ceq 'Interactive' -and $taskState.task.Principal.RunLevel -ceq 'Limited' -and $taskState.task.Trigger.AtLogOn -and $taskState.task.Settings.DisallowHardTerminate) 'mock startup uses current interactive user at login without Session 0 or forced termination'
    Assert-True ($taskState.task.Actions[0].Arguments.Contains('-Background') -and $taskState.task.Actions[0].Arguments.Contains('-WindowStyle Hidden') -and -not $taskState.task.Actions[0].Arguments.Contains('MOCK-ONLY') -and $taskState.task.Settings.MultipleInstances -ceq 'IgnoreNew') 'startup arguments contain no token and do not start registration immediately'
    Assert-True ((Get-FileHash -LiteralPath $definition.script).Hash -ceq (Get-FileHash -LiteralPath $script:AgentScriptPath).Hash) 'startup uses stable protected exact script snapshot'
    $startupCheck=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh).Source);$startupCheck.UseShellExecute=$false;$startupCheck.CreateNoWindow=$true;$startupCheck.RedirectStandardOutput=$true;$startupCheck.RedirectStandardError=$true
    foreach($arg in @('-NoProfile','-NonInteractive','-File',$definition.script,'-Check','-RuntimeDirectory',$owned)){$startupCheck.ArgumentList.Add($arg)}
    $startupProcess=[Diagnostics.Process]::Start($startupCheck);$startupOut=$startupProcess.StandardOutput.ReadToEndAsync();$startupError=$startupProcess.StandardError.ReadToEndAsync()
    try {
        if(-not $startupProcess.WaitForExit(20000)){$startupProcess.Kill($true);throw 'copied no-COM check timed out'}
        $startupText=$startupOut.GetAwaiter().GetResult()+$startupError.GetAwaiter().GetResult()
        Assert-True ($startupText.Contains('AgentVersion') -and $startupText.Contains('0.8.2') -and -not $startupText.Contains('RuntimeDirectory must be a dedicated')) 'actual copied startup script can check its explicit runtime without weakening root directory protection'
    } finally {$startupProcess.Dispose()}
    $taskState.task.Description='unrelated user task';Assert-Throws {Install-StationStartup $owned} 'startup refuses to replace unrelated task';Assert-Throws {Uninstall-StationStartup $owned} 'uninstall refuses unrelated task'
    $taskState.task.Description=$definition.description;Uninstall-StationStartup $owned | Out-Null
    Assert-True ($taskState.unregistrations -eq 1 -and [IO.File]::Exists((Join-Path $owned 'stop-background')) -and [IO.File]::Exists((Join-Path $owned 'station.dpapi')) -and [IO.File]::Exists($definition.script)) 'uninstall only unregisters owned task and requests graceful stop while preserving runtime'
    Write-StationLog $owned 'TEST_EVENT' '受控诊断'
    $log=[IO.File]::ReadAllText((Join-Path $owned 'agent.log'))
    Assert-True ($log.Contains('TEST_EVENT') -and -not $log.Contains('MOCK-ONLY-STARTUP-TOKEN')) 'background log contains controlled events without station secret'
    [pscustomobject]@{passed=$checks.Count;checks=@($checks);engine='mock only';physicalPrint=$false;realComStarted=$false} | ConvertTo-Json -Depth 5
} finally {
    $resolved=[IO.Path]::GetFullPath($testRoot)
    if($resolved.StartsWith($cacheRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
