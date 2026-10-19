export const STUDIO_WORKSPACE_ID = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
export const STUDIO_PROJECT_ID = "f7d83c6b-d08d-4d73-b822-1f1c0b4733d2";

// A navigation preference never adds a project to the server-authorized list.
export function getAuthorizedStudioProjectId(
  workspaceId: string,
  projects: ReadonlyArray<{ id: string; workspaceId: string }>,
): string | null {
  return workspaceId === STUDIO_WORKSPACE_ID && projects.some(
    (project) => project.id === STUDIO_PROJECT_ID && project.workspaceId === workspaceId,
  ) ? STUDIO_PROJECT_ID : null;
}

export function getStudioNavigationPreferenceKey(baseKey: string, userId: string, workspaceId: string) {
  return workspaceId === STUDIO_WORKSPACE_ID
    ? `${baseKey}:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`
    : baseKey;
}

export function selectStudioWebsiteEnquiries<T extends { hasStudioEnquiry?: boolean; syntheticTest?: boolean }>(
  leads: readonly T[],
  showTestEnquiries = false,
): T[] {
  return leads.filter((lead) => lead.hasStudioEnquiry === true && (lead.syntheticTest === true) === showTestEnquiries);
}
