import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { CrmWorkspace } from "@/components/crm-workspace";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { getCoreCrmData } from "@/lib/db/crm-loaders";
import { ensureWorkspaceProjectDefaultPipelines } from "@/lib/db/pipeline-default-repositories";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSessionFromHeaders(await headers());
  if (!session) redirect("/login");

  try {
    await ensureWorkspaceProjectDefaultPipelines({ session });
  } catch {
    // The workspace can render with module-level fallbacks if pipeline bootstrap is temporarily unavailable.
  }
  const coreData = await getCoreCrmData(session.workspaceId);

  return (
    <CrmWorkspace
      coreData={coreData}
      sessionProductRole={session.productRole}
      sessionRole={session.role}
      sessionWorkspace={{
        activeCalendarProvider: session.workspaceActiveCalendarProvider ?? undefined,
        customerType: session.workspaceCustomerType ?? undefined,
        id: session.workspaceId,
        name: session.workspaceName,
        operatingModel: session.workspaceOperatingModel ?? undefined,
        setupState: session.workspaceSetupState ?? undefined,
        teamStructure: session.workspaceTeamStructure ?? undefined,
      }}
    />
  );
}
