import "server-only";
import type { AppSession } from "@/lib/auth/session";
import type { TenantTransaction, TenantTransactionOptions } from "@/lib/crm-command";
import { hasProductCapability } from "@/lib/product-model";
import { withBookingTransaction } from "./repository";
import { BookingError } from "./types";

type PropertyAddressRow = { id: string; title: string; address: string; postalCode: string | null; city: string | null; region: string | null };
export type BookingPropertyLocation = { id: string; title: string; address: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const consistentProject = "(p.project_id is null or exists(select 1 from projects project where project.id=p.project_id and project.workspace_id=p.workspace_id))";
const propertyColumns = 'p.id,p.title,p.address,p.postal_code as "postalCode",p.city,p.region';

async function assertPropertyLocationAccess(tx: TenantTransaction, session: AppSession) {
  const canOperate = session.permissions.includes("crm:write") && (session.role === "owner" || session.role === "admin" ||
    hasProductCapability(session.productRole, "workspace:operate") || hasProductCapability(session.productRole, "pipeline:write") ||
    hasProductCapability(session.productRole, "settings:manage") || hasProductCapability(session.productRole, "workspace:admin"));
  if (!canOperate) throw new BookingError("PROPERTY_LOCATION_FORBIDDEN", 403);
  const propertyModule = await tx.queryOne<{ enabled: boolean }>("select enabled from workspace_module_settings where workspace_id=$1::uuid and module_key='properties'", [session.workspaceId]);
  if (!propertyModule?.enabled) throw new BookingError("PROPERTY_MODULE_REQUIRED", 403);
}

/** Only authorized stored location fields; never listing contacts, descriptions or customer names. */
export function bookingPropertyAddress(row: Pick<PropertyAddressRow, "address" | "postalCode" | "city" | "region">): string {
  const clean = (value: string | null) => (value ?? "").trim().replace(/\s+/g, " ");
  let address = clean(row.address);
  if (!address || /[\u0000-\u001f\u007f]/.test(row.address)) throw new BookingError("PROPERTY_ADDRESS_REQUIRED", 409);
  const postalCity = [clean(row.postalCode), clean(row.city)].filter(Boolean).join(" ");
  for (const component of [postalCity, clean(row.region)]) {
    if (component && !address.toLocaleLowerCase("de").includes(component.toLocaleLowerCase("de"))) address += `, ${component}`;
  }
  if (address.length > 500) throw new BookingError("PROPERTY_ADDRESS_REQUIRED", 409);
  return address;
}

/** Caller must use the fresh, authorized session in its existing tenant transaction. */
export async function resolveBookingPropertyLocation(tx: TenantTransaction, session: AppSession, propertyId: string): Promise<{ propertyId: string; address: string }> {
  if (typeof propertyId !== "string" || !uuid.test(propertyId)) throw new BookingError("INVALID_PROPERTY_REFERENCE");
  await assertPropertyLocationAccess(tx, session);
  const row = await tx.queryOne<PropertyAddressRow>(`select ${propertyColumns} from seller_listings p
    where p.id=$1::uuid and p.workspace_id=$2::uuid and ${consistentProject}`, [propertyId, session.workspaceId]);
  if (!row) throw new BookingError("PROPERTY_LOCATION_NOT_FOUND", 404);
  return { propertyId: row.id, address: bookingPropertyAddress(row) };
}

export async function listBookingPropertyLocations(session: AppSession, search = "", options: TenantTransactionOptions = {}): Promise<BookingPropertyLocation[]> {
  if (typeof search !== "string" || search.length > 120 || /[\u0000-\u001f\u007f]/.test(search)) throw new BookingError("INVALID_PROPERTY_SEARCH");
  const query = search.trim();
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  return withBookingTransaction(session, async (tx, fresh) => {
    await assertPropertyLocationAccess(tx, fresh);
    const rows = await tx.query<PropertyAddressRow>(`select ${propertyColumns} from seller_listings p
      where p.workspace_id=$1::uuid and ${consistentProject}
      and ($2='' or p.title ilike $3 escape '\\' or p.address ilike $3 escape '\\' or coalesce(p.city,'') ilike $3 escape '\\' or coalesce(p.postal_code,'') ilike $3 escape '\\')
      order by p.updated_at desc,p.id limit 30`, [fresh.workspaceId, query, pattern]);
    return rows.flatMap(row => {
      try { return [{ id: row.id, title: row.title, address: bookingPropertyAddress(row) }]; }
      catch (error) { if (error instanceof BookingError && error.code === "PROPERTY_ADDRESS_REQUIRED") return []; throw error; }
    });
  }, options);
}
