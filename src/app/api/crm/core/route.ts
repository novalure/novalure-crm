import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { getCoreCrmData } from "@/lib/db/crm-loaders";
import { crmCommandErrorResponse } from "@/lib/crm-command";

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });

  if (!auth.ok) return auth.response;

  try {
  const data = await getCoreCrmData(auth.session.workspaceId, { session: auth.session });

  return NextResponse.json({
    activeWorkspaceId: auth.session.workspaceId,
    activeWorkspaceName: auth.session.workspaceName,
    source: data.source,
    collectionCompleteness: data.collectionCompleteness ?? "LIMITED",
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
  } catch (error) { return crmCommandErrorResponse(error); }
}
