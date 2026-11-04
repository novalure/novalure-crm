// Isolated child-process probe: accepts only the disposable loopback fixture and synthetic actor.
import pg from 'pg';
import type {AppSession} from '../../src/lib/auth/session';
import type {TenantPool} from '../../src/lib/db/tenant-client';
import {dispatchPreparedPersonalReply} from '../../src/lib/db/crm-mailbox-reply-repository';
async function main(){
let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>20000)throw new Error('Fixture too large');}
const input=JSON.parse(raw) as {session:AppSession;port:number;role:string;jobId:string};
if(!input.session.email.endsWith('@example.invalid')||!Number.isInteger(input.port)||input.port<1024||input.port>65535||!/^sales_qa_[a-f0-9]{12}$/u.test(input.role))throw new Error('Disposable synthetic fixture required');
const pool=new pg.Pool({host:'127.0.0.1',port:input.port,user:input.role,database:'postgres',max:1,connectionTimeoutMillis:5000});
let calls=0;
try{const result=await dispatchPreparedPersonalReply(input.session,input.jobId,{pool:pool as unknown as TenantPool,transport:async()=>{calls++;throw new Error('Restart must not dispatch');}});process.stdout.write(JSON.stringify({status:result.status,id:result.id,providerCalls:calls}));}finally{await pool.end();}

}
void main().catch(()=>{process.stderr.write("Synthetic restart probe failed");process.exitCode=1;});
