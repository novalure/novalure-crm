import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeRequire = createRequire(import.meta.url);
let publicFunnelPublicationAllowed = true;

function readProjectFile(path) {
  return readFileSync(join(rootDir, path), "utf8");
}

function loadBoundaryExports() {
  const path = "src/lib/funnel-public-access.ts";
  const { outputText } = ts.transpileModule(readProjectFile(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
  });
  const cjsModule = { exports: {} };
  const sandbox = {
    Buffer,
    exports: cjsModule.exports,
    module: cjsModule,
    require(specifier) {
      if (specifier === "server-only") return {};
      if (specifier === "node:crypto") return nodeRequire(specifier);
      if (specifier === "@/lib/launch-scope") {
        return {
          evaluateLaunchScope: () => ({ allowed: publicFunnelPublicationAllowed }),
        };
      }
      throw new Error(`Unexpected runtime import in ${path}: ${specifier}`);
    },
  };

  vm.runInNewContext(outputText, sandbox, { filename: path });
  return cjsModule.exports;
}

const {
  canUsePublicLiveFunnel,
  getStoredFunnelPublishToken,
  isStoredFunnelPubliclyLive,
} = loadBoundaryExports();

function publishedFixture() {
  const blueprint = {
    status: "aktiv",
    tracking: { publishToken: "blueprint-token" },
  };
  const stored = {
    blueprintOrigin: "persisted",
    source: "database",
    status: "aktiv",
    tracking: { publishToken: "stored-token" },
  };
  return { blueprint, stored };
}

test("live funnel access requires an exact token and a persisted active database blueprint", () => {
  const fixture = publishedFixture();

  assert.equal(isStoredFunnelPubliclyLive(fixture), true);
  assert.equal(canUsePublicLiveFunnel({ ...fixture, token: "stored-token" }), true);
  assert.equal(canUsePublicLiveFunnel({ ...fixture, token: "wrong-token" }), false);
  assert.equal(canUsePublicLiveFunnel({ ...fixture, token: "" }), false);
  assert.equal(
    canUsePublicLiveFunnel({ ...fixture, stored: { ...fixture.stored, blueprintOrigin: "database-draft" }, token: "stored-token" }),
    false,
  );
  assert.equal(
    isStoredFunnelPubliclyLive({ ...fixture, stored: { ...fixture.stored, blueprintOrigin: "database-draft" } }),
    false,
  );
  assert.equal(
    canUsePublicLiveFunnel({ ...fixture, stored: { ...fixture.stored, status: "entwurf" }, token: "stored-token" }),
    false,
  );
  assert.equal(
    canUsePublicLiveFunnel({ ...fixture, blueprint: { ...fixture.blueprint, status: "entwurf" }, token: "stored-token" }),
    false,
  );
});

test("live funnel access fails closed when publication is launch-off", () => {
  const fixture = publishedFixture();
  publicFunnelPublicationAllowed = false;
  try {
    assert.equal(isStoredFunnelPubliclyLive(fixture), false);
    assert.equal(canUsePublicLiveFunnel({ ...fixture, token: "stored-token" }), false);
  } finally {
    publicFunnelPublicationAllowed = true;
  }
});

test("stored publish token is authoritative over blueprint copies", () => {
  const fixture = publishedFixture();
  assert.equal(getStoredFunnelPublishToken(fixture.stored.tracking), "stored-token");
  assert.equal(getStoredFunnelPublishToken(undefined), "");
  assert.equal(
    canUsePublicLiveFunnel({
      ...fixture,
      stored: { ...fixture.stored, tracking: {} },
      token: "blueprint-token",
    }),
    false,
  );
});

test("blueprint writes cannot mass-assign the server-managed publish token", () => {
  const store = readProjectFile("src/lib/funnel-store.ts");
  const access = readProjectFile("src/lib/funnel-public-access.ts");

  assert.match(store, /delete tracking\.publicToken/);
  assert.match(store, /delete tracking\.publishToken/);
  assert.match(store, /findFunnelDatabaseRowInTransaction[\s\S]*for update of f/);
  assert.match(store, /tracking = tracking \|\| \$11::jsonb/);
  assert.doesNotMatch(store, /serverTracking|existingTracking|createPublicToken/);
  assert.doesNotMatch(access, /blueprintTracking\.(?:publicToken|publishToken)/);
});

test("test preview and submission reads remain scoped to the authenticated workspace", () => {
  const preview = readProjectFile("src/app/preview/[funnelId]/page.tsx");
  const submissions = readProjectFile("src/app/api/funnels/[funnelId]/submissions/route.ts");

  assert.match(preview, /getStoredFunnel\(funnelId, session\.workspaceId\)/);
  assert.match(preview, /session\.permissions\.includes\("funnels:write"\)/);
  assert.match(preview, /hasProductCapability\(session\.productRole, "funnels:publish"\)/);
  assert.match(preview, /canUsePublicLiveFunnel/);
  assert.match(preview, /createPublicSubmissionProof/);
  assert.match(preview, /action: publicSubmissionActions\.funnel/);
  assert.doesNotMatch(preview, /catch\s*(?:\([^)]*\))?\s*\{[\s\S]*?notFound\(\)/);
  assert.doesNotMatch(preview, /\?\? "local"|fixture|demoFunnel/);

  assert.match(submissions, /getStoredFunnel\(funnelId, auth\?\.session\.workspaceId\)/);
  assert.match(submissions, /isStoredFunnelPubliclyLive/);
  assert.match(submissions, /canonicalizeFunnelSubmissionPayload/);
  assert.match(submissions, /verifyPublicSubmissionProof/);
  assert.doesNotMatch(submissions, /getRequestToken|x-novalure-funnel-token|x-funnel-token/);
});
