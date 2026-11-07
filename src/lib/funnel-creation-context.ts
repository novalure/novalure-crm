import type { Project, WorkspaceUser } from "@/lib/crm-types";
import { getRolePermissions } from "@/lib/auth/permissions";
import { hasProductCapability } from "@/lib/product-model";

export function resolveFunnelCreationContext(input: { activeProjectId?: string | null; chosenProjectId?: string | null; currentUserId?: string; projects: Project[]; users: WorkspaceUser[] }) {
  const user = input.users.find(row => row.id === input.currentUserId && row.status === "active");
  if (!user) return { ok: false as const, reason: "actor_missing" as const };
  if (!user.productRole || !getRolePermissions(user.role).includes("funnels:write") || !hasProductCapability(user.productRole, "funnels:publish")) return { ok: false as const, reason: "creation_forbidden" as const };
  const projects = input.projects.filter(row => row.workspaceId === user.workspaceId && row.status !== "Archiviert");
  const projectId = input.activeProjectId ?? input.chosenProjectId ?? (projects.length === 1 ? projects[0].id : null);
  if (!projectId) return { ok: false as const, reason: "project_required" as const };
  const project = projects.find(row => row.id === projectId);
  if (!project) return { ok: false as const, reason: "project_unavailable" as const };
  return { ok: true as const, user, project, workspaceId: user.workspaceId };
}
