#requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/bartender-agent.ps1') -Library
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
    $format=[pscustomobject]@{Values=$values;Printer='';UseDatabase=$true;EnablePrompting=$true;SelectRecordsAtPrint=$true;AutoPrintAgain=$true;PrintToFile=$true;IdenticalCopiesOfLabel=20;NumberSerializedLabels=20;Closed=$false;MeasurementUnits=0;Saved='';Objects=$null}
    $format | Add-Member ScriptMethod GetNamedSubStringValue {param($name) if(-not $this.Values.ContainsKey($name)){throw 'missing'}; return $this.Values[$name]}
    $format | Add-Member ScriptMethod SetNamedSubStringValue {param($name,$value) $this.Values[$name]=$value}
    $format | Add-Member ScriptMethod Close {param($save) if($save -ne 1){throw 'must not save'}; $this.Closed=$true}
    $format | Add-Member ScriptMethod SaveAs {param($path,$overwrite) if($overwrite){throw 'must not overwrite'}; $this.Saved=$path}
    $objects=[pscustomobject]@{Fixture=[pscustomobject]@{X=1;Y=1;Width=2;Height=2;FontSize=8;DoNotPrint=$false}}
    $objects | Add-Member ScriptMethod Find {param($name) if($name -ceq 'Existing'){return $this.Fixture}; return $null}
    $format.Objects=$objects
    $formats=[pscustomobject]@{Format=$format}
    $formats | Add-Member ScriptMethod Open {param($path,$reset,$printer) return $this.Format}
    $app=[pscustomobject]@{ProcessID=2147483645;Visible=$true;Edition='Automation';FullVersion='MOCK';Formats=$formats;QuitCalled=$false}
    $app | Add-Member ScriptMethod Quit {param($save) if($save -ne 1){throw 'must not save'}; $this.QuitCalled=$true}
    return $app
}
$cacheRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts/cache/0.8.0/bartender-agent-tests'))
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
    [pscustomobject]@{passed=$checks.Count;checks=@($checks);engine='mock only';physicalPrint=$false;realComStarted=$false} | ConvertTo-Json -Depth 5
} finally {
    $resolved=[IO.Path]::GetFullPath($testRoot)
    if($resolved.StartsWith($cacheRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
