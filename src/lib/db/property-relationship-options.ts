import type { AppSession } from "@/lib/auth/session";
import { hasProductCapability } from "@/lib/product-model";
import { getContactVisibilityScope } from "@/lib/contact-access";
import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { loadContacts } from "@/lib/db/crm-loaders";
import type { PropertyRelationshipOptions } from "@/lib/property-relationship-editing";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Failure = { persisted: false; status: number; reason: string };
type Success = { persisted: true; source: "database"; data: {
  propertyId: string; workspaceId: string; projectId: string | null; options: PropertyRelationshipOptions;
} };

/** Selection data, never mutation authority. The UPDATE still validates scope and CAS atomically. */
export async function loadPropertyRelationshipOptions(input: { session: AppSession; propertyId: string }): Promise<Success | Failure> {
  const { session, propertyId } = input;
  if (![propertyId, session.workspaceId, session.userId].every(id => uuid.test(id))) return { persisted: false, status: 400, reason: "Invalid relationship options scope" };
  const canOperate = session.permissions.includes("crm:write") && (session.role === "owner" || session.role === "admin" ||
    hasProductCapability(session.productRole, "workspace:operate") || hasProductCapability(session.productRole, "pipeline:write") ||
    hasProductCapability(session.productRole, "settings:manage") || hasProductCapability(session.productRole, "workspace:admin"));
  if (!canOperate) return { persisted: false, status: 403, reason: "Property operating rights required" };
  if (!hasDatabaseUrl()) return { persisted: false, status: 503, reason: "Database-backed relationship options unavailable" };
  try {
    const property = await queryOne<{ id: string; projectId: string | null }>(`select p.id,p.project_id as "projectId"
      from seller_listings p where p.id=$1::uuid and p.workspace_id=$2::uuid
      and (p.project_id is null or exists(select 1 from projects project where project.id=p.project_id and project.workspace_id=p.workspace_id))`, [propertyId, session.workspaceId]);
    if (!property) return { persisted: false, status: 404, reason: "Property not found in this workspace" };
    const scope = [session.workspaceId, property.projectId];
    // Match Core's contact visibility (including own-only and archived exclusion).
    // Never return its delivery addresses, consent fields or owner metadata.
    const [contacts, leads, mandates, team] = await Promise.all([
      loadContacts(session.workspaceId, getContactVisibilityScope(session)),
      queryRows<{ id: string; contactId: string | null; label: string }>(`select l.id,l.contact_id as "contactId",l.intent as label
        from leads l where l.workspace_id=$1::uuid and (l.project_id is null or l.project_id=$2::uuid)
        and (lower(l.type) like '%verk%' or lower(l.type) like '%seller%'
          or (jsonb_typeof(l.seller_profile)='object' and l.seller_profile<>'{}'::jsonb))
        order by l.received_at desc,l.id limit 500`, scope),
      queryRows<{ id: string; label: string; sellerLeadId: string | null }>(`select m.id,m.title as label,m.seller_lead_id as "sellerLeadId"
        from broker_mandates m where m.workspace_id=$1::uuid and (m.project_id is null or m.project_id=$2::uuid)
        order by m.updated_at desc,m.id limit 500`, scope),
      queryRows<{ id: string; label: string }>(`select u.id,u.name as label from workspace_users u
        where u.workspace_id=$1::uuid and u.status='active' order by u.name,u.id limit 500`, [session.workspaceId]),
    ]);
    const contactOptions = contacts.map(contact => ({ id: contact.id, label: contact.name }));
    const options: PropertyRelationshipOptions = {
      sellerLeadId: leads.map(lead => ({ id: lead.id, label: contactOptions.find(contact => contact.id === lead.contactId)?.label || lead.label || "Lead" })),
      mandateId: mandates.map(mandate => ({ id: mandate.id, label: mandate.label || "Mandate", sellerLeadId: mandate.sellerLeadId })),
      ownerContactId: contactOptions,
      ownerUserId: team.map(user => ({ id: user.id, label: user.label })),
      contactUserId: team.map(user => ({ id: user.id, label: user.label })),
    };
    return { persisted: true, source: "database", data: { propertyId, workspaceId: session.workspaceId, projectId: property.projectId, options } };
  } catch {
    // Do not turn unavailable DB modules into empty/mock selectable options.
    return { persisted: false, status: 503, reason: "Relationship options could not be loaded; reload and retry" };
  }
}
