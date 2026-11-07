import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { applyMarketingFormFixture } from "./lib/marketing-form-fixture.mjs";
import {
  mutateMarketing,
  normalizeMarketingVariants,
  readMarketingWorkspace,
} from "../src/lib/db/marketing-repository";
import {
  createNewsletterDraft,
  saveNewsletterDraft,
  configureNewsletterMarketing,
  previewNewsletterAudience,
  previewNewsletterRecipients,
  approveNewsletter,
  sendNewsletterBatch,
  readNewsletterWorkspace,
} from "../src/lib/db/newsletter-workspace-repository";
import { emptyNewsletterDraft } from "../src/lib/newsletter-workspace";
import {
  emptyMarketingSelection,
  starterMarketingVariants,
  missingNewsletterVariables,
} from "../src/lib/marketing-domain";
let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
const w = randomUUID(),
  foreignW = randomUUID(),
  owner = randomUUID(),
  agent = randomUUID(),
  foreignOwner = randomUUID(),
  project = randomUUID(),
  otherProject = randomUUID(),
  foreignProject = randomUUID(),
  contact = randomUUID(),
  blocked = randomUUID(),
  foreignContact = randomUUID();
const meta = () => ({
  idempotencyKey: randomUUID(),
  correlationId: randomUUID(),
});
const session = (
  actor = owner,
  role: AppSession["role"] = "owner",
  productRole: AppSession["productRole"] = "customer_owner",
): AppSession => ({
  authenticated: true,
  userId: actor,
  workspaceId: w,
  workspaceName: "SYNTHETIC Marketing",
  name: "SYNTHETIC Owner",
  email: "owner@example.invalid",
  role,
  productRole,
  permissions: [],
  productPermissions: [],
  source: "database",
});
const sent: unknown[] = [];
const options = () => ({
  pool: db.pool as unknown as TenantPool,
  origin: "https://synthetic.example.invalid",
  provider: () => ({
    configured: true,
    external: true,
    provider: "resend" as const,
    from: "SYNTHETIC <mailing@example.invalid>",
    reason: null,
  }),
  transport: async (payload: unknown) => {
    sent.push(payload);
    return {
      status: "accepted" as const,
      messageId: "synthetic-" + sent.length,
    };
  },
});
const mutate = (input: Record<string, unknown>, metadata = meta()) =>
  mutateMarketing(
    session(),
    { projectId: project, expectedRevision: 0, ...input },
    metadata,
    options(),
  );
const ready = () => ({
  ...emptyNewsletterDraft("mailing@example.invalid", "SYNTHETIC Company"),
  language: "en" as const,
  legalAddress: "SYNTHETIC Example Street 1",
  subject: "News for {{contact.name}}",
  previewText: "Project update",
  contentBlocks: [
    {
      id: "text",
      type: "text" as const,
      text: "Hello {{contact.name}}, {{project.name}} from {{agent.name}}.",
    },
  ],
});
async function campaign() {
  const c = await createNewsletterDraft(
    session(),
    {
      projectId: project,
      name: "SYNTHETIC " + randomUUID(),
      audience: "Käufer",
      language: "en",
    },
    meta(),
    options(),
  );
  return saveNewsletterDraft(
    session(),
    { campaignId: c.data.campaignId, expectedRevision: 1, draft: ready() },
    meta(),
    options(),
  );
}
before(async () => {
  db = await startLocalSalesDb();
  await applySalesSchema(db, { maxMigrationNumber: 106 });
  await applyMarketingFormFixture(db);
  await db.admin.query(await readFile("migrations/154_automation_graph.sql", "utf8"));
  await db.admin.query(
    await readFile("migrations/157_newsletter_workspace.sql", "utf8"),
  );
  await db.admin.query(await readFile("migrations/165_automation_mail.sql", "utf8"));
  await db.admin.query(
    await readFile("migrations/180_marketing_data.sql", "utf8"),
  );
  await db.admin.query(await readFile("migrations/181_funnel_live_templates.sql", "utf8"));
  await db.admin.query(
    "insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Marketing','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')",
    [w, foreignW],
  );
  for (const [id, workspace, role, product] of [
    [owner, w, "owner", "customer_owner"],
    [agent, w, "agent", "project_sales_member"],
    [foreignOwner, foreignW, "owner", "customer_owner"],
  ])
    await db.admin.query(
      "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC User',$3,$4,$5,'active')",
      [id, workspace, id + "@example.invalid", role, product],
    );
  await db.admin.query(
    "insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC Project','Test'),($2,$4,'SYNTHETIC Other','Test'),($3,$5,'SYNTHETIC Foreign','Test')",
    [project, otherProject, foreignProject, w, foreignW],
  );
  await db.admin.query(
    "insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)",
    [w, project, agent],
  );
  for (const [id, workspace, target, actor, email] of [
    [contact, w, project, owner, "allowed@example.invalid"],
    [blocked, w, project, owner, "blocked@example.invalid"],
    [
      foreignContact,
      foreignW,
      foreignProject,
      foreignOwner,
      "foreign@example.invalid",
    ],
  ]) {
    await db.admin.query(
      "insert into contacts(id,workspace_id,project_id,owner_user_id,name,email,role,consent_label) values($1,$2,$3,$4,'SYNTHETIC Recipient',$5,'Käufer','Opt-in')",
      [id, workspace, target, actor, email],
    );
    await db.admin.query(
      "insert into consent_records(workspace_id,project_id,contact_id,channel,status,source) values($1,$2,$3,'Newsletter','Opt-in','SYNTHETIC explicit')",
      [workspace, target, id],
    );
  }
  await db.admin.query(
    "insert into newsletter_suppressions(workspace_id,email,reason,source) values($1,'blocked@example.invalid','complaint','SYNTHETIC')",
    [w],
  );
});
after(async () => {
  if (db) await db.stop();
});
test("canonical tags preserve subject IDs, audit/idempotency and strict CAS/project scope", async () => {
  const metadata = meta(),
    input = { action: "tag", name: "SYNTHETIC Spain" };
  const tag = await mutate(input, metadata),
    replay = await mutate(input, metadata);
  assert.equal(replay.replayed, true);
  assert.equal(tag.data.id, replay.data.id);
  const assigned = await mutate({
    action: "assignTag",
    tagId: tag.data.id,
    subjectType: "contact",
    subjectId: contact,
    active: true,
    source: "SYNTHETIC chosen interest",
  });
  assert.equal(assigned.data.revision, 1);
  await assert.rejects(
    mutate({
      action: "assignTag",
      tagId: tag.data.id,
      subjectType: "contact",
      subjectId: contact,
      active: false,
      source: "SYNTHETIC stale",
    }),
    /geändert/,
  );
  await assert.rejects(
    mutate({
      action: "assignTag",
      tagId: tag.data.id,
      subjectType: "contact",
      subjectId: foreignContact,
      active: true,
      source: "SYNTHETIC foreign",
    }),
    /nicht verfügbar/,
  );
  await assert.rejects(
    mutate({
      action: "assignTag",
      projectId: otherProject,
      tagId: tag.data.id,
      subjectType: "contact",
      subjectId: contact,
      active: true,
      source: "SYNTHETIC other project",
    }),
    /nicht verfügbar/,
  );
  const row = (
    await db.admin.query(
      "select contact_id,source from crm_marketing_tag_assignments where id=$1",
      [assigned.data.id],
    )
  ).rows[0];
  assert.equal(row.contact_id, contact);
  assert.match(row.source, /chosen interest/);
  assert.equal(
    (
      await db.admin.query(
        "select count(*)::integer as count from crm_command_receipts where workspace_id=$1 and operation=$2",
        [w, "crm.marketing.tag"],
      )
    ).rows[0].count,
    1,
  );
  await assert.rejects(
    mutateMarketing(
      session(agent, "agent", "project_sales_member"),
      {
        action: "profile",
        projectId: project,
        expectedRevision: 1,
        contactId: contact,
        countryCode: "AT",
        preferredLanguage: "de",
        timezone: "Europe/Vienna",
      },
      meta(),
      options(),
    ),
    /nicht verfügbar/,
  );
});
test("country/language/interests use real current recipients; tags never override suppression", async () => {
  const tag = await mutate({ action: "tag", name: "SYNTHETIC exact audience" });
  for (const id of [contact, blocked]) {
    await mutate({
      action: "profile",
      contactId: id,
      expectedRevision: 1,
      countryCode: "AT",
      preferredLanguage: "en",
      timezone: "Europe/Vienna",
    });
    await mutate({
      action: "assignTag",
      tagId: tag.data.id,
      subjectType: "contact",
      subjectId: id,
      active: true,
      source: "SYNTHETIC audience",
    });
  }
  const audience = await mutate({
    action: "audience",
    name: "SYNTHETIC AT English",
    audience: "Käufer",
    selection: {
      ...emptyMarketingSelection(),
      countries: ["AT"],
      languages: ["en"],
      tagIds: [tag.data.id],
    },
  });
  const preview = await previewNewsletterAudience(
    session(),
    project,
    audience.data.id,
    options(),
  );
  assert.equal(preview.eligible, 1);
  assert.equal(preview.excluded, 1);
  assert.equal(
    preview.recipients.find((r) => r.contactId === blocked)?.reason,
    "newsletter_suppression",
  );
  const c = await campaign(),
    configured = await configureNewsletterMarketing(
      session(),
      {
        campaignId: c.data.campaignId,
        expectedRevision: c.data.revision,
        segmentId: audience.data.id,
      },
      meta(),
      options(),
    );
  assert.deepEqual(
    (await previewNewsletterRecipients(session(), c.data.campaignId, options()))
      .recipients,
    preview.recipients,
  );
  await approveNewsletter(
    session(),
    {
      campaignId: c.data.campaignId,
      expectedRevision: configured.data.revision,
    },
    meta(),
    options(),
  );
  const assignment = (
    await db.admin.query(
      "select revision from crm_marketing_tag_assignments where tag_id=$1 and contact_id=$2",
      [tag.data.id, contact],
    )
  ).rows[0];
  await mutate({
    action: "assignTag",
    tagId: tag.data.id,
    subjectType: "contact",
    subjectId: contact,
    expectedRevision: assignment.revision,
    active: false,
    source: "SYNTHETIC interest withdrawn",
  });
  const before = sent.length;
  await sendNewsletterBatch(
    session(),
    {
      campaignId: c.data.campaignId,
      expectedRevision: configured.data.revision,
    },
    meta(),
    options(),
  );
  assert.equal(sent.length, before);
  assert.equal(
    (
      await db.admin.query(
        "select status,error from crm_newsletter_deliveries where campaign_id=$1",
        [c.data.campaignId],
      )
    ).rows[0].status,
    "suppressed",
  );
  await assert.rejects(
    previewNewsletterAudience(
      session(),
      foreignProject,
      audience.data.id,
      options(),
    ),
    /Project access/,
  );
});
test("saved multilingual template revisions are immutable and truly feed the mailing draft", async () => {
  const template = await mutate({
      action: "template",
      name: "SYNTHETIC Three languages",
      variants: starterMarketingVariants(),
    }),
    c = await campaign();
  const configured = await configureNewsletterMarketing(
    session(),
    {
      campaignId: c.data.campaignId,
      expectedRevision: c.data.revision,
      templateId: template.data.id,
      templateRevision: 1,
      language: "es",
    },
    meta(),
    options(),
  );
  assert.equal(configured.data.campaignId, c.data.campaignId);
  let source = await readNewsletterWorkspace(session(), project, options());
  const actual = source.drafts.find((d) => d.campaignId === c.data.campaignId)!;
  assert.equal(actual.input.language, "es");
  assert.match(actual.input.subject, /Novedades/);
  assert.equal(
    source.templateBindings.find((b) => b.campaignId === c.data.campaignId)
      ?.revision,
    1,
  );
  const variants = starterMarketingVariants();
  variants.es!.subject = "SYNTHETIC changed later";
  await mutate({
    action: "template",
    id: template.data.id,
    expectedRevision: 1,
    name: "SYNTHETIC Three languages",
    variants,
  });
  source = await readNewsletterWorkspace(session(), project, options());
  assert.match(
    source.drafts.find((d) => d.campaignId === c.data.campaignId)!.input
      .subject,
    /Novedades/,
  );
  await assert.rejects(
    mutate({
      action: "template",
      id: template.data.id,
      expectedRevision: 1,
      name: "SYNTHETIC stale",
      variants,
    }),
    /geändert/,
  );
  await assert.rejects(
    db.admin.query(
      "update crm_marketing_template_versions set name='WRONG' where template_id=$1",
      [template.data.id],
    ),
    /immutable|Immutable/,
  );
  await assert.rejects(
    configureNewsletterMarketing(
      session(),
      {
        campaignId: c.data.campaignId,
        expectedRevision: configured.data.revision,
        templateId: template.data.id,
        templateRevision: 99,
        language: "de",
      },
      meta(),
      options(),
    ),
    /nicht verfügbar/,
  );
  assert.throws(
    () =>
      normalizeMarketingVariants({
        de: {
          subject: "{{secret.token}}",
          previewText: "",
          contentBlocks: [{ id: "x", type: "text", text: "x" }],
        },
      }),
    /Pflichtvariable/,
  );
});
test("missing recipient variables block approval instead of silently dropping content", async () => {
  assert.deepEqual(
    missingNewsletterVariables(ready(), {
      projectName: "Project",
      agentName: "Agent",
    }),
    ["{{contact.name}}"],
  );
  const c = await campaign();
  await db.admin.query("update contacts set name='' where id=$1", [contact]);
  const preview = await previewNewsletterRecipients(
    session(),
    c.data.campaignId,
    options(),
  );
  assert.ok(preview.issues.some((issue) => /Pflichtvariablen/.test(issue)));
  await assert.rejects(
    approveNewsletter(
      session(),
      { campaignId: c.data.campaignId, expectedRevision: c.data.revision },
      meta(),
      options(),
    ),
    /Pflichtvariable/,
  );
  await db.admin.query(
    "update contacts set name='SYNTHETIC Recipient' where id=$1",
    [contact],
  );
});
test("initiatives link actual canonical newsletter IDs and reject another project", async () => {
  const initiative = await mutate({
      action: "initiative",
      name: "SYNTHETIC Launch",
      goal: "SYNTHETIC original source campaign",
    }),
    c = await campaign();
  const link = await mutate({
    action: "sourceLink",
    initiativeId: initiative.data.id,
    kind: "newsletter",
    sourceId: c.data.campaignId,
    active: true,
  });
  assert.equal(
    (
      await db.admin.query(
        "select source_id from crm_marketing_source_links where id=$1",
        [link.data.id],
      )
    ).rows[0].source_id,
    c.data.campaignId,
  );
  const other = await mutate({
    action: "initiative",
    projectId: otherProject,
    name: "SYNTHETIC Other",
    goal: "",
  });
  await assert.rejects(
    mutate({
      action: "sourceLink",
      projectId: otherProject,
      initiativeId: other.data.id,
      kind: "newsletter",
      sourceId: c.data.campaignId,
      active: true,
    }),
    /scope mismatch/,
  );
});

test("source reports retain actual UTM and distinguish older first submissions from follow-ups", async () => {
  const funnel = randomUUID(), form = randomUUID(), firstLead = randomUUID(), newLead = randomUUID();
  await db.admin.query("insert into funnels(id,workspace_id,project_id,owner_user_id,name,goal,audience,entry_channel,status) values($1,$2,$3,$4,'SYNTHETIC Source funnel','Enquiry','Alle','Website','aktiv')",[funnel,w,project,owner]);
  await db.admin.query("insert into forms(id,workspace_id,project_id,owner_user_id,name,slug,status) values($1::uuid,$2,$3,$4,'SYNTHETIC Source form',$1::uuid::text,'aktiv')",[form,w,project,owner]);
  for (const id of [firstLead,newLead]) await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type,source) values($1,$2,$3,$4,$5,'Käufer','SYNTHETIC Source')",[id,w,project,contact,owner]);
  const tracking=JSON.stringify({utm:{utm_source:'synthetic-meta',utm_medium:'paid-social',utm_campaign:'synthetic-launch'}});
  await db.admin.query("insert into funnel_submissions(workspace_id,project_id,funnel_id,contact_id,lead_id,tracking,created_at) values($1,$2,$3,$4,$5,$6::jsonb,clock_timestamp()-interval '60 days'),($1,$2,$3,$4,$5,$6::jsonb,clock_timestamp())",[w,project,funnel,contact,firstLead,tracking]);
  await db.admin.query("insert into form_submissions(workspace_id,project_id,form_id,contact_id,lead_id,tracking) values($1,$2,$3,$4,$5,$6::jsonb)",[w,project,form,contact,newLead,tracking]);
  const report=await readMarketingWorkspace(session(),project,{...options(),days:30});
  assert.equal(report.report.days,30);
  const repeat=report.attribution.find(row=>row.sourceId===funnel)!;
  assert.ok(repeat,JSON.stringify({report:report.report,sources:report.sources.map(row=>({kind:row.kind,id:row.id})),attribution:report.attribution}));
  assert.deepEqual({source:repeat.source,medium:repeat.medium,campaign:repeat.campaign,submissions:repeat.submissions,first:repeat.firstRecorded,subsequent:repeat.subsequent},{source:'synthetic-meta',medium:'paid-social',campaign:'synthetic-launch',submissions:1,first:0,subsequent:1});
  assert.equal(report.attribution.find(row=>row.sourceId===form)?.firstRecorded,1);
  assert.equal(report.sources.find(row=>row.id===funnel)?.results.incomingSubmissions,1);
  const broader=await readMarketingWorkspace(session(),project,{...options(),days:90});
  assert.equal(broader.attribution.find(row=>row.sourceId===funnel)?.firstRecorded,1);
  assert.equal(broader.attribution.find(row=>row.sourceId===funnel)?.submissions,2);
  const limited=await readMarketingWorkspace(session(agent,'agent','project_sales_member'),project,options());
  assert.equal(limited.report.canReadResults,true);
  assert.deepEqual(limited.attribution,[]);
  assert.ok(limited.sources.filter(row=>row.kind==='form'||row.kind==='funnel').every(row=>row.results.incomingSubmissions===0));
});

test("disabled modules expose no contacts, audiences or source results and cannot be mutated", async () => {
  await db.admin.query("update workspaces set setup_state=jsonb_build_object('enabledModules',jsonb_build_object('contacts',false,'newsletter',false,'funnels',false,'analytics',false)) where id=$1",[w]);
  try {
    const state=await readMarketingWorkspace(session(),project,options());
    assert.deepEqual(state.contacts,[]);assert.deepEqual(state.tags,[]);assert.deepEqual(state.audiences,[]);assert.deepEqual(state.templates,[]);
    assert.equal(state.sources.some(row=>['newsletter','form','funnel'].includes(row.kind)),false);
    assert.equal(state.report.canReadResults,false);assert.deepEqual(state.attribution,[]);assert.ok(state.sources.every(row=>!Object.keys(row.results).length));
    await assert.rejects(mutate({action:'tag',name:'SYNTHETIC disabled'}),/ausgeschaltet/);
    await assert.rejects(mutate({action:'template',name:'SYNTHETIC disabled',variants:starterMarketingVariants()}),/ausgeschaltet/);
  } finally { await db.admin.query("update workspaces set setup_state='{}'::jsonb where id=$1",[w]); }
});

test("malformed placeholders cannot become a saved reusable template or an approved mailing",async()=>{
 for(const subject of ['Hallo {{contact.name','Hallo {{}}','Hallo contact.name}}','Hallo {{contact.{{name}}']){
  const variants={de:{subject,previewText:'SYNTHETIC',contentBlocks:[{id:'text',type:'text',text:'Hello'}]}};
  await assert.rejects(mutate({action:'template',name:'SYNTHETIC invalid variables',variants}),/Pflichtvariable/);
  const c=await campaign();
  const saved=await saveNewsletterDraft(session(),{campaignId:c.data.campaignId,expectedRevision:c.data.revision,draft:{...ready(),subject}},meta(),options());
  const review=await previewNewsletterRecipients(session(),c.data.campaignId,options());assert.ok(review.issues.some(issue=>/Pflichtvariable/.test(issue)));
  await assert.rejects(approveNewsletter(session(),{campaignId:c.data.campaignId,expectedRevision:saved.data.revision},meta(),options()),/Pflichtvariable/);
  assert.equal((await db.admin.query('select count(*)::integer as count from crm_newsletter_deliveries where campaign_id=$1',[c.data.campaignId])).rows[0].count,0);
 }
});

test("related outcomes use distinct exact lead links, real confirmation states and accepted lead-specific flowmail only",async()=>{
 const funnel=randomUUID(),lead=randomUUID(),organization=randomUUID(),authority=randomUUID(),automation=randomUUID(),event=randomUUID(),enrollment=randomUUID();
 await db.admin.query("insert into funnels(id,workspace_id,project_id,owner_user_id,name,goal,audience,entry_channel,status) values($1,$2,$3,$4,'SYNTHETIC Outcome source','Enquiry','Alle','Website','aktiv')",[funnel,w,project,owner]);
 await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type,source,received_at) values($1,$2,$3,$4,$5,'Käufer','SYNTHETIC Outcome',clock_timestamp()-interval '2 hours')",[lead,w,project,contact,owner]);
 await db.admin.query("insert into funnel_submissions(workspace_id,project_id,funnel_id,contact_id,lead_id,created_at) values($1,$2,$3,$4,$5,clock_timestamp()-interval '2 hours'),($1,$2,$3,$4,$5,clock_timestamp()-interval '1 hour')",[w,project,funnel,contact,lead]);
 const units=Array.from({length:6},()=>randomUUID()),reservations=Array.from({length:6},()=>randomUUID());
 for(let index=0;index<units.length;index++)await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,price_cents,status) values($1,$2,$3,$4,100000,'available')",[units[index],w,project,'SYNTHETIC-'+index]);
 const proof={sourceReference:'SYNTHETIC authorized evidence',confirmedBy:owner,authorityId:authority,confirmedAt:new Date().toISOString()};
 for(const[index,status,expiry,confirmation]of[[0,'reserved','+1 hour',proof],[1,'requested','+1 hour',null],[2,'hold','+1 hour',null],[3,'reserved','-1 hour',proof],[4,'converted','+1 hour',proof],[5,'reserved','+1 hour',null]] as const)await db.admin.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,buyer_lead_id,status,expires_at,confirmation) values($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8::interval,$9::jsonb)",[reservations[index],w,project,units[index],contact,lead,status,expiry,confirmation?JSON.stringify(confirmation):null]);
 for(const status of['confirmed','planned','cancelled'])await db.admin.query("insert into property_viewing_slots(workspace_id,project_id,unit_id,contact_id,lead_id,owner_user_id,starts_at,ends_at,status) values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day 1 hour',$7)",[w,project,units[0],contact,lead,owner,status]);
 await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC Outcome developer','Bauträger')",[organization,w,project]);
 await db.admin.query("insert into crm_project_sales_authorities(id,workspace_id,project_id,user_id,developer_organization_id,contact_id,can_confirm_sale,assignment_source,assigned_by) values($1,$2,$3,$4,$5,$6,true,'SYNTHETIC authority',$4)",[authority,w,project,owner,organization,contact]);
 await db.admin.query("insert into property_sales(workspace_id,project_id,unit_id,reservation_id,buyer_lead_id,contact_id,authority_id,confirmed_by,source_reference,confirmed_at,unit_version) values($1,$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC confirmed sale',clock_timestamp()-interval '30 minutes',1)",[w,project,units[4],reservations[4],lead,contact,authority,owner]);
 for(const[closed,stage]of[[new Date(Date.now()-1800000).toISOString(),'Gewonnen'],[null,'Gewonnen'],[new Date(Date.now()-10800000).toISOString(),'Gewonnen'],[null,'Neuer Lead']])await db.admin.query("insert into deals(workspace_id,project_id,contact_id,lead_id,name,stage,closed_at) values($1,$2,$3,$4,'SYNTHETIC Outcome deal',$5,$6)",[w,project,contact,lead,stage,closed]);
 const graph={schemaVersion:1,trigger:'new_lead',timezone:'UTC',businessHours:false,stopOnPersonalContact:true,nodes:[{id:'start',type:'start',title:'Start'},{id:'mail',type:'email_draft',title:'Mail',subject:'SYNTHETIC',body:'SYNTHETIC'},{id:'end',type:'stop',title:'End'}],edges:[{from:'start',to:'mail',port:'next'},{from:'mail',to:'end',port:'next'}]};
 await db.admin.query("insert into crm_automations(id,workspace_id,project_id,name,draft,active_version,status,created_by) values($1,$2,$3,'SYNTHETIC Outcome flow',$4::jsonb,1,'active',$5)",[automation,w,project,JSON.stringify(graph),owner]);
 await db.admin.query("insert into crm_automation_versions(workspace_id,project_id,automation_id,version,graph,graph_digest,created_by) values($1,$2,$3,1,$4::jsonb,$5,$6)",[w,project,automation,JSON.stringify(graph),'a'.repeat(64),owner]);
 await db.admin.query("insert into crm_automation_events(id,workspace_id,project_id,lead_id,event_key,trigger_key) values($1,$2,$3,$4,$5,'new_lead')",[event,w,project,lead,randomUUID()]);
 await db.admin.query("insert into crm_automation_enrollments(id,workspace_id,project_id,automation_id,version,lead_id,event_id,node_id,status,enrolled_at) values($1,$2,$3,$4,1,$5,$6,'mail','review',clock_timestamp()-interval '2 hours')",[enrollment,w,project,automation,lead,event]);
 for(const[status,minutes]of[['accepted',60],['uncertain',110]] as const){const draft=randomUUID();await db.admin.query("insert into crm_automation_drafts(id,workspace_id,project_id,enrollment_id,node_id,contact_id,subject,body,consent_allowed,consent_reason) values($1,$2,$3,$4,$5,$6,'SYNTHETIC','SYNTHETIC',true,'SYNTHETIC explicit')",[draft,w,project,enrollment,status,contact]);await db.admin.query("insert into crm_automation_mail_deliveries(workspace_id,project_id,draft_id,contact_id,actor_id,purpose,approval_digest,payload,status,provider_message_id,created_at,accepted_at) values($1,$2,$3,$4,$5,'salesFollowUp',$6,'{}'::jsonb,$7,$8,clock_timestamp()-make_interval(mins=>$9),case when $7='accepted' then clock_timestamp()-make_interval(mins=>$9) else null end)",[w,project,draft,contact,owner,'a'.repeat(64),status,status==='accepted'?'SYNTHETIC provider acceptance':null,minutes]);}
 await db.admin.query("insert into contact_timeline_items(workspace_id,project_id,contact_id,channel,title,detail,outcome,occurred_at,metadata) values($1,$2,$3,'Telefon','SYNTHETIC manual call','SYNTHETIC','connected',clock_timestamp()-interval '110 minutes',jsonb_build_object('source','crm_activity_manual','activityKind','call_connected','leadId',$4::text))",[w,project,contact,lead]);
 const c=await campaign(),report=await readMarketingWorkspace(session(),project,options()),actual=report.relatedOutcomes.find(row=>row.sourceId===funnel)!;
 assert.equal(actual.cohortLeads,1);assert.equal(actual.confirmedViewings,1);assert.equal(actual.bindingReservations,1);assert.equal(actual.confirmedSalesAfterEnquiry,1);assert.equal(actual.datedWonDealsAfterEnquiry,1);assert.equal(actual.wonDealsWithoutDate,1);assert.equal(actual.flowMailSampleLeads,1);assert.equal(actual.leadsWithoutFlowMailEvidence,0);assert.ok(Math.abs((actual.averageFirstFlowMailMinutes??0)-60)<1);
 assert.equal(report.relatedOutcomes.find(row=>row.sourceId===c.data.campaignId)?.cohortLeads,null);
 const limited=await readMarketingWorkspace(session(agent,'agent','project_sales_member'),project,options());assert.equal(limited.relatedOutcomes.find(row=>row.sourceId===funnel)?.cohortLeads,0);
});
