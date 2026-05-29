import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { getCoreCrmData } from "@/lib/db/crm-loaders";
import { ensureWorkspaceProjectDefaultPipelines } from "@/lib/db/pipeline-default-repositories";

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });

  if (!auth.ok) return auth.response;

  try {
    await ensureWorkspaceProjectDefaultPipelines({ session: auth.session });
  } catch {
    // Core data should still load and surface module status if pipeline setup cannot be repaired.
  }

  const data = await getCoreCrmData(auth.session.workspaceId, { session: auth.session });

  return NextResponse.json({
    activeWorkspaceId: auth.session.workspaceId,
    activeWorkspaceName: auth.session.workspaceName,
    source: data.source,
    error: data.error ?? null,
    missingTables: data.missingTables ?? [],
    moduleErrors: data.moduleErrors ?? {},
    moduleSources: data.moduleSources,
    counts: {
      contacts: data.contacts.length,
      leads: data.leads.length,
      deals: data.deals.length,
      tasks: data.tasks.length,
      units: data.propertyUnits.length,
    },
    data,
  });
}
