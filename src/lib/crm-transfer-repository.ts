import type { AppSession } from "@/lib/auth/session";
import { canWriteContacts, getContactVisibilityScope } from "@/lib/contact-access";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransactionOptions } from "@/lib/crm-command";
import { hasProductCapability } from "@/lib/product-model";
import { upsertContactRecord, upsertLeadRecord } from "@/lib/db/crm-write-repositories";
import type { Contact } from "@/lib/crm-types";
import { buildCrmCsv, buildCrmVcards, previewCrmTransfer, type CrmTransferMapping } from "@/lib/crm-transfer";

type ContactExportRow = { id: string; projectId: string | null; ownerUserId: string | null; version: number; name: string; email: string | null; phone: string | null; role: string; source: string; intent: string };
type LeadExportRow = ContactExportRow & { contactId: string | null; type: string; status: string; score: number; budget: string | null; nextAction: string; receivedAt: string; slaDueAt: string; lastContactAt: string | null; nextContactAt: string | null };
type TransferImportInput = { csv: string; mapping?: CrmTransferMapping; projectId: string; createLeads: boolean };
const exportLimit = 10000;

export async function exportCrmTransfer(session: AppSession, input: { kind: "contacts" | "leads"; format: "csv" | "vcf"; projectId?: string; ids?: string[] }, options: TenantTransactionOptions = {}) {
  if (input.kind === "leads" && input.format === "vcf") throw new CrmCommandError("INVALID_FORMAT", "vCard ist für Kontakte verfügbar.");
  const ids = input.ids?.map(id => assertCrmUuid(id));
  if (ids && (ids.length === 0 || ids.length > 1000)) throw new CrmCommandError("INVALID_SELECTION", "Bitte höchstens 1.000 Kontakte auswählen.");
  return withCrmRead(session, async (tx, fresh) => {
    if (input.projectId) await assertProjectGrant(tx, fresh, input.projectId);
    const visibility = getContactVisibilityScope(fresh);
    if (visibility.kind === "none") throw new CrmCommandError("FORBIDDEN", "Kontaktzugriff fehlt.", 403);
    const params: unknown[] = [fresh.workspaceId, input.projectId ?? null, visibility.kind === "own" ? visibility.userId : null, ids ?? null];
    const contacts = input.kind === "contacts" ? await tx.query<ContactExportRow>(`
      select c.id,c.project_id as "projectId",c.owner_user_id as "ownerUserId",c.version,c.name,c.email,c.phone,c.role,c.source,c.intent
      from contacts c where c.workspace_id=$1::uuid and c.archived_at is null
        and ($2::uuid is null or c.project_id=$2::uuid) and ($3::uuid is null or c.owner_user_id=$3::uuid)
        and ($4::uuid[] is null or c.id=any($4::uuid[])) order by c.id limit ${exportLimit + 1}`, params) : [];
    const leads = input.kind === "leads" ? await tx.query<LeadExportRow>(`
      select l.id,l.project_id as "projectId",l.assigned_to_user_id as "ownerUserId",l.version,l.contact_id as "contactId",
        coalesce(c.name,'') as name,c.email,c.phone,l.type,l.type as role,l.source,l.status,l.score,l.budget,l.intent,
        l.next_action as "nextAction",l.received_at::text as "receivedAt",l.sla_due_at::text as "slaDueAt",
        l.last_contact_at::text as "lastContactAt",l.next_contact_at::text as "nextContactAt"
      from leads l left join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id and c.archived_at is null
        and ($3::uuid is null or c.owner_user_id=$3::uuid)
      where l.workspace_id=$1::uuid and ($2::uuid is null or l.project_id=$2::uuid)
        and ($3::uuid is null or l.assigned_to_user_id=$3::uuid) and ($4::uuid[] is null or l.id=any($4::uuid[]))
      order by l.id limit ${exportLimit + 1}`, params) : [];
    const rows = input.kind === "contacts" ? contacts : leads;
    if (rows.length > exportLimit) throw new CrmCommandError("EXPORT_LIMIT", "Bitte den Export auf ein Projekt oder eine kleinere Auswahl eingrenzen (maximal 10.000 Datensätze).");
    if (ids && ids.some(id => !rows.some(row => row.id === id))) throw new CrmCommandError("SELECTION_UNAVAILABLE", "Die Auswahl enthält nicht verfügbare Datensätze.", 403);
    const date = new Date().toISOString().slice(0, 10);
    if (input.format === "vcf") return { content: buildCrmVcards(contacts), contentType: "text/vcard; charset=utf-8", filename: `novalure-contacts-${date}.vcf`, count: contacts.length };
    const headers = input.kind === "contacts"
      ? ["id", "projectId", "ownerUserId", "version", "name", "email", "phone", "role", "source", "intent"]
      : ["id", "contactId", "projectId", "ownerUserId", "version", "name", "email", "phone", "type", "source", "status", "score", "budget", "intent", "nextAction", "receivedAt", "slaDueAt", "lastContactAt", "nextContactAt"];
    return { content: buildCrmCsv(headers, rows.map(row => headers.map(header => row[header as keyof typeof row]))), contentType: "text/csv; charset=utf-8", filename: `novalure-${input.kind}-${date}.csv`, count: rows.length };
  }, options);
}

async function importPreviewInTransaction(tx: Parameters<Parameters<typeof withCrmRead>[1]>[0], session: AppSession, input: TransferImportInput) {
  if (!canWriteContacts(session)) throw new CrmCommandError("FORBIDDEN", "Kontaktanlage ist nicht freigegeben.", 403);
  await assertProjectGrant(tx, session, assertCrmUuid(input.projectId, "projectId"), true);
  if (input.createLeads && !hasProductCapability(session.productRole, "pipeline:write")) throw new CrmCommandError("FORBIDDEN", "Leadanlage ist nicht freigegeben.", 403);
  const existing = await tx.query<{ email: string | null; phone: string | null }>("select email,phone from contacts where workspace_id=$1::uuid and archived_at is null", [session.workspaceId]);
  return previewCrmTransfer(input.csv, input.mapping, existing);
}

export async function previewCrmImport(session: AppSession, input: TransferImportInput, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, (tx, fresh) => importPreviewInTransaction(tx, fresh, input), options);
}

export async function commitCrmImport(session: AppSession, input: TransferImportInput & { idempotencyKey: string; correlationId: string }, options: TenantTransactionOptions = {}) {
  return executeCrmCommand(session, {
    operation: "crm.transfer.import", projectId: assertCrmUuid(input.projectId, "projectId"), capability: "workspace:operate",
    idempotencyKey: input.idempotencyKey, correlationId: input.correlationId,
    payload: { csv: input.csv, mapping: input.mapping ?? null, projectId: input.projectId, createLeads: input.createLeads },
  }, async (tx, context) => {
    // Serializes competing imports in this tenant; database constraints still protect concurrent manual writes.
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ["crm-transfer:" + context.workspaceId]);
    const preview = await importPreviewInTransaction(tx, context.session, input);
    if (preview.invalid) throw new CrmCommandError("IMPORT_INVALID", "Bitte zuerst alle ungültigen Zeilen in der Datei korrigieren.");
    const created: { line: number; contactId: string; leadId?: string }[] = [];
    for (const row of preview.rows.filter(candidate => candidate.status === "ready")) {
      const contact = await upsertContactRecord({ session: context.session, contact: {
        projectId: input.projectId, ownerUserId: context.actorId, name: row.contact.name, email: row.contact.email,
        phone: row.contact.phone, role: row.contact.role, source: row.contact.source as Contact["source"],
        intent: row.contact.intent || "CSV-Import", consent: "Nur CRM",
      } }, options);
      if (!contact.persisted) throw new CrmCommandError("IMPORT_REJECTED", contact.reason, /permission|not allowed|workspace/.test(contact.reason) ? 403 : 409);
      // Preserve the source identity as provenance, never as an authorization or a new primary key.
      await tx.execute("update contacts set metadata=metadata || $3::jsonb where workspace_id=$1::uuid and id=$2::uuid", [context.workspaceId, contact.data.id, JSON.stringify({ crmTransfer: { sourceId: row.contact.externalId || null, commandId: context.commandId, line: row.line } })]);
      let leadId: string | undefined;
      if (input.createLeads) {
        const lead = await upsertLeadRecord({ session: context.session, idempotencyKey: `${context.commandId}:${row.line}`, lead: {
          projectId: input.projectId, contactId: contact.data.id, assignedToUserId: context.actorId, type: row.contact.role,
          source: row.contact.source as Contact["source"], status: "Neu", intent: row.contact.intent || "CSV-Import", nextAction: "Anfrage prüfen",
        } }, options);
        if (!lead.persisted) throw new CrmCommandError("IMPORT_REJECTED", lead.reason, 409);
        leadId = lead.data.id;
      }
      created.push({ line: row.line, contactId: contact.data.id, ...(leadId ? { leadId } : {}) });
    }
    return { persisted: true, created, skippedDuplicates: preview.duplicates, consentImported: false };
  }, options);
}
