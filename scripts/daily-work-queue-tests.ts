import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildDailyWorkQueue} from '../src/lib/daily-work-queue';
import type {CalendarEvent,Contact,Lead,Project,Task,WorkspaceUser} from '../src/lib/crm-types';
const now=new Date('2026-11-04T23:30:00Z');
const lead={id:'lead',workspaceId:'workspace',projectId:'project',contactId:'contact',source:'Website',type:'Käufer',status:'Neu',score:10,intent:'New property enquiry',nextAction:'Reply personally',receivedAt:'2026-11-04T20:00:00Z',slaDueAt:'2026-11-04T21:00:00Z',assignedToUserId:'owner'} as Lead;
const task={id:'task',workspaceId:'workspace',projectId:'project',contactId:'contact',leadId:'lead',title:'Call me maybe',project:'Property',due:'2026-11-05T09:00:00+01:00',priority:'Normal',status:'open',ownerUserId:'owner'} as Task;
const event={id:'event',workspaceId:'workspace',projectId:'project',title:'Viewing',startsAt:'2026-11-05T08:00:00+01:00',status:'bestätigt',ownerUserId:'owner',location:'Vor Ort'} as CalendarEvent;
function input(){return {workspaceId:'workspace',projectId:'project',contacts:[{id:'contact',workspaceId:'workspace',projectId:'project',name:'Synthetic contact'} as Contact],leads:[lead],tasks:[task],events:[event],projects:[{id:'project',workspaceId:'workspace',name:'Synthetic property'} as Project],users:[{id:'owner',workspaceId:'workspace',name:'Synthetic owner'} as WorkspaceUser],language:'de' as const,now,timeZone:'Europe/Vienna'};}
test('low-score new enquiries retain first priority, exact lead context, source and resolved owner',()=>{
 const queue=buildDailyWorkQueue(input());assert.equal(queue[0].kind,'newLead');assert.equal(queue[0].leadId,'lead');assert.equal(queue[0].owner,'Synthetic owner');assert.equal(queue[0].source,'Website');assert.equal(queue[0].title,'Synthetic contact');
});
test('callback classification is explicit and only due callbacks enter the daily callback count',()=>{
 const base=input();assert.equal(buildDailyWorkQueue(base).find(item=>item.id==='task:task')?.kind,'task');
 base.tasks=[{...task,actionType:'callback'}];assert.equal(buildDailyWorkQueue(base).find(item=>item.id==='task:task')?.kind,'callback');
 base.tasks=[{...task,actionType:'callback',due:'2026-12-01'}];assert.equal(buildDailyWorkQueue(base).some(item=>item.id==='task:task'),false);
});
test('date-only tasks and appointments use the property timezone; canceled and completed work disappears',()=>{
 const base=input();base.leads=[];base.tasks=[{...task,due:'2026-11-04'}];
 assert.equal(buildDailyWorkQueue(base).find(item=>item.id==='task:task')?.kind,'overdueTask');assert.ok(buildDailyWorkQueue(base).some(item=>item.id==='event:event'));
 assert.equal(buildDailyWorkQueue({...base,timeZone:'Europe/Dublin'}).some(item=>item.id==='event:event'),false);
 base.tasks=[{...task,status:'done'}];base.events=[{...event,status:'abgesagt'}];assert.deepEqual(buildDailyWorkQueue(base),[]);
});
test('workspace and project boundaries exclude unrelated records and never resolve another tenant contact or owner',()=>{
 const base=input();base.leads=[{...lead,id:'foreign',workspaceId:'foreign'},{...lead,id:'other-project',projectId:'other'},lead];base.tasks=[];base.events=[];
 base.contacts=[{...base.contacts[0],workspaceId:'foreign',name:'PRIVATE FOREIGN'}];base.users=[{...base.users[0],workspaceId:'foreign',name:'PRIVATE OWNER'}];
 const queue=buildDailyWorkQueue(base);assert.equal(queue.length,1);assert.doesNotMatch(JSON.stringify(queue),/PRIVATE/);assert.equal(queue[0].title,lead.intent);assert.equal(queue[0].owner,'Zuständigkeit nicht verfügbar');
});

test('known system lead text is translated for display while saved and personal text stay unchanged',()=>{
 const base=input();
 const systemLead={...lead,intent:'Verkaufsabsicht in 3 Monaten',nextAction:'Rückruf heute'};
 const before=JSON.stringify(systemLead);
 const translated=buildDailyWorkQueue({...base,language:'en',contacts:[],tasks:[],events:[],leads:[systemLead]});
 assert.equal(translated[0].title,'Selling intent within 3 months');
 assert.ok(translated[0].meta.includes('Callback today'));
 assert.equal(JSON.stringify(systemLead),before);
 const personal=buildDailyWorkQueue({...base,language:'en',contacts:[],tasks:[],events:[],leads:[{...systemLead,intent:'Mein eigener Objekttext',nextAction:'Persönlich mit Anna klären'}]});
 assert.equal(personal[0].title,'Mein eigener Objekttext');
 assert.ok(personal[0].meta.includes('Persönlich mit Anna klären'));
 const german=buildDailyWorkQueue({...base,contacts:[],tasks:[],events:[],leads:[systemLead]});
 assert.equal(german[0].title,systemLead.intent);
 assert.ok(german[0].meta.includes(systemLead.nextAction));
});
