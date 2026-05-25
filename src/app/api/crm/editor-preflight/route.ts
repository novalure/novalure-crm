import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { runEditorPreflight } from "@/lib/db/editor-preflight-repositories";
import type { EditorPreflightType } from "@/lib/crm-types";

const editorTypes: EditorPreflightType[] = ["newsletter", "bot", "funnel", "calendar"];

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

  const run = await runEditorPreflight({
    editorType,
    entityId: typeof input.entityId === "string" ? input.entityId : null,
    payload: input.payload,
    projectId: typeof input.projectId === "string" ? input.projectId : null,
    session: auth.session,
  });

  return NextResponse.json({ preflight: run });
}
