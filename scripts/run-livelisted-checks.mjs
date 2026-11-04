import {spawn} from 'node:child_process';

// Reproducible domain checks. Each database suite creates and removes its own
// disposable loopback database; serial execution avoids competing DB instances.
const suites=[
 'marketing-overview-tests.ts','marketing-contact-policy-tests.ts','marketing-data-tests.ts','mailbox-auto-sync-tests.ts','funnel-live-tests.ts','funnel-empty-state-tests.ts','web-expose-brand-layout-tests.ts',
 'property-country-tests.ts','property-country-db-tests.ts','web-expose-tracking-tests.ts','web-expose-db-tests.ts','web-expose-media-tests.ts','web-expose-template-tests.ts','web-expose-pdf-tests.ts',
 'property-completeness-tests.ts','property-completeness-ui-tests.ts','property-unit-details-tests.ts','property-fragment-roundtrip-tests.ts','property-cost-draft-tests.ts','property-public-details-tests.ts',
 'automation-graph-tests.ts','automation-database-tests.ts','automation-mail-tests.ts','lead-qualification-tests.ts','lead-qualification-plan-tests.ts','lead-customer-request-tests.ts','lead-proof-retention-tests.ts','property-booking-tests.ts',
 'property-inquiry-assignment-tests.ts','property-create-draft-tests.ts','property-asset-assignment-tests.ts','crm-team-task-tests.ts','daily-work-queue-tests.ts','crm-activity-tests.ts','crm-mailbox-tests.ts','mailbox-triage-tests.ts',
 'newsletter-workspace-tests.ts','newsletter-scheduler-tests.ts','resend-webhook-tests.ts','crm-notifications-tests.ts','crm-notification-email-tests.ts','crm-integrations-tests.ts','property-portal-tests.ts','project-sales-report-tests.ts','crm-transfer-tests.ts','crm-partner-tests.ts','crm-onboarding-tests.ts',
];
const selected=process.argv.slice(2);
if(selected.some(name=>!suites.includes(name))){console.error('Choose exact suite names from scripts/run-livelisted-checks.mjs.');process.exit(2);}
const chosen=selected.length?selected:suites;
const normalReact=new Set(['funnel-empty-state-tests.ts','property-completeness-ui-tests.ts']);
for(const condition of ['react-server','react']){
 const files=chosen.filter(name=>normalReact.has(name)===(condition==='react'));
 if(!files.length)continue;
 const code=await new Promise(resolve=>{
  const child=spawn(process.execPath,[...(condition==='react-server'?['--conditions=react-server']:[]),'--import','tsx','--test','--test-concurrency=1',...files.map(name=>'scripts/'+name)],{stdio:'inherit',windowsHide:true});
  child.once('error',error=>{console.error(error.message);resolve(1);});
  child.once('exit',code=>resolve(code??1));
 });
 if(code!==0){process.exitCode=Number(code);break;}
}
