import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CRM_SCOPE_ALL_PROJECTS,
  createSelectedCrmScope,
  getCrmScopePreferenceKey,
  parseCrmScopeUrl,
  resolveCrmScope,
  serializeCrmScopeUrl,
  writeCrmScopePreference,
} from "../src/lib/crm-scope.ts";

const workspaceA = "workspace_a";
const workspaceB = "workspace_b";
const userA = "user_a";
const projectA = { id: "project_a", workspaceId: workspaceA };
const projectB = { id: "project_b", workspaceId: workspaceA };
const foreignProject = { id: "project_foreign", workspaceId: workspaceB };

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    values,
  };
}

test("CRM scope uses URL, then user/workspace preference, then deliberate All", () => {
  const storage = createStorage();
  const preferredScope = createSelectedCrmScope({
    projectId: projectA.id,
    projects: [projectA, projectB],
    workspaceId: workspaceA,
  });
  assert.equal(writeCrmScopePreference(storage, userA, preferredScope), true);

  const urlScope = resolveCrmScope({
    projects: [projectA, projectB],
    search: `?workspaceId=${workspaceA}&projectId=${projectB.id}`,
    storage,
    userId: userA,
    workspaceId: workspaceA,
  });
  assert.deepEqual(
    { projectId: urlScope.projectId, source: urlScope.source, status: urlScope.status },
    { projectId: projectB.id, source: "url", status: "valid" },
  );

  const preferenceScope = resolveCrmScope({
    projects: [projectA, projectB],
    search: "?lang=de#contacts",
    storage,
    userId: userA,
    workspaceId: workspaceA,
  });
  assert.deepEqual(
    { projectId: preferenceScope.projectId, source: preferenceScope.source, status: preferenceScope.status },
    { projectId: projectA.id, source: "user", status: "valid" },
  );

  const defaultScope = resolveCrmScope({
    projects: [projectA],
    search: "",
    storage: createStorage(),
    userId: userA,
    workspaceId: workspaceA,
  });
  assert.deepEqual(
    { projectId: defaultScope.projectId, source: defaultScope.source, status: defaultScope.status },
    { projectId: null, source: "default", status: "valid" },
  );
});

test("CRM scope parser rejects partial, duplicate and unsafe URL candidates", () => {
  assert.deepEqual(parseCrmScopeUrl("?lang=de"), { status: "absent" });
  assert.equal(parseCrmScopeUrl(`?workspaceId=${workspaceA}`).status, "invalid");
  assert.equal(
    parseCrmScopeUrl(`?workspaceId=${workspaceA}&projectId=${projectA.id}&projectId=${projectB.id}`).status,
    "invalid",
  );
  assert.equal(
    parseCrmScopeUrl(`?workspaceId=${workspaceA}&projectId=${encodeURIComponent("../project")}`).status,
    "invalid",
  );
  assert.deepEqual(
    parseCrmScopeUrl(`?workspaceId=${workspaceA}&projectId=${CRM_SCOPE_ALL_PROJECTS}`),
    { projectId: null, status: "valid", workspaceId: workspaceA },
  );
});

test("foreign, deleted and wrong-workspace project scopes remain visibly invalid", () => {
  const foreign = resolveCrmScope({
    projects: [projectA, foreignProject],
    search: `?workspaceId=${workspaceA}&projectId=${foreignProject.id}`,
    userId: userA,
    workspaceId: workspaceA,
  });
  assert.equal(foreign.status, "invalid");
  assert.equal(foreign.invalidReason, "project_not_available");
  assert.equal(foreign.projectId, foreignProject.id);

  const deleted = resolveCrmScope({
    projects: [projectA],
    search: `?workspaceId=${workspaceA}&projectId=project_deleted`,
    userId: userA,
    workspaceId: workspaceA,
  });
  assert.equal(deleted.status, "invalid");
  assert.equal(deleted.invalidReason, "project_not_available");

  const wrongWorkspace = resolveCrmScope({
    projects: [projectA],
    search: `?workspaceId=${workspaceB}&projectId=${projectA.id}`,
    userId: userA,
    workspaceId: workspaceA,
  });
  assert.equal(wrongWorkspace.status, "invalid");
  assert.equal(wrongWorkspace.invalidReason, "workspace_mismatch");
});

test("preference keys isolate user and workspace and stale preferences fail closed", () => {
  assert.notEqual(
    getCrmScopePreferenceKey(userA, workspaceA),
    getCrmScopePreferenceKey("user_b", workspaceA),
  );
  assert.notEqual(
    getCrmScopePreferenceKey(userA, workspaceA),
    getCrmScopePreferenceKey(userA, workspaceB),
  );

  const storage = createStorage();
  storage.setItem(
    getCrmScopePreferenceKey(userA, workspaceA),
    JSON.stringify({ projectId: "project_deleted", userId: userA, version: 1, workspaceId: workspaceA }),
  );
  const scope = resolveCrmScope({
    projects: [projectA],
    search: "",
    storage,
    userId: userA,
    workspaceId: workspaceA,
  });
  assert.equal(scope.status, "invalid");
  assert.equal(scope.source, "user");
  assert.equal(scope.projectId, "project_deleted");
});

test("scope serialization preserves module hash and unrelated query state", () => {
  const scope = createSelectedCrmScope({
    projectId: projectB.id,
    projects: [projectA, projectB],
    workspaceId: workspaceA,
  });
  assert.equal(
    serializeCrmScopeUrl("https://crm.example/?lang=de&view=compact#contacts", scope),
    `/?lang=de&view=compact&workspaceId=${workspaceA}&projectId=${projectB.id}#contacts`,
  );

  const allScope = createSelectedCrmScope({
    projectId: null,
    projects: [projectA],
    workspaceId: workspaceA,
  });
  assert.match(serializeCrmScopeUrl("https://crm.example/#calendar", allScope), /projectId=all#calendar$/);
});

test("shell persists history and all five audited drafts have no first-project fallback", async () => {
  const shell = await readFile(new URL("../src/components/crm-workspace.tsx", import.meta.url), "utf8");
  assert.match(shell, /window\.history\.pushState/);
  assert.match(shell, /addEventListener\("popstate"/);
  assert.match(shell, /writeCrmScopePreference/);
  assert.match(shell, /scopeHydrated && projectScopeInvalid/);

  const draftComponents = [
    "contact-command-center.tsx",
    "lead-inbox.tsx",
    "task-command-center.tsx",
    "calendar-command-center.tsx",
    "property-command-center.tsx",
  ];
  for (const fileName of draftComponents) {
    const source = await readFile(new URL(`../src/components/${fileName}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /projects\[0\]/, `${fileName} must not default to projects[0]`);
    assert.match(source, /activeProjectId/, `${fileName} must receive the canonical active project`);
    assert.match(source, /<option value="">/, `${fileName} must expose an empty required selection`);
  }
});
