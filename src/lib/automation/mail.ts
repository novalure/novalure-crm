/** Transactional CRM messages require an explicit, reviewed purpose for one recipient. */
export const automationMailPurposes = ['salesFollowUp','meetingFollowUp'] as const;
export type AutomationMailPurpose = typeof automationMailPurposes[number];
export type AutomationMailDelivery = { id:string;status:'claimed'|'accepted'|'failed'|'uncertain'|'suppressed'|'deferred';error:string|null;acceptedAt:string|null;createdAt:string;providerStatus?:'sent'|'delivered'|'delayed'|'failed'|'bounced'|'complained'|'suppressed'|null };
export type AutomationMailPreview = { draftId:string;workspaceId:string;projectId:string|null;to:string;contactName:string;from:string;subject:string;body:string;purpose:AutomationMailPurpose;approvalDigest:string;issues:string[];canSend:boolean;delivery:AutomationMailDelivery|null };
export const automationMailPurposeLabels:Record<AutomationMailPurpose,string> = {salesFollowUp:'Antwort auf eine konkrete Immobilienanfrage',meetingFollowUp:'Nachbereitung eines vereinbarten Termins'};
export function automationMailText(value:string, substitutions:{contactName:string;projectName:string;agentName:string;requestUrl?:string}) {
 return value.replaceAll('{{contact.name}}',substitutions.contactName).replaceAll('{{project.name}}',substitutions.projectName).replaceAll('{{agent.name}}',substitutions.agentName).replaceAll('{{request.url}}',substitutions.requestUrl??'');
}
export function automationMailContentIssues(subject:string,body:string) {
 const issues:string[]=[];
 if(!subject.trim()||subject.length>300||/[\r\n\x00-\x1f\x7f]/.test(subject))issues.push('Der Betreff muss ausgefüllt sein und darf keine Steuerzeichen enthalten.');
 if(!body.trim()||body.length>15000||/\x00/.test(body))issues.push('Der Nachrichtentext ist leer oder zu lang.');
 if(/\{\{[^}]*\}\}/.test(subject+' '+body))issues.push('Die Nachricht enthält unbekannte Platzhalter.');
 return issues;
}
export function renderAutomationMail(body:string) {
 const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
 let offset=0,linked='';
 for(const match of body.matchAll(/https?:\/\/[^\s<>"']+/g)){
  linked+=escape(body.slice(offset,match.index));let allowed=false;
  try {const url=new URL(match[0]);allowed=['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}catch{}
  const url=escape(match[0]);linked+=allowed?`<a href="${url}">${url}</a>`:url;offset=match.index+match[0].length;
 }
 linked+=escape(body.slice(offset));
 return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div style="font-family:Arial,sans-serif;line-height:1.6;white-space:pre-wrap">${linked}</div></body></html>`;
}
