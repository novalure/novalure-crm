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
  } catch (error) {
    if (process.env.CI === "true" && /^GOLIVETEST_[A-Za-z0-9_-]{6,80}$/u.test(process.env.NOVALURE_QA_RUN_PREFIX ?? "")) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      const name = error instanceof Error ? error.name : "unknown";
      const safe = (value: string) => /^[A-Za-z0-9_]{1,40}$/u.test(value) ? value : "redacted";
      console.error(`QA_CORE_FAILURE code=${safe(code)} name=${safe(name)}`);
    }
    return crmCommandErrorResponse(error);
  }
}
