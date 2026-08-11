export const CRM_SCOPE_VERSION = 1 as const;
export const CRM_SCOPE_ALL_PROJECTS = "all" as const;
export const CRM_SCOPE_WORKSPACE_PARAM = "workspaceId" as const;
export const CRM_SCOPE_PROJECT_PARAM = "projectId" as const;

const CRM_SCOPE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,127})$/;

export type CrmScopeSource = "url" | "user" | "default";
export type CrmScopeInvalidReason =
  | "duplicate_parameter"
  | "invalid_parameter"
  | "missing_parameter"
  | "project_not_available"
  | "workspace_mismatch";

type BaseCrmScope = {
  projectId: string | null;
  source: CrmScopeSource;
  version: typeof CRM_SCOPE_VERSION;
  workspaceId: string;
};

export type CrmScope =
  | (BaseCrmScope & { status: "valid" })
  | (BaseCrmScope & {
      invalidReason: CrmScopeInvalidReason;
      requestedProjectId?: string | null;
      requestedWorkspaceId?: string;
      status: "invalid";
    });

export type CrmScopeProject = {
  id: string;
  workspaceId: string;
};

export type CrmScopeStorage = Pick<Storage, "getItem" | "setItem">;

type ParsedCrmScopeUrl =
  | { status: "absent" }
  | {
      invalidReason: Extract<CrmScopeInvalidReason, "duplicate_parameter" | "invalid_parameter" | "missing_parameter">;
      requestedProjectId?: string | null;
      requestedWorkspaceId?: string;
      status: "invalid";
    }
  | {
      projectId: string | null;
      status: "valid";
      workspaceId: string;
    };

type StoredCrmScopePreference = {
  projectId: string | null;
  userId: string;
  version: typeof CRM_SCOPE_VERSION;
  workspaceId: string;
};

export function createDefaultCrmScope(workspaceId: string): CrmScope {
  return {
    projectId: null,
    source: "default",
    status: "valid",
    version: CRM_SCOPE_VERSION,
    workspaceId,
  };
}

export function isSafeCrmScopeId(value: unknown): value is string {
  return typeof value === "string" && CRM_SCOPE_ID_PATTERN.test(value);
}

export function parseCrmScopeUrl(search: string): ParsedCrmScopeUrl {
  const params = new URLSearchParams(search);
  const workspaceValues = params.getAll(CRM_SCOPE_WORKSPACE_PARAM);
  const projectValues = params.getAll(CRM_SCOPE_PROJECT_PARAM);

  if (workspaceValues.length === 0 && projectValues.length === 0) {
    return { status: "absent" };
  }

  if (workspaceValues.length > 1 || projectValues.length > 1) {
    return {
      invalidReason: "duplicate_parameter",
      requestedProjectId: projectValues[0] === CRM_SCOPE_ALL_PROJECTS ? null : projectValues[0],
      requestedWorkspaceId: workspaceValues[0],
      status: "invalid",
    };
  }

  if (workspaceValues.length !== 1 || projectValues.length !== 1) {
    return {
      invalidReason: "missing_parameter",
      requestedProjectId: projectValues[0] === CRM_SCOPE_ALL_PROJECTS ? null : projectValues[0],
      requestedWorkspaceId: workspaceValues[0],
      status: "invalid",
    };
  }

  const [workspaceId] = workspaceValues;
  const [projectValue] = projectValues;
  const projectId = projectValue === CRM_SCOPE_ALL_PROJECTS ? null : projectValue;

  if (!isSafeCrmScopeId(workspaceId) || (projectId !== null && !isSafeCrmScopeId(projectId))) {
    return {
      invalidReason: "invalid_parameter",
      requestedProjectId: projectId,
      requestedWorkspaceId: workspaceId,
      status: "invalid",
    };
  }

  return { projectId, status: "valid", workspaceId };
}

export function getCrmScopePreferenceKey(userId: string, workspaceId: string) {
  return `novalure:crm-scope:v${CRM_SCOPE_VERSION}:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;
}

function readCrmScopePreference(
  storage: CrmScopeStorage | null | undefined,
  userId: string,
  workspaceId: string,
): StoredCrmScopePreference | null {
  if (!storage) return null;

  try {
    const rawPreference = storage.getItem(getCrmScopePreferenceKey(userId, workspaceId));
    if (!rawPreference) return null;

    const preference = JSON.parse(rawPreference) as Partial<StoredCrmScopePreference> | null;
    if (
      !preference ||
      preference.version !== CRM_SCOPE_VERSION ||
      preference.userId !== userId ||
      preference.workspaceId !== workspaceId ||
      (preference.projectId !== null && !isSafeCrmScopeId(preference.projectId))
    ) {
      return null;
    }

    return preference as StoredCrmScopePreference;
  } catch {
    return null;
  }
}

function validateCrmScopeCandidate(input: {
  projectId: string | null;
  projects: CrmScopeProject[];
  requestedWorkspaceId: string;
  source: CrmScopeSource;
  workspaceId: string;
}): CrmScope {
  if (
    !isSafeCrmScopeId(input.workspaceId) ||
    !isSafeCrmScopeId(input.requestedWorkspaceId) ||
    (input.projectId !== null && !isSafeCrmScopeId(input.projectId))
  ) {
    return {
      invalidReason: "invalid_parameter",
      projectId: input.projectId,
      requestedProjectId: input.projectId,
      requestedWorkspaceId: input.requestedWorkspaceId,
      source: input.source,
      status: "invalid",
      version: CRM_SCOPE_VERSION,
      workspaceId: input.workspaceId,
    };
  }

  if (input.requestedWorkspaceId !== input.workspaceId) {
    return {
      invalidReason: "workspace_mismatch",
      projectId: input.projectId,
      requestedProjectId: input.projectId,
      requestedWorkspaceId: input.requestedWorkspaceId,
      source: input.source,
      status: "invalid",
      version: CRM_SCOPE_VERSION,
      workspaceId: input.workspaceId,
    };
  }

  if (
    input.projectId !== null &&
    !input.projects.some(
      (project) => project.id === input.projectId && project.workspaceId === input.workspaceId,
    )
  ) {
    return {
      invalidReason: "project_not_available",
      projectId: input.projectId,
      requestedProjectId: input.projectId,
      requestedWorkspaceId: input.requestedWorkspaceId,
      source: input.source,
      status: "invalid",
      version: CRM_SCOPE_VERSION,
      workspaceId: input.workspaceId,
    };
  }

  return {
    projectId: input.projectId,
    source: input.source,
    status: "valid",
    version: CRM_SCOPE_VERSION,
    workspaceId: input.workspaceId,
  };
}

export function resolveCrmScope(input: {
  projects: CrmScopeProject[];
  search: string;
  storage?: CrmScopeStorage | null;
  userId: string;
  workspaceId: string;
}): CrmScope {
  const parsedUrlScope = parseCrmScopeUrl(input.search);

  if (parsedUrlScope.status === "invalid") {
    return {
      invalidReason: parsedUrlScope.invalidReason,
      projectId: parsedUrlScope.requestedProjectId ?? null,
      requestedProjectId: parsedUrlScope.requestedProjectId,
      requestedWorkspaceId: parsedUrlScope.requestedWorkspaceId,
      source: "url",
      status: "invalid",
      version: CRM_SCOPE_VERSION,
      workspaceId: input.workspaceId,
    };
  }

  if (parsedUrlScope.status === "valid") {
    return validateCrmScopeCandidate({
      projectId: parsedUrlScope.projectId,
      projects: input.projects,
      requestedWorkspaceId: parsedUrlScope.workspaceId,
      source: "url",
      workspaceId: input.workspaceId,
    });
  }

  const preference = readCrmScopePreference(input.storage, input.userId, input.workspaceId);
  if (preference) {
    return validateCrmScopeCandidate({
      projectId: preference.projectId,
      projects: input.projects,
      requestedWorkspaceId: preference.workspaceId,
      source: "user",
      workspaceId: input.workspaceId,
    });
  }

  return createDefaultCrmScope(input.workspaceId);
}

export function createSelectedCrmScope(input: {
  projectId: string | null;
  projects: CrmScopeProject[];
  workspaceId: string;
}): CrmScope {
  return validateCrmScopeCandidate({
    projectId: input.projectId,
    projects: input.projects,
    requestedWorkspaceId: input.workspaceId,
    source: "user",
    workspaceId: input.workspaceId,
  });
}

export function writeCrmScopePreference(
  storage: CrmScopeStorage | null | undefined,
  userId: string,
  scope: CrmScope,
) {
  if (!storage || scope.status !== "valid") return false;

  const preference: StoredCrmScopePreference = {
    projectId: scope.projectId,
    userId,
    version: CRM_SCOPE_VERSION,
    workspaceId: scope.workspaceId,
  };

  try {
    storage.setItem(
      getCrmScopePreferenceKey(userId, scope.workspaceId),
      JSON.stringify(preference),
    );
    return true;
  } catch {
    return false;
  }
}

export function serializeCrmScopeUrl(
  currentUrl: string,
  scope: Pick<CrmScope, "projectId" | "workspaceId">,
) {
  const url = new URL(currentUrl, "https://crm.novalure.invalid");
  url.searchParams.set(CRM_SCOPE_WORKSPACE_PARAM, scope.workspaceId);
  url.searchParams.set(CRM_SCOPE_PROJECT_PARAM, scope.projectId ?? CRM_SCOPE_ALL_PROJECTS);
  return `${url.pathname}${url.search}${url.hash}`;
}
