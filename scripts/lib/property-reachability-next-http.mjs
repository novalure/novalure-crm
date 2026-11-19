import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = data => createHash('sha256').update(data).digest('hex');
async function bounded(work, ms, code) { let timer; try { return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(code)),ms);})]); } finally { clearTimeout(timer); } }
async function port() { const s=net.createServer(); await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});const a=s.address();await new Promise(resolve=>s.close(resolve));if(!a||typeof a==='string')throw new Error('LOCAL_HTTP_PORT_UNAVAILABLE');return a.port; }

/** Copies current application bytes into an owned ignored app root, so Next's
 * generated next-env/types/cache files cannot rewrite the actual source tree. */
export async function startReachabilityHttp(db, syntheticAuth) {
  const cwd = await realpath(process.cwd()), qa = path.join(cwd,'.npm-cache','qa');
  if (!db.lifecycleEvidence.serverIdentityVerified || path.dirname(db.directory)!==qa || !/^sales_qa_[a-f0-9]{12}$/.test(db.role)) throw new Error('LOCAL_HTTP_OWN_DB_REQUIRED');
  for(const value of Object.values(syntheticAuth))if(typeof value!=='string'||value.length<32||value.length>256)throw new Error('LOCAL_HTTP_SYNTHETIC_AUTH_REQUIRED');
  if((await readdir(cwd)).some(name=>/^\.env(?:\.|$)/.test(name)))throw new Error('LOCAL_HTTP_ENV_FILE_PRESENT_REFUSE_READ');
  const leasePath=path.join(qa,'.property-reachability-next-http.lock'),nonce=randomUUID();
  const runDirectory=await mkdtemp(path.join(qa,'property-reachability-http-')),appDirectory=path.join(runDirectory,'app');await mkdir(appDirectory);
  const inputs={};let totalBytes=0;
  async function copy(relative) {
    const source=path.join(cwd,relative),target=path.join(appDirectory,relative),info=await import('node:fs/promises').then(f=>f.lstat(source));
    if(info.isSymbolicLink())throw new Error('LOCAL_HTTP_SOURCE_LINK_DENIED');
    if(info.isDirectory()){await mkdir(target,{recursive:true});for(const item of(await readdir(source)).sort())await copy(path.join(relative,item));return;}
    if(!info.isFile()||info.size>20*1024*1024||/(?:^|[\\/])\.env(?:\.|$)|\.(?:pem|pfx|p12|key)$/i.test(relative))throw new Error('LOCAL_HTTP_SOURCE_FILE_DENIED');
    const bytes=await readFile(source);totalBytes+=bytes.length;if(totalBytes>64*1024*1024||Object.keys(inputs).length>=10000)throw new Error('LOCAL_HTTP_APP_CAPTURE_TOO_LARGE');
    inputs[relative.replaceAll('\\','/')]=sha(bytes);await writeFile(target,bytes,{flag:'wx'});
  }
  for(const relative of ['src','public','design-c/styles','design-c/components','package.json','package-lock.json','tsconfig.json','next.config.ts','postcss.config.mjs'])await copy(relative);
  try{await readFile(path.join(cwd,'next-env.d.ts'));await copy('next-env.d.ts');}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const [relative,hash]of Object.entries(inputs))if(sha(await readFile(path.join(cwd,relative)))!==hash)throw new Error('LOCAL_HTTP_SOURCE_CHANGED_DURING_CAPTURE');
  await symlink(await realpath(path.join(cwd,'node_modules')),path.join(appDirectory,'node_modules'),process.platform==='win32'?'junction':'dir');
  await writeFile(path.join(runDirectory,'source-inputs.json'),JSON.stringify({kind:'CURRENT_UNCOMMITTED_OR_COMMITTED_APP_BYTES_NOT_NATIVE_CI',inputs},null,2)+'\n');
  const httpPort=await port(),origin=`http://127.0.0.1:${httpPort}`,guard=fileURLToPath(new URL('./property-reachability-http-network-guard.mjs',import.meta.url));
  const env={NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',CRM_LOCAL_TEST_DATABASE:'1',NOVALURE_AUTH_STRICT:'1',
    DATABASE_URL:`postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,NOVALURE_APP_ORIGIN:origin,NOVALURE_SESSION_SECRET:syntheticAuth.session,
    NOVALURE_AUTH_ENCRYPTION_KEY:syntheticAuth.encryption,NOVALURE_AUTH_RATE_LIMIT_SECRET:syntheticAuth.rateLimit,
    PROPERTY_REACHABILITY_NEXT_DIRECTORY:appDirectory,PROPERTY_REACHABILITY_HTTP_NONCE:nonce,PROPERTY_REACHABILITY_HTTP_PORTS:`${httpPort},${db.port}`,PORT:String(httpPort),
    NODE_OPTIONS:`--import=${pathToFileURL(guard).href}`,TEMP:runDirectory,TMP:runDirectory};
  for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATH','Path'])if(process.env[key])env[key]=process.env[key];
  const lease=await open(leasePath,'wx',0o600);await lease.writeFile(nonce);await lease.sync();
  const log=await open(path.join(runDirectory,'next-local.log'),'wx',0o600);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./property-reachability-next-server.mjs',import.meta.url))],{cwd:appDirectory,env,windowsHide:true,shell:false,stdio:['ignore',log.fd,log.fd,'ipc']});
  const exited=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',()=>reject(new Error('LOCAL_HTTP_CHILD_START_FAILED')));});void exited.catch(()=>undefined);
  let lastMessage,stopping;
  const ready=new Promise((resolve,reject)=>{child.on('message',value=>{if(value?.nonce!==nonce)return;lastMessage=value;if(value.type==='READY'&&value.origin===origin)resolve();if(value.type==='ERROR')reject(new Error(value.code));});});
  const stop=()=>stopping??=(async()=>{
    if(child.exitCode===null&&child.signalCode===null&&child.connected)child.send({type:'STOP',nonce});
    let result;try{result=await bounded(exited,15000,'LOCAL_HTTP_COOPERATIVE_SHUTDOWN_UNSUPPORTED_NO_FORCE_KILL');}
    finally{await log.close();}
    const ok=result.code===0&&lastMessage?.type==='STOPPED';
    await writeFile(path.join(runDirectory,'http-lifecycle.json'),JSON.stringify({schemaVersion:1,origin,scope:'ORIGINAL_NODE_CHILD_WITH_NEXT_APP_COOPERATIVE_CLOSE_NOT_GLOBAL_TREE_PROOF',exit:result,lastMessageType:lastMessage?.type,
      blockedNetworkAttempts:lastMessage?.blockedNetworkAttempts,providerEnvironmentForwarded:false,dotEnvFileRead:false,sourceTreeModified:false,forcedProcessKill:false,ok},null,2)+'\n');
    if(!ok)throw new Error('LOCAL_HTTP_CLOSE_FAILED_OWN_LEASE_RETAINED');
    if(await readFile(leasePath,'utf8')!==nonce)throw new Error('LOCAL_HTTP_LEASE_CHANGED');await lease.close();await rm(leasePath);
    return{ok,runDirectory,blockedNetworkAttempts:lastMessage.blockedNetworkAttempts};
  })();
  try{await bounded(ready,90000,'LOCAL_NEXT_READY_TIMEOUT');return{origin,runDirectory,appDirectory,inputs,stop};}
  catch(error){try{await stop();}catch{/* Explicit unsupported cleanup evidence; no foreign or numeric kill. */}throw error;}
}
