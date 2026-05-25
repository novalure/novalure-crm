import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { upsertBotSetup } from "@/lib/db/crm-write-repositories";
import { runEditorPreflight } from "@/lib/db/editor-preflight-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "crm:write", "bots:publish");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const bot = typeof input.bot === "object" && input.bot ? input.bot as Record<string, unknown> : input;
  const preflight = await runEditorPreflight({
    editorType: "bot",
    entityId: typeof bot.id === "string" ? bot.id : null,
    payload: bot,
    projectId: typeof bot.projectId === "string" ? bot.projectId : null,
    session: auth.session,
  });
  if (preflight.status === "blocked" && bot.status === "active") {
    return NextResponse.json({ blockers: preflight.blockers, error: "Bot preflight blocked publish", preflight }, { status: 409 });
  }

  const result = await upsertBotSetup({ bot, session: auth.session });

  if (!result.persisted) {
    if (result.reason.startsWith("bot_publish_blocked:")) {
      const blockers = result.reason
        .replace("bot_publish_blocked:", "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      return NextResponse.json({ blockers, error: result.reason, preflight }, { status: 409 });
    }

    return NextResponse.json({ error: result.reason }, { status: 503 });
  }

  return NextResponse.json({ bot: result.data, persisted: true, preflight });
}
