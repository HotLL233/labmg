'use strict';
// Runner-only isolated smoke test. Never reads var, touches an existing project or installs a system CA.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),os=require('node:os');
const http=require('node:http'),https=require('node:https'),net=require('node:net'),{once}=require('node:events');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile),{version,commit}=(process.argv.includes('--self-check') ? { version: '0.11.1', commit: 'a'.repeat(40) } : require('./release-config.json'));
const root=path.resolve(__dirname,'../../..'),cache=path.join(root,'artifacts/cache',version),release=path.join(root,'artifacts/releases',version);
const engineHost=process.env.DOCKER_HOST||'unix:///var/run/docker.sock',readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const strictIpTls=Object.freeze({servername:'',rejectUnauthorized:true});
function fixturePath(candidate){const resolved=path.resolve(candidate);assert.equal(path.dirname(resolved),cache);assert.match(path.basename(resolved),/^https-smoke-[A-Za-z0-9]+$/);return resolved;}
function verifyDefaultSni(adapted,host='127.0.0.1'){const policies=Object.values(adapted.apps?.http?.servers||{}).flatMap(server=>server.tls_connection_policies||[]).filter(policy=>policy.default_sni);assert.ok(policies.length>0,'A canonical IP certificate must be selected for clients that omit SNI.');for(const policy of policies)assert.equal(policy.default_sni,host);}
function generatedHost(text){const defaults=[...text.matchAll(/^\s*default_sni\s+([A-Za-z0-9.-]+)\s*$/gm)],sites=[...text.matchAll(/^https:\/\/([A-Za-z0-9.-]+):443\s*\{\s*$/gm)];assert.equal(defaults.length,1);assert.equal(sites.length,1);assert.equal(defaults[0][1],sites[0][1]);assert.ok(!['auto','CHANGE_ME','0.0.0.0'].includes(defaults[0][1]));assert.match(text,/^\s*tls internal\s*$/m);assert.match(text,/^\s*reverse_proxy labos:3000\s*$/m);return defaults[0][1];}
function verifyAutomaticAddress(host,interfaces,routeTable,diagnostics={}){
 assert.equal(net.isIP(host),4);assert.ok(!/^(?:0\.|127\.|169\.254\.)/.test(host)&&Number(host.split('.')[0])<224);
 const excluded=/^(?:lo\d*$|docker\d*$|br-|veth|virbr|cni|flannel|podman|tun\d*$|tap\d*$|wg\d*$|tailscale|zt|utun)/i;
 const addresses=Object.entries(interfaces).filter(([name])=>!excluded.test(name)).flatMap(([name,items])=>(items||[]).filter(item=>!item.internal&&['IPv4',4].includes(item.family)&&net.isIP(item.address)===4&&!/^(?:0\.|127\.|169\.254\.)/.test(item.address)&&Number(item.address.split('.')[0])<224).map(item=>({interface:name,host:item.address})));
 const safeName=name=>/^[A-Za-z0-9_.:-]{1,64}$/.test(name)?name:'[invalid-interface]';
 diagnostics.host=host;diagnostics.interfaceAddresses=addresses.map(item=>({interface:safeName(item.interface),host:item.host}));
 const selected=addresses.filter(item=>item.host===host);diagnostics.selectedInterfaceCount=selected.length;assert.equal(selected.length,1,'Discovered host must belong to one real host interface, not a Docker bridge or loopback.');
 const defaults=String(routeTable).split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(row=>row.length>=8&&row[1]==='00000000'&&row[7]==='00000000'&&/^[0-9a-f]+$/i.test(row[3])&&(parseInt(row[3],16)&1)&&/^\d+$/.test(row[6])&&addresses.some(item=>item.interface===row[0])).map(row=>({interface:row[0],metric:Number(row[6])}));
 const preferred=defaults.filter(row=>row.metric===Math.min(...defaults.map(item=>item.metric))).map(row=>row.interface);
 diagnostics.defaultRoutes=defaults.map(item=>({interface:safeName(item.interface),metric:item.metric}));diagnostics.preferredInterfaces=preferred.map(safeName);
 let eligible=preferred.length?addresses.filter(item=>preferred.includes(item.interface)):addresses;
 const isPrivate=item=>{const [first,second]=item.host.split('.').map(Number);return first===10||(first===172&&second>=16&&second<=31)||(first===192&&second===168);};
 if(eligible.some(isPrivate))eligible=eligible.filter(isPrivate);
 eligible=eligible.filter((item,index)=>eligible.findIndex(other=>other.host===item.host)===index);
 diagnostics.eligibleAddresses=eligible.map(item=>({interface:safeName(item.interface),host:item.host}));
 assert.equal(eligible.length,1,'Host route discovery must yield a single canonical address.');assert.equal(eligible[0].host,host,'Discovered IP must be the canonical host-network address.');
 return {host,interface:selected[0].interface,defaultRouteInterfaces:[...new Set(preferred)]};
}
function assertAutoHttpsEvidence(value){
 const automatic=value.automaticDiscovery,legacy=value.legacyWildcard,manual=value.manualOverride,config=value.generatedConfiguration;
 assert.equal(automatic?.status,'passed');assert.equal(automatic.inputOmitted,true);assert.equal(automatic.effectiveInput,'auto');assert.equal(net.isIP(automatic.host),4);assert.ok(!/^(?:0\.|127\.|169\.254\.)/.test(automatic.host)&&Number(automatic.host.split('.')[0])<224);assert.equal(typeof automatic.interface,'string');assert.ok(automatic.interface.length>0);
 assert.equal(automatic.tlsClient?.hostname,automatic.host);assert.equal(automatic.tlsClient?.servername,'');assert.equal(automatic.tlsClient?.rejectUnauthorized,true);assert.equal(automatic.firstSetupRequired,true);assert.equal(automatic.adapterDefaultSni,automatic.host);assert.match(automatic.configurationSha256||'',/^[a-f0-9]{64}$/);
 assert.equal(legacy?.status,'passed');assert.equal(legacy.input,'0.0.0.0');assert.equal(legacy.resolvedHost,automatic.host);assert.equal(legacy.unchangedGeneratedConfiguration,true);assert.equal(legacy.trustedNoSniRequest,true);
 assert.equal(manual?.status,'passed');assert.equal(manual.input,'127.0.0.1');assert.equal(manual.resolvedHost,'127.0.0.1');assert.equal(manual.caPreserved,true);
 assert.equal(config?.path,'/etc/labos-https/Caddyfile');assert.equal(config.initializerNetwork,'host');assert.equal(config.readOnly,true);assert.equal(config.directoryOwner,0);assert.equal(config.directoryMode,'755');assert.equal(config.fileOwner,0);assert.equal(config.fileMode,'644');
 assert.equal(value.invalidExplicitHost?.status,'passed');assert.equal(value.invalidExplicitHost.input,'https://127.0.0.1');assert.equal(value.invalidExplicitHost.priorConfigurationPreserved,true);
 for(const name of ['default-auto-host-network-discovery-and-trusted-no-sni','legacy-wildcard-generates-canonical-host','invalid-explicit-host-preserves-generated-configuration','manual-loopback-override-preserves-ca'])assert.ok(value.checks.some(check=>check.name===name&&check.passed===true),name);
}
function publicUserId(response,status=200){assert.equal(response.status,status,'The authentication response must succeed.');assert.ok(response.data&&response.data.user&&typeof response.data.user==='object','The authentication response must contain an authenticated user.');const id=response.data.user.id;assert.ok(Number.isSafeInteger(id)&&id>0,'The authenticated user must have a positive integer id.');return id;}
function safeFailure(error){const errorCode=/^[A-Z][A-Z0-9_]{1,60}$/.test(error.code||'')?error.code:'CONTAINER_OR_HTTPS_FAILED';const messages={EPROTO:'TLS negotiation failed for the IP client without SNI.',ERR_TLS_CERT_ALTNAME_INVALID:'The certificate does not match the requested IP.',UNABLE_TO_VERIFY_LEAF_SIGNATURE:'The certificate chain could not be verified with the isolated root CA.',SELF_SIGNED_CERT_IN_CHAIN:'The certificate chain is not trusted by the isolated root CA.',DEPTH_ZERO_SELF_SIGNED_CERT:'The server certificate is not trusted by the isolated root CA.',CERT_HAS_EXPIRED:'The test certificate has expired.',ECONNREFUSED:'The isolated HTTP or HTTPS listener refused the connection.',ETIMEDOUT:'The isolated HTTPS request timed out.',ERR_ASSERTION:'A frozen HTTPS configuration or lifecycle assertion failed.'};const safe={errorCode,errorMessage:messages[errorCode]||'An isolated container or HTTPS operation failed.'};if(errorCode==='ERR_ASSERTION'){const frame=String(error.stack||'').match(/\bat [^\n]*verify-https\.cjs:(\d+):(\d+)\)?\s*(?:\n|$)/);safe.assertion={operator:/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.operator||'')?error.operator:'unknown',...(frame?{file:'verify-https.cjs',line:Number(frame[1]),column:Number(frame[2])}:{})};}return safe;}
const report={status:'running',version,commit,syntheticOnly:true,engineHost,checks:[],
 verificationEnvironment:{provider:'GitHub Actions',os:process.platform,architecture:process.arch,runId:process.env.GITHUB_RUN_ID,headSha:process.env.GITHUB_SHA,workflowSha:process.env.GITHUB_WORKFLOW_SHA},
 boundaries:['Real isolated Linux amd64 Caddy and LabOS containers with synthetic accounts; default auto discovery uses the runner host network and trusted HTTPS uses a test-local CA only.','No system trust store modified and no CA private keys read or exported.','Runner host-IP and loopback HTTPS do not prove physical phone certificate installation, NAS, ARM64 HTTPS or printer validation.']};
const check=(name,value)=>{assert.ok(value,name);report.checks.push({name,passed:true});};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=net.createServer().listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function poll(operation,timeout=90000){const end=Date.now()+timeout;let error;while(Date.now()<end){try{return await operation();}catch(value){error=value;await delay(500);}}throw error;}
function requestAt(secure,hostname,port,ca,method,route,payload,sessionCookie,origin){return new Promise((resolve,reject)=>{
 const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload)),headers={...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{}),...(sessionCookie?{Cookie:sessionCookie}:{}),...(origin?{Origin:origin}:{})};
 const req=(secure?https:http).request({hostname,port,path:route,method,headers,...(secure?{ca,...strictIpTls}:{})},res=>{const chunks=[];res.on('data',bytes=>chunks.push(bytes));res.on('error',reject);res.on('end',()=>{try{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,data:res.headers['content-type']?.includes('json')?JSON.parse(bytes):undefined});}catch(error){reject(error);}});});
 req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Object.assign(Error('HTTPS test request timed out'),{code:'ETIMEDOUT'})));if(bytes)req.write(bytes);req.end();
});}
async function main(){
 assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.env.GITHUB_ACTIONS,'true');
 assert.equal(path.resolve(__dirname),cache);assert.match(commit||'',/^[a-f0-9]{40}$/);assert.ok(/^unix:\/\//.test(engineHost));
 const anonymous=readJson(path.join(cache,'ghcr-anonymous-verification.json')),published=readJson(path.join(cache,'published-index.json'));
 assert.equal(anonymous.status,'passed');assert.equal(anonymous.commit,commit);assert.equal(published.commit,commit);
 assert.match(published.indexDigest,/^sha256:[a-f0-9]{64}$/);assert.equal(anonymous.expectedIndexDigest,published.indexDigest);assert.equal(anonymous.engineHost,engineHost);report.indexDigest=published.indexDigest;
 const manifest=readJson(path.join(release,'manifest.json'));assert.equal(manifest.commit,commit);assert.equal(manifest.version,version);
 const fixture=fixturePath(fs.mkdtempSync(path.join(cache,'https-smoke-'))),marker=crypto.randomUUID(),project='labos-https-'+version.replaceAll('.','')+'-'+crypto.randomBytes(4).toString('hex');
 fs.writeFileSync(path.join(fixture,'.https-smoke-marker'),marker);report.project=project;
 const environment={...process.env};for(const key of Object.keys(environment))if(/^(LABOS_|DOCKER_|COMPOSE_)/i.test(key))delete environment[key];
 const config=path.join(fixture,'docker-config');fs.mkdirSync(config);fs.writeFileSync(path.join(config,'config.json'),'{}\n');
 const httpPort=await freePort();let httpsPort=await freePort();while(httpsPort===httpPort)httpsPort=await freePort();
 Object.assign(environment,{DOCKER_CONFIG:config,DOCKER_HOST:engineHost,DOCKER_DEFAULT_PLATFORM:'linux/amd64',LABOS_IMAGE:`ghcr.io/hotll233/labmg:${version}@${published.indexDigest}`,LABOS_PORT:String(httpPort),LABOS_HTTPS_PORT:String(httpsPort),LABOS_UID:'1000',LABOS_GID:'1000'});
 const run=async(args,timeout=120000)=>{const result=await execute('docker',args,{cwd:fixture,env:environment,windowsHide:true,timeout,maxBuffer:4*1024*1024});return result.stdout.trim();};
 const compose=(args,timeout)=>run(['compose','--project-name',project,'-f',path.join(fixture,'docker-compose.yml'),...args],timeout);
 let started=false,failure,password='Https-Test-'+crypto.randomUUID(),cookie;
 try{
  const composeBytes=fs.readFileSync(path.join(release,'docker-compose.yml')),composeEntry=manifest.sources.find(row=>row.path==='deploy/docker-compose.yml');assert.ok(composeEntry);assert.equal(composeEntry.size,composeBytes.length);assert.equal(composeEntry.sha256,sha(composeBytes));fs.writeFileSync(path.join(fixture,'docker-compose.yml'),composeBytes,{flag:'wx'});
  assert.equal(fs.existsSync(path.join(fixture,'.env')),false);assert.equal(fs.existsSync(path.join(fixture,'Caddyfile')),false);report.composeFile='docker-compose.yml';report.externalConfigurationRequired=false;
  report.stage='restore-native-dependency-references';
  const pgRemote=anonymous.postgres.architectures.find(row=>row.architecture==='amd64');
  const pgImmutable='postgres:18-bookworm@'+anonymous.postgres.indexDigest;
  // Gate 3's final arm64 load may leave the mutable tag pointing at a single-platform archive.
  // Restore the already verified official index reference before the native HTTPS lifecycle.
  require('./postgres-image.cjs').checkPostgresImage(JSON.parse(await run(['image','inspect','--platform','linux/amd64',pgImmutable]))[0],pgRemote,anonymous.postgres.indexDigest,false);
  await run(['image','tag',pgImmutable,'postgres:18-bookworm']);
  require('./postgres-image.cjs').checkPostgresImage(JSON.parse(await run(['image','inspect','--platform','linux/amd64','postgres:18-bookworm']))[0],pgRemote,anonymous.postgres.indexDigest,false);
  report.postgresImage={imageTag:'postgres:18-bookworm',indexDigest:anonymous.postgres.indexDigest,architecture:'amd64',canonicalTagRestoredFromVerifiedIndex:true};
  assert.equal(anonymous.httpsProxy.status,'passed');
  const httpsRemote=anonymous.httpsProxy.architectures.find(row=>row.architecture==='amd64'),httpsImmutable='caddy:2.11.7-alpine@'+anonymous.httpsProxy.indexDigest;
  require('./postgres-image.cjs').checkHttpsImage(JSON.parse(await run(['image','inspect','--platform','linux/amd64',httpsImmutable]))[0],httpsRemote,anonymous.httpsProxy.indexDigest,false);
  await run(['image','tag',httpsImmutable,'caddy:2.11.7-alpine']);
  require('./postgres-image.cjs').checkHttpsImage(JSON.parse(await run(['image','inspect','--platform','linux/amd64','caddy:2.11.7-alpine']))[0],httpsRemote,anonymous.httpsProxy.indexDigest,false);
  report.httpsProxyImage={imageTag:'caddy:2.11.7-alpine',indexDigest:anonymous.httpsProxy.indexDigest,architecture:'amd64',canonicalTagRestoredFromVerifiedIndex:true};
  report.stage='compose-and-adapter';const configuration=JSON.parse(await compose(['config','--format','json']));
  assert.deepEqual(Object.keys(configuration.services).sort(),['labos','labos-https','labos-init','postgres']);
  for(const name of ['labos','labos-init'])assert.equal(configuration.services[name].volumes[0].source,path.join(fixture,'runtime'));
  const pg=configuration.services.postgres,proxy=configuration.services['labos-https'];
  assert.equal(pg.image,'postgres:18-bookworm');assert.equal(pg.environment.PGDATA,'/var/lib/postgresql/18/docker');assert.equal(pg.ports,undefined);
  assert.equal(pg.volumes.find(mount=>mount.target==='/var/lib/postgresql').source,path.join(fixture,'runtime/postgres'));
  const initializer=configuration.services['labos-init'];assert.equal(initializer.network_mode,'host');assert.equal(initializer.environment.LABOS_HTTPS_HOST,'auto');assert.equal(Object.hasOwn(environment,'LABOS_HTTPS_HOST'),false);
  assert.equal(proxy.image,'caddy:2.11.7-alpine');assert.equal(proxy.environment.LABOS_HTTPS_HOST,undefined);assert.equal(proxy.network_mode,undefined);
  assert.equal(proxy.environment.XDG_DATA_HOME,'/var/lib/labos-https/data');assert.equal(proxy.environment.XDG_CONFIG_HOME,'/var/lib/labos-https/config');
  const stateMount=proxy.volumes.find(mount=>mount.target==='/var/lib/labos-https'),configMount=proxy.volumes.find(mount=>mount.target==='/etc/labos-https');
  assert.equal(proxy.volumes.length,2);assert.equal(stateMount.source,path.join(fixture,'https'));assert.equal(Boolean(stateMount.read_only),false);assert.equal(configMount.source,path.join(fixture,'runtime/https-config'));assert.equal(configMount.read_only,true);
  assert.ok(proxy.entrypoint==null,'The proxy must retain the official image entrypoint.');assert.deepEqual(proxy.command,['caddy','run','--config','/etc/labos-https/Caddyfile','--adapter','caddyfile']);assert.equal(proxy.depends_on['labos-init'].condition,'service_completed_successfully');assert.equal(proxy.depends_on.labos.condition,'service_started');
  const readGenerated=async()=>{
   const text=await compose(['exec','-T','labos-https','cat','/etc/labos-https/Caddyfile']);
   const metadata=(await compose(['exec','-T','labos-https','stat','-c','%u %a','/etc/labos-https','/etc/labos-https/Caddyfile'])).split(/\r?\n/);assert.deepEqual(metadata,['0 755','0 644']);
   await compose(['exec','-T','labos-https','sh','-ec','test ! -L /etc/labos-https && test ! -L /etc/labos-https/Caddyfile']);
   report.generatedConfiguration={path:'/etc/labos-https/Caddyfile',initializerNetwork:'host',readOnly:true,directoryOwner:0,directoryMode:'755',fileOwner:0,fileMode:'644'};
   return {text,host:generatedHost(text),sha256:sha(Buffer.from(text))};
  };
  const adapt=async host=>{const value=JSON.parse(await compose(['exec','-T','labos-https','caddy','adapt','--config','/etc/labos-https/Caddyfile','--adapter','caddyfile']));const serialized=JSON.stringify(value),policies=Object.values(value.apps?.http?.servers||{}).flatMap(server=>server.tls_connection_policies||[]);report.adapterDiagnostics={expectedHost:host,defaultSniValues:policies.filter(policy=>policy.default_sni).map(policy=>/^[A-Za-z0-9.-]{1,253}$/.test(policy.default_sni)?policy.default_sni:'[invalid-host]'),expectedUpstreamPresent:serialized.includes('labos:3000'),internalIssuerPresent:serialized.includes('internal')};verifyDefaultSni(value,host);assert.ok(serialized.includes('labos:3000'));assert.ok(serialized.includes('internal'));return value;};
  report.stage='default-auto-discovery-start';started=true;await compose(['up','-d','--pull','never','--wait','--wait-timeout','180'],240000);
  report.stage='default-auto-read-generated';const automatic=await readGenerated();
  report.stage='default-auto-canonical-interface';report.automaticNetworkDiagnostics={};const hostEvidence=verifyAutomaticAddress(automatic.host,os.networkInterfaces(),fs.readFileSync('/proc/net/route','utf8'),report.automaticNetworkDiagnostics);
  report.stage='default-auto-caddy-adapter';await adapt(automatic.host);
  report.stage='default-auto-public-root-certificate';
  const certificateFile=path.join(fixture,'root.crt');await poll(()=>compose(['cp','labos-https:/var/lib/labos-https/data/caddy/pki/authorities/local/root.crt',certificateFile]));
  const ca=fs.readFileSync(certificateFile);report.rootCertificateSha256=sha(ca);
  report.stage='default-auto-trusted-no-sni';const autoInitial=await poll(async()=>{const value=await requestAt(true,automatic.host,httpsPort,ca,'GET','/api/auth/me');assert.equal(value.status,200);assert.equal(value.data.setupRequired,true);return value;});
  report.automaticDiscovery={status:'passed',inputOmitted:true,effectiveInput:'auto',...hostEvidence,configurationSha256:automatic.sha256,adapterDefaultSni:automatic.host,tlsClient:{hostname:automatic.host,...strictIpTls},firstSetupRequired:autoInitial.data.setupRequired};check('default-auto-host-network-discovery-and-trusted-no-sni',true);
  report.stage='legacy-wildcard-auto-configuration';environment.LABOS_HTTPS_HOST='0.0.0.0';await compose(['run','--rm','--pull','never','--no-deps','labos-init']);const legacy=await readGenerated();assert.equal(legacy.host,automatic.host);assert.equal(legacy.text,automatic.text);
  await compose(['up','-d','--pull','never','--no-deps','--force-recreate','labos-https']);await poll(async()=>{const value=await requestAt(true,legacy.host,httpsPort,ca,'GET','/api/auth/me');assert.equal(value.status,200);assert.equal(value.data.setupRequired,true);});
  report.legacyWildcard={status:'passed',input:'0.0.0.0',resolvedHost:legacy.host,unchangedGeneratedConfiguration:true,trustedNoSniRequest:true};check('legacy-wildcard-generates-canonical-host',true);
  report.stage='invalid-explicit-host-rejection';let rejected;
  try{await compose(['run','--rm','--pull','never','--no-deps','--env','LABOS_HTTPS_HOST=https://127.0.0.1','labos-init']);}catch(error){rejected=error;}
  assert.ok(rejected,'An explicit URL must fail init rather than become a certificate host');assert.equal(rejected.code,1);assert.equal((await readGenerated()).text,automatic.text);report.invalidExplicitHost={status:'passed',input:'https://127.0.0.1',priorConfigurationPreserved:true};check('invalid-explicit-host-preserves-generated-configuration',true);
  report.stage='manual-loopback-override';environment.LABOS_HTTPS_HOST='127.0.0.1';await compose(['run','--rm','--pull','never','--no-deps','labos-init']);await compose(['up','-d','--pull','never','--no-deps','--force-recreate','labos-https']);
  const manual=await readGenerated();assert.equal(manual.host,'127.0.0.1');await adapt(manual.host);report.configuredDefaultSni=manual.host;check('caddy-adapter-accepts-frozen-configuration',true);
  const manualCertificate=path.join(fixture,'manual-root.crt');await compose(['cp','labos-https:/var/lib/labos-https/data/caddy/pki/authorities/local/root.crt',manualCertificate]);assert.equal(sha(fs.readFileSync(manualCertificate)),report.rootCertificateSha256);report.manualOverride={status:'passed',input:'127.0.0.1',resolvedHost:manual.host,caPreserved:true};check('manual-loopback-override-preserves-ca',true);
  report.tlsClient={hostname:'127.0.0.1',...strictIpTls,trust:'only the public root certificate from this isolated Caddy instance'};
  const request=(secure,method,route,payload,sessionCookie,origin)=>requestAt(secure,'127.0.0.1',secure?httpsPort:httpPort,ca,method,route,payload,sessionCookie,origin);
  report.stage='trusted-https-and-setup';const initial=await poll(async()=>{const value=await request(true,'GET','/api/auth/me');assert.equal(value.status,200);return value;});assert.equal(initial.data.setupRequired,true);
  const payload={username:'https-smoke-admin',password,passwordConfirm:password};
  const badOrigin=await request(true,'POST','/api/auth/setup',payload,undefined,'https://unrelated.example.test');assert.equal(badOrigin.status,403);
  const setup=await request(true,'POST','/api/auth/setup',payload,undefined,`https://127.0.0.1:${httpsPort}`),setupUserId=publicUserId(setup,201);cookie=setup.headers['set-cookie'][0].split(';')[0];check('trusted-https-origin-and-first-setup',true);
  report.stage='shared-http-and-https-account';
  const secureMe=await request(true,'GET','/api/auth/me',undefined,cookie),plainMe=await request(false,'GET','/api/auth/me',undefined,cookie);
  assert.equal(publicUserId(secureMe),setupUserId);assert.equal(publicUserId(plainMe),setupUserId);assert.equal(secureMe.data.setupRequired,false);assert.equal(plainMe.data.setupRequired,false);check('http-and-https-use-same-accounts',true);
  report.stage='recreation';await compose(['up','-d','--pull','never','--force-recreate','--wait','--wait-timeout','180','postgres','labos','labos-https'],240000);
  await poll(async()=>{const value=await request(true,'GET','/api/auth/me',undefined,cookie);assert.equal(publicUserId(value),setupUserId);assert.equal(value.data.setupRequired,false);});
  const recreatedCertificate=path.join(fixture,'recreated-root.crt');await compose(['cp','labos-https:/var/lib/labos-https/data/caddy/pki/authorities/local/root.crt',recreatedCertificate]);assert.equal(sha(fs.readFileSync(recreatedCertificate)),report.rootCertificateSha256);check('recreation-preserves-ca-and-accounts',true);
  assertAutoHttpsEvidence(report);
  report.caddyImage=JSON.parse(await run(['image','inspect','caddy:2.11.7-alpine']))[0].RepoDigests;
 }catch(error){failure=error;Object.assign(report,safeFailure(error));report.failureStage=report.stage;try{fs.writeFileSync(path.join(cache,'https-runner-diagnostics.log'),await compose(['logs','--no-color','labos','labos-https']));}catch{}}
 finally{
  const cleanup={passed:false};try{
   if(started)await compose(['down','--remove-orphans','--volumes'],120000);
   assert.equal(await run(['ps','-aq','--filter','label=com.docker.compose.project='+project]),'');
   assert.equal(await run(['volume','ls','-q','--filter','label=com.docker.compose.project='+project]),'');
   fixturePath(fixture);assert.equal(fs.lstatSync(fixture).isSymbolicLink(),false);assert.equal(fs.readFileSync(path.join(fixture,'.https-smoke-marker'),'utf8'),marker);
   // Only the marked test fixture is mounted; root-owned CA/PostgreSQL directories need container-side cleanup.
   if(started)await run(['run','--rm','--user','0:0','--entrypoint','sh','--volume',fixture+':/fixture','caddy:2.11.7-alpine','-c','rm -rf /fixture/runtime /fixture/https']);
   fs.rmSync(fixture,{recursive:true,force:true});password=null;cookie=null;cleanup.passed=true;cleanup.fixtureRemoved=!fs.existsSync(fixture);cleanup.projectContainersRemaining=0;cleanup.projectVolumesRemaining=0;cleanup.credentialsRemoved=true;
  }catch(error){failure ||= error;cleanup.errorCode='ISOLATED_CLEANUP_FAILED';}
  report.cleanup=cleanup;report.status=failure?'failed':'passed';report.completedAtUtc=new Date().toISOString();fs.writeFileSync(path.join(cache,'https-verification.json'),JSON.stringify(report,null,2)+'\n');
 }
 assert.ok(!failure,'Isolated trusted HTTPS validation failed; see the safe canonical report.');
 console.log(JSON.stringify({status:report.status,checks:report.checks.length,project:report.project}));
}
if(require.main===module){
if(process.argv.includes('--self-check')){
 assert.equal(fixturePath(path.join(cache,'https-smoke-Ab123')),path.join(cache,'https-smoke-Ab123'));for(const value of [cache,path.join(root,'var'),path.join(cache,'different-Ab123')])assert.throws(()=>fixturePath(value));
 const adapted={apps:{http:{servers:{srv0:{tls_connection_policies:[{default_sni:'127.0.0.1'}]}}}}};verifyDefaultSni(adapted);verifyDefaultSni({apps:{http:{servers:{srv0:{tls_connection_policies:[{default_sni:'127.0.0.1'},{default_sni:'127.0.0.1'}]}}}}});for(const value of [{},{apps:{http:{servers:{srv0:{tls_connection_policies:[{default_sni:'192.0.2.10'}]}}}}},{apps:{tls:{default_sni:'127.0.0.1'}}}])assert.throws(()=>verifyDefaultSni(value));
 verifyDefaultSni({apps:{http:{servers:{srv0:{tls_connection_policies:[{default_sni:'192.0.2.10'}]}}}}},'192.0.2.10');assert.throws(()=>verifyDefaultSni({apps:{http:{servers:{srv0:{tls_connection_policies:[{default_sni:'192.0.2.10'},{default_sni:'127.0.0.1'}]}}}}},'192.0.2.10'));
 const generated='{\n default_sni 192.0.2.10\n}\nhttps://192.0.2.10:443 {\n tls internal\n reverse_proxy labos:3000\n}\n';assert.equal(generatedHost(generated),'192.0.2.10');for(const text of [generated.replace('https://192.0.2.10','https://192.0.2.11'),generated+generated,generated.replaceAll('192.0.2.10','0.0.0.0')])assert.throws(()=>generatedHost(text));
 const interfaces={lo:[{address:'127.0.0.1',family:'IPv4',internal:true}],docker0:[{address:'172.17.0.1',family:'IPv4',internal:false}],eth0:[{address:'192.0.2.10',family:'IPv4',internal:false}],eth1:[{address:'192.0.2.11',family:'IPv4',internal:false}]},routes='eth0 00000000 010200C0 0003 0 0 100 00000000\neth1 00000000 010200C0 0003 0 0 200 00000000\n';assert.equal(verifyAutomaticAddress('192.0.2.10',interfaces,routes).interface,'eth0');for(const host of ['0.0.0.0','127.0.0.1','172.17.0.1','192.0.2.11','239.1.2.3'])assert.throws(()=>verifyAutomaticAddress(host,interfaces,routes));assert.throws(()=>verifyAutomaticAddress('192.0.2.10',interfaces,''));
 const evidence={automaticDiscovery:{status:'passed',inputOmitted:true,effectiveInput:'auto',host:'192.0.2.10',interface:'eth0',configurationSha256:'a'.repeat(64),tlsClient:{hostname:'192.0.2.10',...strictIpTls},firstSetupRequired:true,adapterDefaultSni:'192.0.2.10'},legacyWildcard:{status:'passed',input:'0.0.0.0',resolvedHost:'192.0.2.10',unchangedGeneratedConfiguration:true,trustedNoSniRequest:true},manualOverride:{status:'passed',input:'127.0.0.1',resolvedHost:'127.0.0.1',caPreserved:true},generatedConfiguration:{path:'/etc/labos-https/Caddyfile',initializerNetwork:'host',readOnly:true,directoryOwner:0,directoryMode:'755',fileOwner:0,fileMode:'644'},invalidExplicitHost:{status:'passed',input:'https://127.0.0.1',priorConfigurationPreserved:true},checks:['default-auto-host-network-discovery-and-trusted-no-sni','legacy-wildcard-generates-canonical-host','invalid-explicit-host-preserves-generated-configuration','manual-loopback-override-preserves-ca'].map(name=>({name,passed:true}))};assertAutoHttpsEvidence(evidence);
 for(const change of [value=>delete value.automaticDiscovery,value=>value.automaticDiscovery.tlsClient.rejectUnauthorized=false,value=>value.automaticDiscovery.host='0.0.0.0',value=>value.legacyWildcard.resolvedHost='127.0.0.1',value=>value.generatedConfiguration.readOnly=false,value=>value.manualOverride.caPreserved=false,value=>value.invalidExplicitHost.priorConfigurationPreserved=false,value=>value.checks.pop()]){const invalid=structuredClone(evidence);change(invalid);assert.throws(()=>assertAutoHttpsEvidence(invalid));}
 assert.equal(strictIpTls.servername,'');assert.equal(strictIpTls.rejectUnauthorized,true);assert.equal(Object.isFrozen(strictIpTls),true);
 const publicUser={id:7,display_name:'Synthetic administrator',role:'ADMIN',permissions:[]};assert.equal(publicUserId({status:201,data:{user:publicUser}},201),7);assert.equal(publicUserId({status:200,data:{user:{...publicUser},setupRequired:false}}),7);
 for(const response of [{status:401,data:{user:publicUser}},{status:200,data:{user:null}},{status:200,data:{}},{status:200,data:{user:{username:'synthetic-admin'}}},{status:200,data:{user:{id:0}}},{status:200,data:{user:{id:'7'}}}])assert.throws(()=>publicUserId(response));
 for(const error of [{code:'EPROTO',message:'synthetic-secret'},{code:'not-safe',message:'synthetic-secret'},{code:'ERR_ASSERTION',message:'synthetic-secret'}]){const safe=safeFailure(error);assert.match(safe.errorCode,/^[A-Z][A-Z0-9_]{1,60}$/);assert.ok(!JSON.stringify(safe).includes('synthetic-secret'));}
 const diagnostic={};verifyAutomaticAddress('192.0.2.10',interfaces,routes,diagnostic);assert.equal(diagnostic.selectedInterfaceCount,1);assert.equal(diagnostic.eligibleAddresses[0].host,'192.0.2.10');const wrongHostDiagnostic={};assert.throws(()=>verifyAutomaticAddress('192.0.2.99',interfaces,routes,wrongHostDiagnostic));assert.equal(wrongHostDiagnostic.selectedInterfaceCount,0);
 const safeAssertion=safeFailure({code:'ERR_ASSERTION',operator:'strictEqual',message:'synthetic-secret',actual:{secret:'synthetic-secret'},expected:'synthetic-secret',stack:'Error: synthetic-secret\n    at verifyAutomaticAddress (/private/synthetic-secret/verify-https.cjs:20:66)\n'});assert.deepEqual(safeAssertion.assertion,{operator:'strictEqual',file:'verify-https.cjs',line:20,column:66});assert.ok(!JSON.stringify(safeAssertion).includes('synthetic-secret'));assert.equal(safeFailure({code:'ERR_ASSERTION',operator:'synthetic-secret\nvalue',stack:'synthetic-secret'}).assertion.operator,'unknown');
 console.log('HTTPS generated-config, host-route discovery, lifecycle evidence, strict no-SNI client and safe-diagnostic self-checks passed; no Docker, credentials, certificates or network.');
}
else if(process.argv.includes('--execute-after-image-gates'))main().catch(error=>{console.error(error.code==='ERR_ASSERTION'?'HTTPS_VERIFICATION_FAILED':'HTTPS_OPERATION_FAILED');process.exitCode=1;});
else console.log('Prepared only. Run --self-check without network, or --execute-after-image-gates on the isolated GitHub runner after the image gates.');
}
module.exports={assertAutoHttpsEvidence};
