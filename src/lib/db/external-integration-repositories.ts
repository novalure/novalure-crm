import "server-only";

import type { AppSession } from "@/lib/auth/session";
import {
  createPublicSiteKey,
  externalIntegrationCapabilities,
  normalizeExternalOrigin,
  type ExternalIntegrationCapability,
  type ExternalIntegrationMode,
} from "@/lib/db/external-integration-gateway";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import { isUuid } from "@/lib/db/runtime-repositories";

const integrationTypes = new Set([
  "novalure_studio",
  "customer_website",
  "developer_project",
  "estate_agent",
  "landing_page",
  "website_chat",
  "public_form",
]);
const capabilitySet = new Set<string>(externalIntegrationCapabilities);

export type WebsiteIntegrationInput = Readonly<{
  allowedOrigins: string[];
  capabilities: ExternalIntegrationCapability[];
  configuration?: Record<string, unknown>;
  formId?: string | null;
  integrationType: string;
  mode: ExternalIntegrationMode;
  projectId?: string | null;
  widget?: Record<string, unknown>;
}>;

function scope(session: AppSession) {
  if (!isUuid(session.workspaceId) || !isUuid(session.userId)) throw new Error("Invalid tenant session");
  return { actorId: session.userId, workspaceId: session.workspaceId };
}

function normalizeCapabilities(values: string[]) {
  const capabilities = Array.from(new Set(values));
  if (!capabilities.length || capabilities.some((value) => !capabilitySet.has(value))) {
    throw new Error("Invalid integration capabilities");
  }
  return capabilities as ExternalIntegrationCapability[];
}

function normalizeOptionalCapabilities(values: string[]) {
  const capabilities = Array.from(new Set(values));
  if (capabilities.some((value) => !capabilitySet.has(value))) {
    throw new Error("Invalid widget capabilities");
  }
  return capabilities as ExternalIntegrationCapability[];
}

function safeObject(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const encoded = JSON.stringify(value);
  if (encoded.length > 8_192) throw new Error(`${label} is too large`);
  return value as Record<string, unknown>;
}

function text(value: unknown, fallback: string, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function boolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeWidget(value: Record<string, unknown> | undefined, capabilities: string[]) {
  const widget = safeObject(value, "Widget configuration");
  const color = text(widget.primaryColor, "#111827", 7);
  if (!/^#[0-9A-Fa-f]{6}$/u.test(color)) throw new Error("Invalid widget color");
  const position = text(widget.widgetPosition, "bottom_right", 20);
  if (position !== "bottom_left" && position !== "bottom_right") throw new Error("Invalid widget position");
  const language = text(widget.language, "en", 5);
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(language)) throw new Error("Invalid widget language");
  const enabled = Array.isArray(widget.enabledCapabilities)
    ? normalizeOptionalCapabilities(widget.enabledCapabilities.filter((item): item is string => typeof item === "string"))
    : capabilities;
  if (enabled.some((capability) => !capabilities.includes(capability))) {
    throw new Error("Widget capability exceeds integration capability");
  }
  return {
    assistantAvatarReference: typeof widget.assistantAvatarReference === "string"
      ? widget.assistantAvatarReference.trim().slice(0, 500) || null
      : null,
    assistantName: text(widget.assistantName, "Evelyn", 120),
    brandName: text(widget.brandName, "Novalure", 120),
    calendarEnabled: boolean(widget.calendarEnabled),
    chatEnabled: boolean(widget.chatEnabled, capabilities.includes("chat.start")),
    enabledCapabilities: enabled,
    language,
    leadCaptureEnabled: boolean(widget.leadCaptureEnabled, capabilities.includes("form.submit")),
    primaryColor: color,
    propertySearchEnabled: boolean(widget.propertySearchEnabled),
    welcomeMessage: text(widget.welcomeMessage, "How can I help?", 500),
    widgetPosition: position,
  };
}

export async function listWebsiteIntegrations(session: AppSession) {
  return withTenantTransaction(scope(session), (transaction) => transaction.query<{
    allowedOrigins: string[];
    capabilities: string[];
    formId: string | null;
    id: string;
    integrationType: string;
    mode: ExternalIntegrationMode;
    projectId: string | null;
    publicSiteKey: string;
    status: string;
    updatedAt: string;
    widget: Record<string, unknown>;
  }>(
    `select i.id,i.public_site_key as "publicSiteKey",i.project_id as "projectId",
       i.form_id as "formId",i.integration_type as "integrationType",i.status,i.mode,
       i.allowed_origins as "allowedOrigins",i.capabilities,i.updated_at as "updatedAt",
       jsonb_build_object(
         'brandName',w.brand_name,'assistantName',w.assistant_name,
         'assistantAvatarReference',w.assistant_avatar_reference,'primaryColor',w.primary_color,
         'widgetPosition',w.widget_position,'language',w.language,
         'welcomeMessage',w.welcome_message,'enabledCapabilities',w.enabled_capabilities,
         'leadCaptureEnabled',w.lead_capture_enabled,'calendarEnabled',w.calendar_enabled,
         'propertySearchEnabled',w.property_search_enabled,'chatEnabled',w.chat_enabled
       ) as widget
     from public.external_integrations i
     left join public.external_integration_widget_configs w on w.integration_id=i.id
     where i.workspace_id=$1::uuid order by i.updated_at desc,i.id`,
    [session.workspaceId],
  ));
}

export async function createWebsiteIntegration(session: AppSession, input: WebsiteIntegrationInput) {
  if (!integrationTypes.has(input.integrationType)) throw new Error("Invalid integration type");
  if (input.mode !== "training" && input.mode !== "real_customer") throw new Error("Invalid integration mode");
  const capabilities = normalizeCapabilities(input.capabilities);
  const allowedOrigins = Array.from(new Set(input.allowedOrigins.map(normalizeExternalOrigin)));
  if (!allowedOrigins.length || allowedOrigins.length > 20) throw new Error("At least one allowed origin is required");
  const projectId = input.projectId || null;
  const formId = input.formId || null;
  if (projectId && !isUuid(projectId)) throw new Error("Invalid project");
  if (formId && !isUuid(formId)) throw new Error("Invalid form");
  const widget = normalizeWidget(input.widget, capabilities);
  const configuration = safeObject(input.configuration, "Integration configuration");
  const publicSiteKey = createPublicSiteKey();
  return withTenantTransaction(scope(session), async (transaction) => {
    if (projectId) {
      const project = await transaction.queryOne<{ id: string }>(
        "select id from public.projects where workspace_id=$1::uuid and id=$2::uuid",
        [session.workspaceId, projectId],
      );
      if (!project) throw new Error("Project not found");
    }
    if (formId) {
      const form = await transaction.queryOne<{ id: string }>(
        `select id from public.forms where workspace_id=$1::uuid and id=$2::uuid
         and project_id is not distinct from $3::uuid and status in ('aktiv','eingebaut')`,
        [session.workspaceId, formId, projectId],
      );
      if (!form) throw new Error("Published form not found in integration scope");
    }
    const integration = await transaction.queryOne<{ id: string; publicSiteKey: string }>(
      `insert into public.external_integrations(
         public_site_key,workspace_id,project_id,form_id,integration_type,status,mode,
         allowed_origins,capabilities,configuration,created_by
       ) values($1,$2::uuid,$3::uuid,$4::uuid,$5,'test',$6,$7::text[],$8::text[],$9::jsonb,$10::uuid)
       returning id,public_site_key as "publicSiteKey"`,
      [
        publicSiteKey,
        session.workspaceId,
        projectId,
        formId,
        input.integrationType,
        input.mode,
        allowedOrigins,
        capabilities,
        JSON.stringify(configuration),
        session.userId,
      ],
    );
    if (!integration) throw new Error("Integration could not be created");
    await transaction.execute(
      `insert into public.external_integration_widget_configs(
         integration_id,workspace_id,brand_name,assistant_name,assistant_avatar_reference,
         primary_color,widget_position,language,welcome_message,enabled_capabilities,
         lead_capture_enabled,calendar_enabled,property_search_enabled,chat_enabled
       ) values($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,$14)`,
      [
        integration.id,
        session.workspaceId,
        widget.brandName,
        widget.assistantName,
        widget.assistantAvatarReference,
        widget.primaryColor,
        widget.widgetPosition,
        widget.language,
        widget.welcomeMessage,
        widget.enabledCapabilities,
        widget.leadCaptureEnabled,
        widget.calendarEnabled,
        widget.propertySearchEnabled,
        widget.chatEnabled,
      ],
    );
    return integration;
  });
}

export async function updateWebsiteIntegrationStatus(
  session: AppSession,
  input: { integrationId: string; status: "test" | "active" | "disabled" | "revoked" },
) {
  if (!isUuid(input.integrationId)) throw new Error("Invalid integration");
  if (!["test", "active", "disabled", "revoked"].includes(input.status)) throw new Error("Invalid status");
  return withTenantTransaction(scope(session), (transaction) => transaction.queryOne<{ id: string; status: string }>(
    `update public.external_integrations set status=$3,
       revoked_at=case when $3='revoked' then now() else null end,updated_at=now()
     where workspace_id=$1::uuid and id=$2::uuid returning id,status`,
    [session.workspaceId, input.integrationId, input.status],
  ));
}
