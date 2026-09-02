import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  assertUuid,
  parseAddTemplateVersionInput,
  parseArchiveInput,
  parseIdempotencyKey,
  parseTemplateUpdateInput,
} from "@/lib/content-library";
import {
  addCommunicationTemplateVersion,
  getCommunicationTemplate,
  setCommunicationTemplateArchived,
  updateCommunicationTemplate,
} from "@/lib/db/content-library-repositories";
import { contentRouteError, readObjectBody } from "../../documents/_shared";

type RouteContext = { params: Promise<{ templateId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const { templateId } = await context.params;
    const template = await getCommunicationTemplate({
      session: auth.session,
      templateId: assertUuid(templateId, "templateId"),
    });
    if (!template) return NextResponse.json({ error: "Template was not found" }, { status: 404 });
    return NextResponse.json({ template });
  } catch (error) {
    return contentRouteError(error);
  }
}
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;
  try {
    const { templateId: rawId } = await context.params;
    const templateId = assertUuid(rawId, "templateId");
    const body = await readObjectBody(request);
    const action = typeof body.action === "string" ? body.action : "update";
    const payload = body.template ?? body.version ?? body;
    const idempotencyKey = parseIdempotencyKey(request);
    if (action === "add_version") {
      const result = await addCommunicationTemplateVersion({ session: auth.session, templateId,
        idempotencyKey, version: parseAddTemplateVersionInput(payload) });
      return NextResponse.json({ ...result, persisted: true });
    }
    if (action === "archive" || action === "restore") {
      const archive = parseArchiveInput(payload);
      const result = await setCommunicationTemplateArchived({
        session: auth.session,
        templateId,
        idempotencyKey,
        expectedUpdatedAt: archive.expectedUpdatedAt,
        archived: action === "archive",
        reason: archive.reason,
      });
      return NextResponse.json({ ...result, persisted: true });
    }
    if (action !== "update") {
      return NextResponse.json({ error: "Unsupported template action" }, { status: 400 });
    }
    const result = await updateCommunicationTemplate({ session: auth.session, templateId,
      idempotencyKey, update: parseTemplateUpdateInput(payload) });
    return NextResponse.json({ ...result, persisted: true });
  } catch (error) {
    return contentRouteError(error);
  }
}
