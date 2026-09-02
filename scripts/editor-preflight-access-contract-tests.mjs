import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const nodeRequire = createRequire(import.meta.url);

async function source(name) {
  return readFile(path.join(repositoryRoot, name), "utf8");
}

async function loadCommonJsTypeScript(name, dependencyMocks = {}) {
  const input = await source(name);
  const { outputText } = ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: name,
  });
  const cjsModule = { exports: {} };
  vm.runInNewContext(outputText, {
    Buffer,
    exports: cjsModule.exports,
    module: cjsModule,
    process,
    require(specifier) {
      if (Object.hasOwn(dependencyMocks, specifier)) return dependencyMocks[specifier];
      if (specifier === "server-only") return {};
      if (specifier.startsWith("node:")) return nodeRequire(specifier);
      throw new Error(`Unexpected runtime import in ${name}: ${specifier}`);
    },
  }, { filename: name });
  return cjsModule.exports;
}

function request(body) {
  return { json: async () => body };
}

test("generic editor preflight is capability-specific and evaluation-only", async () => {
  let currentSession = {
    permissions: ["crm:read", "funnels:write"],
    productRole: "team_member",
  };
  const evaluations = [];
  const route = await loadCommonJsTypeScript("src/app/api/crm/editor-preflight/route.ts", {
    "next/server": {
      NextResponse: {
        json(body, init = {}) {
          return { body, status: init.status ?? 200 };
        },
      },
    },
    "@/lib/auth/session": {
      requirePermission: async (_request, permission) => {
        assert.equal(permission, "crm:read");
        return { ok: true, session: currentSession };
      },
    },
    "@/lib/contact-access": {
      canViewAllWorkspaceContacts: (session) => session.productRole === "workspace_admin",
    },
    "@/lib/db/editor-preflight-repositories": {
      evaluateEditorPreflight: async (input) => {
        evaluations.push(input);
        return { id: "preflight_evaluation_only", status: "pass" };
      },
      runEditorPreflight() {
        throw new Error("generic preflight must not persist");
      },
    },
    "@/lib/product-model": {
      hasProductCapability: (productRole, capability) => (
        (productRole === "team_member" && ["bots:publish", "funnels:publish"].includes(capability)) ||
        productRole === "workspace_admin"
      ),
    },
  });

  const funnelResponse = await route.POST(request({ editorType: "funnel", payload: {} }));
  assert.equal(funnelResponse.status, 200);
  assert.equal(evaluations.length, 1);

  currentSession = { permissions: ["crm:read"], productRole: "team_member" };
  const denied = await route.POST(request({ editorType: "funnel", payload: {} }));
  assert.equal(denied.status, 403);
  assert.equal(evaluations.length, 1);

  currentSession = { permissions: ["crm:read", "crm:write"], productRole: "team_member" };
  const botDenied = await route.POST(request({ editorType: "bot", payload: {} }));
  assert.equal(botDenied.status, 403);
  assert.equal(evaluations.length, 1);

  currentSession = { permissions: ["crm:read", "crm:write"], productRole: "workspace_admin" };
  const botAllowed = await route.POST(request({ editorType: "bot", payload: {} }));
  assert.equal(botAllowed.status, 200);
  assert.equal(evaluations.length, 2);
});

test("route source keeps CSRF-aware auth and cannot write arbitrary preflight rows", async () => {
  const route = await source("src/app/api/crm/editor-preflight/route.ts");
  assert.match(route, /requirePermission\(request, "crm:read"\)/u);
  assert.match(route, /editorPolicies[\s\S]*bots:publish[\s\S]*calendar:manage[\s\S]*funnels:publish[\s\S]*newsletter:send/u);
  assert.match(route, /auth\.session\.permissions\.includes\(policy\.permission\)/u);
  assert.match(route, /hasProductCapability\(auth\.session\.productRole, policy\.capability\)/u);
  assert.match(route, /editorType === "bot"[\s\S]*canViewAllWorkspaceContacts/u);
  assert.match(route, /evaluateEditorPreflight\(/u);
  assert.doesNotMatch(route, /runEditorPreflight\(/u);
});
