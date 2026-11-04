import { writeFile } from "node:fs/promises";
import { createFunnel, createDefaultSteps } from "../../src/components/funnel-command-center";
import { buildFunnelBlueprint } from "../../src/lib/funnel-builder-adapter";
import { getFunnelCommandCenterCopy } from "../../src/lib/i18n";
import type { Project, WorkspaceUser } from "../../src/lib/crm-types";

async function main() {
  const [output, workspaceId, userId, projectId] = process.argv.slice(2);
  if (!output || !workspaceId || !userId || !projectId) throw new Error("Synthetic fixture context required");
  const project: Project = { id: projectId, workspaceId, name: "SYNTHETIC First funnel", type: "Service", status: "Aktiv", leads: 0, revenue: "—", defaultPipelineId: "" };
  const user: WorkspaceUser = { id: userId, workspaceId, name: "SYNTHETIC Current publisher", email: "actor@example.invalid", role: "owner", productRole: "customer_owner", status: "active" };
  const text = getFunnelCommandCenterCopy("de"), funnel = createFunnel({ text, project, user, workspaceId });
  await writeFile(output, JSON.stringify(buildFunnelBlueprint({ funnel, project, owner: user, steps: createDefaultSteps(funnel, text) })));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
