import {CrmCommandError} from '@/lib/crm-command';
import type {FunnelBlueprint,FunnelSubmissionPayload} from '@/lib/funnel-schema';
import {funnelRuntimeFields,projectFunnelCrmAnswers} from '@/lib/funnel-runtime';
export {funnelFormFields,runFunnelPreflight} from '@/lib/funnel-publication';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function parseFunnelBlueprint(value:unknown):FunnelBlueprint{
 const fail=()=>{throw new CrmCommandError('INVALID_BLUEPRINT','Die Funnel-Struktur ist ungültig.');};
 if(!object(value)||JSON.stringify(value).length>1_000_000||value.schemaVersion!==1||!['id','workspaceId','projectId','name','goal','audience','entryChannel'].every(k=>typeof value[k]==='string'&&value[k].trim()&&String(value[k]).length<=1000)||!['aktiv','optimieren','entwurf'].includes(String(value.status))||!object(value.theme)||!object(value.tracking)||!object(value.crmHandover)||!Array.isArray(value.pages)||!value.pages.length||value.pages.length>50)fail();
 const b=value as unknown as FunnelBlueprint;
 if(!['leadInbox','pipeline','calendar','newsletter'].includes(b.crmHandover.destination))fail();
 for(const key of ['createLeadInboxEntry','createTask','createAppointment'])if(typeof (b.crmHandover as unknown as Record<string,unknown>)[key]!=='boolean')fail();
 try{for(const p of b.pages){if(!p.id||!Array.isArray(p.sections))fail();for(const s of p.sections)for(const r of s.rows)for(const c of r.columns)for(const e of c.elements){if(!e.id||typeof e.type!=='string')fail();if(e.type==='form'&&(!Array.isArray(e.fields)||e.fields.some(f=>!f.id||typeof f.label!=='string'||typeof f.required!=='boolean')))fail();}}}catch{fail();}
 return b;
}
export function parseFunnelSubmission(value:unknown,b:FunnelBlueprint):FunnelSubmissionPayload{
 if(!object(value)||!['test','live'].includes(String(value.mode))||value.funnelId!==b.id||!object(value.answers)||!object(value.consent)||value.consent.privacy!==true||!['analytics','marketing'].every(k=>typeof (value.consent as Record<string,unknown>)[k]==='boolean')||!object(value.visitor)||JSON.stringify(value).length>80_000)throw new CrmCommandError('INVALID_SUBMISSION','Anfrage und Datenschutzeinwilligung prüfen.',422);
 const payload=value as unknown as FunnelSubmissionPayload,fields=funnelRuntimeFields(b),allowed=new Set(fields.map(f=>f.id));
 if(Object.keys(payload.answers).some(k=>!allowed.has(k)))throw new CrmCommandError('INVALID_ANSWERS','Die Formularfelder haben sich geändert.',422);
 for(const field of fields){const v=payload.answers[field.id];if(field.required&&(v===undefined||v===null||v===''||v===false||(Array.isArray(v)&&!v.length)))throw new CrmCommandError('REQUIRED_FIELD',`Pflichtfeld fehlt: ${field.label}`,422);if(v!==undefined&&v!==null&&typeof v!=='boolean'&&typeof v!=='number'&&typeof v!=='string'&&!(Array.isArray(v)&&v.every(i=>typeof i==='string')))throw new CrmCommandError('INVALID_ANSWER','Ungültige Formularantwort.',422);if(field.type==='consent'&&field.crmField==='privacy_consent'&&v!==true)throw new CrmCommandError('PRIVACY_REQUIRED','Datenschutzeinwilligung erforderlich.',422);if(['singleChoice','dropdown'].includes(field.type)&&typeof v==='string'&&v&&!(field.options??[]).includes(v))throw new CrmCommandError('INVALID_ANSWER','Auswahl gehört nicht zum Formular.',422);if(field.type==='email'&&typeof v==='string'&&v&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))throw new CrmCommandError('INVALID_EMAIL','E-Mail-Adresse prüfen.',422);}
 if(payload.consent.marketing&&!fields.some(f=>f.type==='consent'&&f.crmField==='marketing_consent'&&payload.answers[f.id]===true))throw new CrmCommandError('MARKETING_CONSENT_REQUIRED','Eine gesonderte Marketingeinwilligung ist erforderlich.',422);
 if(payload.consent.analytics&&!fields.some(f=>f.type==='consent'&&f.crmField==='analytics_consent'&&payload.answers[f.id]===true))throw new CrmCommandError('ANALYTICS_CONSENT_REQUIRED','Eine gesonderte Statistikeinwilligung ist erforderlich.',422);
 try{projectFunnelCrmAnswers(b,payload.answers);}catch{throw new CrmCommandError('INVALID_ANSWERS','Die Feldzuordnung ist nicht eindeutig. Bitte Formular neu laden.',422);}return payload;
}
