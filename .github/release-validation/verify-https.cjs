'use strict';
// Runner-only isolated smoke test. Never reads var, touches an existing project or installs a system CA.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const http=require('node:http'),https=require('node:https'),net=require('node:net'),{once}=require('node:events');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile),{version,commit}=(process.argv.includes('--self-check') ? { version: '0.8.1', commit: 'a'.repeat(40) } : require('./release-config.json'));
const root=path.resolve(__dirname,'../../..'),cache=path.join(root,'artifacts/cache',version),release=path.join(root,'artifacts/releases',version);
const engineHost=process.env.DOCKER_HOST||'unix:///var/run/docker.sock',readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const strictIpTls=Object.freeze({servername:'',rejectUnauthorized:true});
function fixturePath(candidate){const resolved=path.resolve(candidate);assert.equal(path.dirname(resolved),cache);assert.match(path.basename(resolved),/^https-smoke-[A-Za-z0-9]+$/);return resolved;}
function verifyDefaultSni(adapted){const policies=Object.values(adapted.apps?.http?.servers||{}).flatMap(server=>server.tls_connection_policies||[]);assert.ok(policies.some(policy=>policy.default_sni==='127.0.0.1'),'Caddy must select the configured IP certificate for clients that omit SNI.');}
function publicUserId(response,status=200){assert.equal(response.status,status,'The authentication response must succeed.');assert.ok(response.data&&response.data.user&&typeof response.data.user==='object','The authentication response must contain an authenticated user.');const id=response.data.user.id;assert.ok(Number.isSafeInteger(id)&&id>0,'The authenticated user must have a positive integer id.');return id;}
function safeFailure(error){const errorCode=/^[A-Z][A-Z0-9_]{1,60}$/.test(error.code||'')?error.code:'CONTAINER_OR_HTTPS_FAILED';const messages={EPROTO:'TLS negotiation failed for the IP client without SNI.',ERR_TLS_CERT_ALTNAME_INVALID:'The certificate does not match the requested IP.',UNABLE_TO_VERIFY_LEAF_SIGNATURE:'The certificate chain could not be verified with the isolated root CA.',SELF_SIGNED_CERT_IN_CHAIN:'The certificate chain is not trusted by the isolated root CA.',DEPTH_ZERO_SELF_SIGNED_CERT:'The server certificate is not trusted by the isolated root CA.',CERT_HAS_EXPIRED:'The test certificate has expired.',ECONNREFUSED:'The isolated HTTP or HTTPS listener refused the connection.',ETIMEDOUT:'The isolated HTTPS request timed out.',ERR_ASSERTION:'A frozen HTTPS configuration or lifecycle assertion failed.'};return {errorCode,errorMessage:messages[errorCode]||'An isolated container or HTTPS operation failed.'};}
const report={status:'running',version,commit,syntheticOnly:true,engineHost,checks:[],
 verificationEnvironment:{provider:'GitHub Actions',os:process.platform,architecture:process.arch,runId:process.env.GITHUB_RUN_ID,headSha:process.env.GITHUB_SHA,workflowSha:process.env.GITHUB_WORKFLOW_SHA},
 boundaries:['Real isolated Linux amd64 Caddy and LabOS containers with synthetic accounts; trusted HTTPS uses a test-local CA only.','No system trust store modified and no CA private keys read or exported.','Loopback HTTPS is not physical phone certificate installation, NAS, ARM64 HTTPS or printer validation.']};
const check=(name,value)=>{assert.ok(value,name);report.checks.push({name,passed:true});};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=net.createServer().listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function poll(operation,timeout=90000){const end=Date.now()+timeout;let error;while(Date.now()<end){try{return await operation();}catch(value){error=value;await delay(500);}}throw error;}
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
 Object.assign(environment,{DOCKER_CONFIG:config,DOCKER_HOST:engineHost,DOCKER_DEFAULT_PLATFORM:'linux/amd64',LABOS_IMAGE:`ghcr.io/hotll233/labmg:${version}@${published.indexDigest}`,LABOS_PORT:String(httpPort),LABOS_HTTPS_HOST:'127.0.0.1',LABOS_HTTPS_PORT:String(httpsPort),LABOS_UID:'1000',LABOS_GID:'1000'});
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
  assert.equal(proxy.image,'caddy:2.11.7-alpine');assert.equal(proxy.environment.LABOS_HTTPS_HOST,'127.0.0.1');
  assert.equal(proxy.environment.XDG_DATA_HOME,'/var/lib/labos-https/data');assert.equal(proxy.environment.XDG_CONFIG_HOME,'/var/lib/labos-https/config');
  assert.equal(proxy.volumes.length,1);assert.equal(proxy.volumes[0].source,path.join(fixture,'https'));assert.equal(proxy.volumes[0].target,'/var/lib/labos-https');
  assert.deepEqual(proxy.entrypoint,['/bin/sh','-ec']);assert.equal(proxy.command.length,1);assert.match(proxy.command[0],/default_sni \{\$\$LABOS_HTTPS_HOST\}/);
  report.stage='reject-invalid-inline-hosts';
  // Compose re-escapes dollars in config JSON; remove that one layer before passing argv directly to Docker.
  const inlineScript=proxy.command[0].replaceAll('$$','$');
  const inspectRejection='set +e; "$@"; result=$?; if [ "$result" -eq 0 ]; then exit 90; fi; if [ -e "$XDG_DATA_HOME/caddy/pki" ]; then exit 91; fi; exit "$result"';
  for(const host of ['CHANGE_ME','https://127.0.0.1']){
   let rejected;
   try{await execute('docker',['run','--rm','--pull','never','--network','none','--platform','linux/amd64','--entrypoint','/bin/sh','--env','LABOS_HTTPS_HOST='+host,'--env','XDG_DATA_HOME='+proxy.environment.XDG_DATA_HOME,'--env','XDG_CONFIG_HOME='+proxy.environment.XDG_CONFIG_HOME,proxy.image,'-c',inspectRejection,'host-rejection',...proxy.entrypoint,inlineScript],{cwd:fixture,env:environment,windowsHide:true,timeout:30000,maxBuffer:1024*1024});}
   catch(error){rejected=error;}
   assert.ok(rejected,'Invalid HTTPS host must reject startup');assert.equal(rejected.code,1);assert.match(rejected.stderr,/请在 YML 中将 LABOS_HTTPS_HOST/);
  }
  report.invalidHostStartup={status:'passed',cases:['placeholder','URL-with-scheme'],originalNormalizedEntrypointAndCommand:true,hostBind:false,caCreated:false};
  console.log('Inline HTTPS host startup rejection passed: placeholder and URL, no host bind or CA');
  report.stage='start-isolated-project';started=true;await compose(['up','-d','--pull','never','--wait','--wait-timeout','180'],240000);
  report.stage='adapt-real-inline-caddyfile';const adapted=JSON.parse(await compose(['exec','-T','labos-https','caddy','adapt','--config','/tmp/labos-Caddyfile','--adapter','caddyfile']));
  verifyDefaultSni(adapted);report.configuredDefaultSni='127.0.0.1';
  assert.ok(JSON.stringify(adapted).includes('labos:3000'));assert.ok(JSON.stringify(adapted).includes('internal'));check('caddy-adapter-accepts-frozen-configuration',true);
  const certificateFile=path.join(fixture,'root.crt');await poll(()=>compose(['cp','labos-https:/var/lib/labos-https/data/caddy/pki/authorities/local/root.crt',certificateFile]));
  const ca=fs.readFileSync(certificateFile);report.rootCertificateSha256=sha(ca);report.tlsClient={hostname:'127.0.0.1',...strictIpTls,trust:'only the public root certificate from this isolated Caddy instance'};
  const request=(secure,method,route,payload,sessionCookie,origin)=>new Promise((resolve,reject)=>{
   const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload)),headers={...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{}),...(sessionCookie?{Cookie:sessionCookie}:{}),...(origin?{Origin:origin}:{})};
   const req=(secure?https:http).request({hostname:'127.0.0.1',port:secure?httpsPort:httpPort,path:route,method,headers,...(secure?{ca,...strictIpTls}:{})},res=>{const chunks=[];res.on('data',bytes=>chunks.push(bytes));res.on('error',reject);res.on('end',()=>{try{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,data:res.headers['content-type']?.includes('json')?JSON.parse(bytes):undefined});}catch(error){reject(error);}});});
   req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Object.assign(Error('HTTPS test request timed out'),{code:'ETIMEDOUT'})));if(bytes)req.write(bytes);req.end();
  });
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
if(process.argv.includes('--self-check')){
 assert.equal(fixturePath(path.join(cache,'https-smoke-Ab123')),path.join(cache,'https-smoke-Ab123'));for(const value of [cache,path.join(root,'var'),path.join(cache,'different-Ab123')])assert.throws(()=>fixturePath(value));
 const adapted={apps:{http:{servers:{srv0:{tls_connection_policies:[{default_sni:'127.0.0.1'}]}}}}};verifyDefaultSni(adapted);for(const value of [{},{apps:{http:{servers:{srv0:{tls_connection_policies:[{default_sni:'192.0.2.10'}]}}}}},{apps:{tls:{default_sni:'127.0.0.1'}}}])assert.throws(()=>verifyDefaultSni(value));
 assert.equal(strictIpTls.servername,'');assert.equal(strictIpTls.rejectUnauthorized,true);assert.equal(Object.isFrozen(strictIpTls),true);
 const publicUser={id:7,display_name:'Synthetic administrator',role:'ADMIN',permissions:[]};assert.equal(publicUserId({status:201,data:{user:publicUser}},201),7);assert.equal(publicUserId({status:200,data:{user:{...publicUser},setupRequired:false}}),7);
 for(const response of [{status:401,data:{user:publicUser}},{status:200,data:{user:null}},{status:200,data:{}},{status:200,data:{user:{username:'synthetic-admin'}}},{status:200,data:{user:{id:0}}},{status:200,data:{user:{id:'7'}}}])assert.throws(()=>publicUserId(response));
 for(const error of [{code:'EPROTO',message:'synthetic-secret'},{code:'not-safe',message:'synthetic-secret'},{code:'ERR_ASSERTION',message:'synthetic-secret'}]){const safe=safeFailure(error);assert.match(safe.errorCode,/^[A-Z][A-Z0-9_]{1,60}$/);assert.ok(!JSON.stringify(safe).includes('synthetic-secret'));}
 console.log('HTTPS fixture, actual-adapter default SNI, strict no-SNI client and safe-diagnostic self-checks passed; no Docker, credentials, certificates or network.');
}
else if(process.argv.includes('--execute-after-image-gates'))main().catch(error=>{console.error(error.code==='ERR_ASSERTION'?'HTTPS_VERIFICATION_FAILED':'HTTPS_OPERATION_FAILED');process.exitCode=1;});
else console.log('Prepared only. Run --self-check without network, or --execute-after-image-gates on the isolated GitHub runner after the image gates.');
