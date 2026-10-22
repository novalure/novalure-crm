import "server-only";
import { isIP } from "node:net";
import { canSwitchWorkspace, type AppSession } from "./auth/session";
import { assertCrmFields, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransactionOptions } from "./crm-command";
import { hasProductCapability, isWorkspaceCustomerType, type WorkspaceCustomerType } from "./product-model";

export type CustomerWorkspaceInput = Readonly<{
  name: string;
  projectName: string;
  botName: string;
  websiteUrl: string;
  customerType: Exclude<WorkspaceCustomerType, "novalure_internal">;
  requestId: string;
}>;

export type ProvisionedCustomerWorkspace = Readonly<{
  workspace: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    customerType: CustomerWorkspaceInput["customerType"];
    operatingModel: "managed_by_novalure";
    role: "admin";
    productRole: "workspace_admin";
    teamStructure: "no_sales_team";
    activeCalendarProvider: "none";
    setupState: Record<string, unknown>;
  };
  project: { id: string; name: string; workspaceId: string; type: string; status: "Aktiv"; customerType: CustomerWorkspaceInput["customerType"] };
  bot: { id: string; name: string; workspaceId: string; projectId: string; status: "draft" };
  knowledgeArea: { id: string; name: string; workspaceId: string; projectId: string; kind: "project" };
  limits: { maxAssistants: number; maxSources: number; maxStorageBytes: number; maxQueriesPerMonth: number; maxScansPerMonth: number; maxAreas: number; maxWebsites: number; maxUsers: number };
}>;

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nameValue(value: unknown, label: string) {
  if (typeof value !== "string") throw new CrmCommandError("VALIDATION_ERROR", `${label} fehlt.`);
  const result = value.trim();
  if (!result || result.length > 160 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new CrmCommandError("VALIDATION_ERROR", `${label} muss 1 bis 160 Zeichen enthalten.`);
  }
  return result;
}

/** This saves a public URL as setup metadata; the existing importer performs DNS/SSRF checks before fetching. */
function websiteValue(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) throw new CrmCommandError("VALIDATION_ERROR", "Eine öffentliche HTTPS-Website ist erforderlich.");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new CrmCommandError("VALIDATION_ERROR", "Die Website-Adresse ist ungültig."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || isIP(host) || host.startsWith("[")
    || !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) {
    throw new CrmCommandError("VALIDATION_ERROR", "Bitte eine öffentliche HTTPS-Website ohne Zugangsdaten angeben.");
  }
  url.hash = "";
  return url.href;
}

export function parseCustomerWorkspaceInput(value: unknown): CustomerWorkspaceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CrmCommandError("VALIDATION_ERROR", "Ungültige Kundeneinrichtung.");
  const input = value as Record<string, unknown>;
  assertCrmFields(input, ["name", "projectName", "botName", "websiteUrl", "customerType", "requestId"]);
  if (!isWorkspaceCustomerType(input.customerType) || input.customerType === "novalure_internal") {
    throw new CrmCommandError("VALIDATION_ERROR", "Ein gültiger Kundentyp ist erforderlich.");
  }
  if (typeof input.requestId !== "string" || !uuidV4.test(input.requestId)) {
    throw new CrmCommandError("IDEMPOTENCY_REQUIRED", "Eine eindeutige UUID-v4-Anfragekennung ist erforderlich.");
  }
  return {
    name: nameValue(input.name, "Kundenname"),
    projectName: nameValue(input.projectName, "Projektname"),
    botName: nameValue(input.botName, "Assistentenname"),
    websiteUrl: websiteValue(input.websiteUrl),
    customerType: input.customerType,
    requestId: input.requestId.toLowerCase(),
  };
}

function assertProvisioningSession(session: AppSession) {
  if (!session.authenticated || session.source === "demo" || session.serviceIdentity
    || !uuid.test(session.authSessionId ?? "") || !uuid.test(session.authIdentityId ?? "") || !session.mfaVerifiedAt) {
    throw new CrmCommandError("MFA_REQUIRED", "Für neue Kunden ist eine angemeldete, mit MFA bestätigte Verwaltungssitzung erforderlich.", 403);
  }
  if (!canSwitchWorkspace(session) || !hasProductCapability(session.productRole, "settings:manage")
    || !hasProductCapability(session.productRole, "bots:publish") || !session.permissions.includes("crm:write")
    || !["owner", "admin"].includes(session.role)) {
    throw new CrmCommandError("FORBIDDEN", "Die Berechtigung zur Kundeneinrichtung fehlt.", 403);
  }
}

/** One transaction covers the new tenant, fixed initial grants, audit and retry receipt. */
export async function provisionCustomerWorkspace(
  session: AppSession,
  value: CustomerWorkspaceInput,
  options: TenantTransactionOptions = {},
) {
  assertProvisioningSession(session);
  const input = parseCustomerWorkspaceInput(value);
  const { requestId, ...payload } = input;
  const result = await withCrmRead(session, async (tx, freshSession) => {
    assertProvisioningSession(freshSession);
    // Revalidate database MFA/identity before receipt replay as well as creation.
    const authorization = await tx.queryOne<{ allowed: boolean }>(
      "select public.crm_customer_provisioning_authorized($1::uuid) as allowed", [freshSession.authSessionId],
    );
    if (!authorization?.allowed) throw new CrmCommandError("FORBIDDEN", "Die aktuelle Verwaltungssitzung darf keine Kunden anlegen.", 403);
    return executeCrmCommand<ProvisionedCustomerWorkspace>(freshSession, {
      operation: "customer.workspace.provision",
      capability: "settings:manage",
      idempotencyKey: requestId,
      correlationId: requestId,
      payload,
    }, async (commandTx, context) => {
      assertProvisioningSession(context.session);
      const row = await commandTx.queryOne<{ result: ProvisionedCustomerWorkspace }>(
        "select public.crm_provision_customer_workspace($1::uuid,$2::uuid,$3::jsonb) as result",
        [context.session.authSessionId, requestId, JSON.stringify(payload)],
      );
      if (!row?.result) throw new CrmCommandError("CRM_UNAVAILABLE", "Der Kundenmandant konnte nicht erstellt werden.", 503);
      return row.result;
    }, options);
  }, options);
  return { ...result.data, persisted: true as const, replayed: result.replayed };
}
