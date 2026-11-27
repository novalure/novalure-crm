import type { CalendarEvent, Contact, DailyQueueActionSection, Lead, Project, Task, WorkspaceUser } from "@/lib/crm-types";
import { getCrmSourceLabel, getCrmSystemTextLabel, getCrmTaskPriorityLabel, type LanguageCode } from "@/lib/i18n";
import { formatTaskDue, taskDueState } from "@/lib/task-due";

export type DailyWorkItem = {
  id:string; leadId?:string; kind:"newLead"|"hotLead"|"callback"|"meeting"|"overdueTask"|"task";
  title:string; meta:string[]; owner:string; source:string; projectName:string;
  actionSection:DailyQueueActionSection; rank:number;
};
type Input={workspaceId?:string;projectId?:string|null;contacts:Contact[];leads:Lead[];tasks:Task[];events:CalendarEvent[];projects:Project[];users:WorkspaceUser[];language:LanguageCode;now:Date;timeZone:string};
/** Uses saved statuses and task types; words in a title never turn a task into a callback. */
export function buildDailyWorkQueue(input:Input):DailyWorkItem[]{
  const de=input.language==='de',scope=(record:{workspaceId:string;projectId:string})=>(!input.workspaceId||record.workspaceId===input.workspaceId)&&(!input.projectId||record.projectId===input.projectId);
  const owner=(id:string|undefined)=>input.users.find(user=>user.id===id&&(!input.workspaceId||user.workspaceId===input.workspaceId))?.name||(id?(de?'Zuständigkeit nicht verfügbar':'Owner unavailable'):(de?'Nicht zugewiesen':'Unassigned'));
  const project=(id:string)=>input.projects.find(project=>project.id===id&&(!input.workspaceId||project.workspaceId===input.workspaceId))?.name||(de?'Ohne Projekt':'No project');
  const contact=(id:string,record:{workspaceId:string;projectId:string})=>input.contacts.find(contact=>contact.id===id&&contact.workspaceId===record.workspaceId&&contact.projectId===record.projectId);
  const compact=(items:(string|undefined)[])=>items.filter((item):item is string=>Boolean(item));
  const leads=input.leads.filter(scope).filter(lead=>lead.status!=='Archiviert').flatMap<DailyWorkItem>(lead=>{
    const pending=lead.status==='Neu'&&!lead.lastContactAt,hot=lead.hotStatus||lead.score>=80;
    if(!pending&&!hot)return [];
    const due=taskDueState(lead.slaDueAt,input.now,input.timeZone),received=Date.parse(lead.receivedAt);
    return [{id:`lead:${lead.id}`,leadId:lead.id,kind:pending?'newLead':'hotLead',title:contact(lead.contactId,lead)?.name||getCrmSystemTextLabel(lead.intent,input.language),
      meta:compact([getCrmSystemTextLabel(lead.status,input.language),getCrmSystemTextLabel(lead.nextAction,input.language),Number.isFinite(received)?new Intl.DateTimeFormat(de?'de-AT':'en-IE',{dateStyle:'short',timeStyle:'short',timeZone:input.timeZone}).format(new Date(received)):undefined,due.dueAt?formatTaskDue(lead.slaDueAt,input.language,input.timeZone,input.now):undefined]),
      source:getCrmSourceLabel(lead.source,input.language),owner:owner(lead.assignedToUserId),projectName:project(lead.projectId),actionSection:'leadInbox',rank:pending?(due.overdue?0:2000):8000-lead.score}];
  });
  const tasks=input.tasks.filter(scope).filter(task=>task.status==='open').flatMap<DailyWorkItem>(task=>{
    const due=taskDueState(task.due,input.now,input.timeZone),callback=task.actionType==='callback';
    if(!due.overdue&&due.group!=='today'&&task.priority!=='Hoch')return [];
    const kind:DailyWorkItem['kind']=callback&&(due.overdue||due.group==='today')?'callback':due.overdue?'overdueTask':'task';
    return [{id:`task:${task.id}`,leadId:task.leadId,kind,title:task.title,meta:compact([formatTaskDue(task.due,input.language,input.timeZone,input.now),task.contactId?contact(task.contactId,task)?.name:undefined,getCrmTaskPriorityLabel(task.priority,input.language)]),
      owner:owner(task.ownerUserId),source:task.origin==='automation'?(de?'Automation':'Automation'):(de?'CRM-Aufgabe':'CRM task'),projectName:project(task.projectId),actionSection:'tasks',rank:(due.overdue?1000:callback?3000:5000)+(task.priority==='Hoch'?0:100)+(due.dueAt?.getTime()??0)/100000000000}];
  });
  const dateKey=(date:Date)=>new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:input.timeZone}).format(date);
  const today=dateKey(input.now);
  const events=input.events.filter(scope).filter(event=>event.status!=='abgesagt'&&Number.isFinite(Date.parse(event.startsAt))&&dateKey(new Date(event.startsAt))===today).map<DailyWorkItem>(event=>({
    id:`event:${event.id}`,leadId:event.leadId,kind:'meeting',title:event.title,meta:compact([new Intl.DateTimeFormat(de?'de-AT':'en-IE',{hour:'2-digit',minute:'2-digit',timeZone:input.timeZone}).format(new Date(event.startsAt)),event.location,event.contactId?contact(event.contactId,event)?.name:undefined]),
    owner:owner(event.ownerUserId),source:event.calendarProvider==='microsoft'?'Microsoft 365':event.calendarProvider==='google'?'Google Workspace':(de?'CRM-Kalender':'CRM calendar'),projectName:project(event.projectId),actionSection:'calendar',rank:4000+Date.parse(event.startsAt)/100000000000}));
  return [...leads,...tasks,...events].sort((left,right)=>left.rank-right.rank||left.id.localeCompare(right.id));
}
