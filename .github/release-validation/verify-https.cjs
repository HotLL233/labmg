'use strict';
// Runner-only isolated smoke test. Never reads var, touches an existing project or installs a system CA.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const http=require('node:http'),https=require('node:https'),net=require('node:net'),{once}=require('node:events');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile),{version,commit}=require('./release-config.json');
const root=path.resolve(__dirname,'../../..'),cache=path.join(root,'artifacts/cache',version),release=path.join(root,'artifacts/releases',version);
const engineHost=process.env.DOCKER_HOST||'unix:///var/run/docker.sock',readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixturePath(candidate){const resolved=path.resolve(candidate);assert.equal(path.dirname(resolved),cache);assert.match(path.basename(resolved),/^https-smoke-[A-Za-z0-9]+$/);return resolved;}
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
 Object.assign(environment,{DOCKER_CONFIG:config,DOCKER_HOST:engineHost,LABOS_IMAGE:`ghcr.io/hotll233/labmg:${version}@${published.indexDigest}`,LABOS_PORT:String(httpPort),LABOS_HTTPS_HOST:'127.0.0.1',LABOS_HTTPS_PORT:String(httpsPort),LABOS_UID:'1000',LABOS_GID:'1000'});
 const run=async(args,timeout=120000)=>{const result=await execute('docker',args,{cwd:fixture,env:environment,windowsHide:true,timeout,maxBuffer:4*1024*1024});return result.stdout.trim();};
 const compose=(args,timeout)=>run(['compose','--project-name',project,'--env-file',path.join(fixture,'compose.env'),'-f',path.join(fixture,'docker-compose.yml'),'-f',path.join(fixture,'docker-compose.https.yml'),...args],timeout);
 fs.writeFileSync(path.join(fixture,'compose.env'),'');
 let started=false,failure,password='Https-Test-'+crypto.randomUUID(),cookie;
 try{
  for(const name of ['docker-compose.yml','docker-compose.https.yml','Caddyfile']){const bytes=fs.readFileSync(path.join(release,name)),entry=manifest.sources.find(row=>row.path==='deploy/'+name);assert.ok(entry);assert.equal(entry.size,bytes.length);assert.equal(entry.sha256,sha(bytes));fs.writeFileSync(path.join(fixture,name),bytes,{flag:'wx'});}
  report.stage='compose-and-adapter';const configuration=JSON.parse(await compose(['config','--format','json']));
  for(const name of ['labos','labos-init'])assert.equal(configuration.services[name].volumes[0].source,path.join(fixture,'runtime'));
  assert.equal(configuration.services['labos-https'].image,'caddy:2.11.7-alpine');
  const adapted=JSON.parse(await run(['run','--rm','--env','LABOS_HTTPS_HOST=127.0.0.1','--volume',path.join(fixture,'Caddyfile')+':/etc/caddy/Caddyfile:ro','caddy:2.11.7-alpine','caddy','adapt','--config','/etc/caddy/Caddyfile','--adapter','caddyfile']));
  assert.ok(JSON.stringify(adapted).includes('labos:3000'));assert.ok(JSON.stringify(adapted).includes('internal'));check('caddy-adapter-accepts-frozen-configuration',true);
  report.stage='start-isolated-project';started=true;await compose(['up','-d'],180000);
  const certificateFile=path.join(fixture,'root.crt');await poll(()=>compose(['cp','labos-https:/data/caddy/pki/authorities/local/root.crt',certificateFile]));
  const ca=fs.readFileSync(certificateFile);report.rootCertificateSha256=sha(ca);
  const request=(secure,method,route,payload,sessionCookie,origin)=>new Promise((resolve,reject)=>{
   const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload)),headers={...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{}),...(sessionCookie?{Cookie:sessionCookie}:{}),...(origin?{Origin:origin}:{})};
   const req=(secure?https:http).request({hostname:'127.0.0.1',port:secure?httpsPort:httpPort,path:route,method,headers,...(secure?{ca,rejectUnauthorized:true}:{})},res=>{const chunks=[];res.on('data',bytes=>chunks.push(bytes));res.on('error',reject);res.on('end',()=>{try{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,data:res.headers['content-type']?.includes('json')?JSON.parse(bytes):undefined});}catch(error){reject(error);}});});
   req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('HTTPS test request timed out')));if(bytes)req.write(bytes);req.end();
  });
  report.stage='trusted-https-and-setup';const initial=await poll(async()=>{const value=await request(true,'GET','/api/auth/me');assert.equal(value.status,200);return value;});assert.equal(initial.data.setupRequired,true);
  const payload={username:'https-smoke-admin',password,passwordConfirm:password};
  const badOrigin=await request(true,'POST','/api/auth/setup',payload,undefined,'https://unrelated.example.test');assert.equal(badOrigin.status,403);
  const setup=await request(true,'POST','/api/auth/setup',payload,undefined,`https://127.0.0.1:${httpsPort}`);assert.equal(setup.status,201);cookie=setup.headers['set-cookie'][0].split(';')[0];check('trusted-https-origin-and-first-setup',true);
  const secureMe=await request(true,'GET','/api/auth/me',undefined,cookie),plainMe=await request(false,'GET','/api/auth/me',undefined,cookie);
  assert.equal(secureMe.data.user.username,'https-smoke-admin');assert.equal(plainMe.data.user.username,secureMe.data.user.username);assert.equal(plainMe.data.setupRequired,false);check('http-and-https-use-same-accounts',true);
  report.stage='recreation';await compose(['up','-d','--force-recreate','labos','labos-https'],180000);
  await poll(async()=>{const value=await request(true,'GET','/api/auth/me',undefined,cookie);assert.equal(value.data.user.username,'https-smoke-admin');assert.equal(value.data.setupRequired,false);});
  const recreatedCertificate=path.join(fixture,'recreated-root.crt');await compose(['cp','labos-https:/data/caddy/pki/authorities/local/root.crt',recreatedCertificate]);assert.equal(sha(fs.readFileSync(recreatedCertificate)),report.rootCertificateSha256);check('recreation-preserves-ca-and-accounts',true);
  report.caddyImage=JSON.parse(await run(['image','inspect','caddy:2.11.7-alpine']))[0].RepoDigests;
 }catch(error){failure=error;report.errorCode=/^[A-Z][A-Z0-9_]{1,60}$/.test(error.code||'')?error.code:'CONTAINER_OR_HTTPS_FAILED';report.failureStage=report.stage;try{fs.writeFileSync(path.join(cache,'https-runner-diagnostics.log'),await compose(['logs','--no-color','labos','labos-https']));}catch{}}
 finally{
  const cleanup={passed:false};try{
   if(started)await compose(['down','--remove-orphans','--volumes'],120000);
   assert.equal(await run(['ps','-aq','--filter','label=com.docker.compose.project='+project]),'');
   assert.equal(await run(['volume','ls','-q','--filter','label=com.docker.compose.project='+project]),'');
   fixturePath(fixture);assert.equal(fs.lstatSync(fixture).isSymbolicLink(),false);assert.equal(fs.readFileSync(path.join(fixture,'.https-smoke-marker'),'utf8'),marker);
   // Only the marked test fixture is mounted; root-owned CA/SQLite directories need container-side cleanup.
   if(started)await run(['run','--rm','--user','0:0','--entrypoint','sh','--volume',fixture+':/fixture','caddy:2.11.7-alpine','-c','rm -rf /fixture/runtime /fixture/https']);
   fs.rmSync(fixture,{recursive:true,force:true});password=null;cookie=null;cleanup.passed=true;cleanup.fixtureRemoved=!fs.existsSync(fixture);cleanup.projectContainersRemaining=0;cleanup.projectVolumesRemaining=0;cleanup.credentialsRemoved=true;
  }catch(error){failure ||= error;cleanup.errorCode='ISOLATED_CLEANUP_FAILED';}
  report.cleanup=cleanup;report.status=failure?'failed':'passed';report.completedAtUtc=new Date().toISOString();fs.writeFileSync(path.join(cache,'https-verification.json'),JSON.stringify(report,null,2)+'\n');
 }
 assert.ok(!failure,'Isolated trusted HTTPS validation failed; see the safe canonical report.');
 console.log(JSON.stringify({status:report.status,checks:report.checks.length,project:report.project}));
}
if(process.argv.includes('--self-check')){assert.equal(fixturePath(path.join(cache,'https-smoke-Ab123')),path.join(cache,'https-smoke-Ab123'));for(const value of [cache,path.join(root,'var'),path.join(cache,'different-Ab123')])assert.throws(()=>fixturePath(value));console.log('HTTPS helper path self-check passed; no Docker, credentials, certificates or network.');}
else if(process.argv.includes('--execute-after-image-gates'))main().catch(error=>{console.error(error.code==='ERR_ASSERTION'?'HTTPS_VERIFICATION_FAILED':'HTTPS_OPERATION_FAILED');process.exitCode=1;});
else console.log('Prepared only. Run --self-check without network, or --execute-after-image-gates on the isolated GitHub runner after the image gates.');
