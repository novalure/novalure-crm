import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import type { AppPermission } from "@/lib/auth/permissions";
import { canViewAllWorkspaceContacts } from "@/lib/contact-access";
import { evaluateEditorPreflight } from "@/lib/db/editor-preflight-repositories";
import type { EditorPreflightType } from "@/lib/crm-types";
import { hasProductCapability, type ProductCapability } from "@/lib/product-model";

const editorTypes: EditorPreflightType[] = ["newsletter", "bot", "funnel", "calendar"];
const editorPolicies: Record<EditorPreflightType, {
  capability: ProductCapability;
  permission: AppPermission;
}> = {
  bot: { capability: "bots:publish", permission: "crm:write" },
  calendar: { capability: "calendar:manage", permission: "crm:write" },
  funnel: { capability: "funnels:publish", permission: "funnels:write" },
  newsletter: { capability: "newsletter:send", permission: "newsletter:send" },
};

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const editorType = typeof input.editorType === "string" && editorTypes.includes(input.editorType as EditorPreflightType)
    ? input.editorType as EditorPreflightType
    : null;

  if (!editorType) {
    return NextResponse.json({ error: "Invalid editor type" }, { status: 400 });
  }

  const policy = editorPolicies[editorType];
  if (
    !auth.session.permissions.includes(policy.permission) ||
    !hasProductCapability(auth.session.productRole, policy.capability)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Bot preflight inspects approved knowledge-source counts. Unlike the other
  // pure checks, that is workspace/project data, so the generic endpoint is
  // deliberately manager-only. Scoped bot writes use their dedicated route.
  if (editorType === "bot" && !canViewAllWorkspaceContacts(auth.session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // This generic endpoint is a side-effect-free preview. Actual editor writes
  // persist their preflight evidence at the protected mutation boundary.
  const run = await evaluateEditorPreflight({
    editorType,
    entityId: typeof input.entityId === "string" ? input.entityId : null,
    payload: input.payload,
    projectId: typeof input.projectId === "string" ? input.projectId : null,
    session: auth.session,
  });

  return NextResponse.json({ preflight: run });
}
