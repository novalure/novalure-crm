// One-use owner-authorized patch. Only modifies the pinned public intake source.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const path='src/lib/db/form-repositories.ts';let source=readFileSync(path,'utf8');
const blob=createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
if(blob!=='9a77b6172f9b566d056edfc86c6c86f460ee4ed3')throw new Error('Public intake source changed; refusing patch');
function once(a,b){if(source.split(a).length!==2)throw new Error('Non-unique patch anchor');source=source.replace(a,b);}
once('const contactId = await upsertContact({','const contactResolution = await upsertContact({');
once('    workspaceId: lookup.workspaceId,\n  });\n\n  const lead =','    workspaceId: lookup.workspaceId,\n  });\n  const contactId = contactResolution.id;\n\n  const lead =');
once('  if (contactId && consent.privacy) {','  // A public address match is not proof of identity or new consent authority.\n  // Preserve the submitted evidence on this enquiry instead of altering an\n  // existing contact or creating a new global consent grant for that contact.\n  if (contactId && consent.privacy && !contactResolution.reusedExisting) {');
once('  if (contactId && consent.marketing) {','  if (contactId && consent.marketing && !contactResolution.reusedExisting) {');
once('    consent.marketing && (form.template === "newsletter" || form.actions.newsletterList)','    consent.marketing && !contactResolution.reusedExisting && (form.template === "newsletter" || form.actions.newsletterList)');
once('            answers,\n            businessLine: websiteSalesMetadata?.businessLine,','            answers,\n            contactResolution: { status: contactResolution.status, identityVerified: false },\n            businessLine: websiteSalesMetadata?.businessLine,');
const start=source.indexOf('  // Contact identity is project-scoped by design.');
const end=source.indexOf('  const contact = await queryOne<IdRow>(',start);
if(start<0||end<=start)throw new Error('Contact function boundaries missing');
source=source.slice(0,start)+`  // A public submission may suggest a match, never change existing master data.
  // Keep the registry-bound tenant/project scope, serialize shared identifiers,
  // and do not choose arbitrarily when email and phone identify different rows.
  const keys = [
    ...(input.email ? [\`public-form-contact:\${input.workspaceId}:\${input.projectId ?? "none"}:email:\${input.email.trim().toLowerCase()}\`] : []),
    ...(input.phone ? [\`public-form-contact:\${input.workspaceId}:\${input.projectId ?? "none"}:phone:\${input.phone.trim()}\`] : []),
  ].sort();
  for (const key of keys) {
    await queryOne("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
  const matches = input.email || input.phone
    ? await queryRows<IdRow>(
        \`select id from contacts
         where workspace_id = $1
           and project_id is not distinct from $4::uuid
           and (($2::text <> '' and lower(email) = lower($2))
             or ($3::text <> '' and phone = $3))
         order by id limit 2 for share\`,
        [input.workspaceId, input.email, input.phone, input.projectId],
      )
    : [];
  if (matches.length === 1) {
    return { id: matches[0].id, reusedExisting: true, status: "unverified_unique_match" as const };
  }
  // Conflicting matches remain untouched. Retain the incoming identity as a
  // separate reviewable contact, rather than merging two existing customers.
  const resolutionStatus = matches.length > 1 ? "ambiguous_match_review_required" : "new_contact";

`+source.slice(end);
once('      JSON.stringify({ answers: input.answers, formId: input.form.id, tracking: input.tracking, websiteSales: input.websiteSalesMetadata }),','      JSON.stringify({ answers: input.answers, formId: input.form.id, tracking: input.tracking, websiteSales: input.websiteSalesMetadata, contactResolution: { status: resolutionStatus, identityVerified: false } }),');
once('  return contact?.id ?? null;\n}\n\nfunction getWebsiteSalesMetadata','  return { id: contact?.id ?? null, reusedExisting: false, status: resolutionStatus };\n}\n\nfunction getWebsiteSalesMetadata');
writeFileSync(path,source);
const tests='scripts/studio-enquiry-tests.ts';const existing=readFileSync(tests,'utf8');
if(existing.includes('EV2 public contact preservation'))throw new Error('Regression already installed');
const regression=readFileSync('scripts/ev2-contact-regressions.txt','utf8');
writeFileSync(tests,existing+'\n'+regression);
console.log('Applied public-contact preservation and appended genuine isolated-PostgreSQL regression cases.');
