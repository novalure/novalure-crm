import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function readProjectFile(path) {
  return readFileSync(join(rootDir, path), "utf8");
}

function loadPanelExports() {
  const path = "src/components/admin/system-releases-panel.tsx";
  const { outputText } = ts.transpileModule(readProjectFile(path), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
  });
  const cjsModule = { exports: {} };
  const sandbox = {
    exports: cjsModule.exports,
    module: cjsModule,
    require(specifier) {
      if (specifier === "react") {
        return {
          useEffect() {},
          useState(initialValue) {
            return [initialValue, () => {}];
          },
        };
      }
      if (specifier === "react/jsx-runtime") {
        return { Fragment: Symbol("Fragment"), jsx() {}, jsxs() {} };
      }
      throw new Error(`Unexpected runtime import in ${path}: ${specifier}`);
    },
  };

  vm.runInNewContext(outputText, sandbox, { filename: path });
  return cjsModule.exports;
}

const { parseSystemDatabaseDiagnostics } = loadPanelExports();

function validDiagnostics() {
  return {
    expectedTables: ["workspaces"],
    issues: [],
    migrationLedger: [
      {
        checksum: "sha256:test",
        version: "001",
      },
    ],
    migrationLedgerError: null,
    migrationStatus: { checksumRows: 1, currentVersion: "001", rows: 1 },
    missingTables: [],
    ok: true,
    status: { configured: true, directUrlEnv: "POSTGRES_URL_NON_POOLING", pooledUrlEnv: "DATABASE_URL" },
    tableCheckError: null,
    tableStatus: [{ exists: true, tableName: "workspaces" }],
  };
}

test("release panel accepts the exact nested diagnostics contract", () => {
  assert.deepEqual(parseSystemDatabaseDiagnostics(validDiagnostics()), validDiagnostics());
});

test("release panel rejects legacy or malformed payloads instead of showing a false green state", () => {
  const legacyTopLevelMigration = {
    ...validDiagnostics(),
    currentMigration: "001",
    migrationStatus: { checksumRows: 1, rows: 1 },
  };
  assert.equal(parseSystemDatabaseDiagnostics(legacyTopLevelMigration), null);

  assert.equal(
    parseSystemDatabaseDiagnostics({
      ...validDiagnostics(),
      migrationStatus: { checksumRows: 2, currentVersion: "001", rows: 1 },
    }),
    null,
  );
  assert.equal(
    parseSystemDatabaseDiagnostics({
      ...validDiagnostics(),
      issues: [{ code: "unrecognized_green_override" }],
    }),
    null,
  );
  assert.equal(
    parseSystemDatabaseDiagnostics({
      ...validDiagnostics(),
      migrationLedger: [{ checksum: null, version: "001" }],
    }),
    null,
  );
  assert.equal(
    parseSystemDatabaseDiagnostics({
      ...validDiagnostics(),
      issues: [{ code: "migration_ledger_empty" }],
      ok: true,
    }),
    null,
  );
  assert.equal(
    parseSystemDatabaseDiagnostics({
      ...validDiagnostics(),
      migrationStatus: { checksumRows: 0, currentVersion: "001", rows: 1 },
    }),
    null,
  );
});

test("route derives readiness from explicit issues and the panel reads currentVersion only from migrationStatus", () => {
  const route = readProjectFile("src/app/api/system/database/route.ts");
  const panel = readProjectFile("src/components/admin/system-releases-panel.tsx");

  assert.match(route, /ok: issues\.length === 0/);
  assert.match(route, /code: "migration_ledger_empty"/);
  assert.match(route, /code: "migration_checksum_incomplete"/);
  assert.match(route, /currentVersion: currentMigration/);
  assert.match(panel, /status\?\.migrationStatus\.currentVersion/);
  assert.doesNotMatch(panel, /status\?\.currentMigration/);
  assert.match(panel, /Checksums im Ledger/);
  assert.match(panel, /Recorded checksums/);
});

test("system diagnostics stay restricted to the two explicit administrator product roles", () => {
  const route = readProjectFile("src/app/api/system/database/route.ts");
  const policy = readProjectFile("src/lib/launch-scope.ts");

  assert.match(route, /evaluateLaunchScope\("systemDatabaseDiagnostics", session\)\.allowed/);
  assert.match(policy, /internalProductRoles = Object\.freeze\(\["platform_admin", "novalureAdmin"\]\)/);
  assert.match(policy, /systemDatabaseDiagnostics:[\s\S]*allowedProductRoles: internalProductRoles/);
  assert.match(policy, /requiredProductPermissions: Object\.freeze\(\["novalure:internal"\]\)/);
});

test("governance inventory cannot render a static QA green state as runtime evidence", () => {
  const panel = readProjectFile("src/components/admin/governance-compliance-panel.tsx");

  assert.match(panel, /data-governance-runtime-evidence="unavailable"/);
  assert.match(panel, /data-evidence-state="pending"/);
  assert.match(panel, /QA-Nachweis ausstehend/);
  assert.doesNotMatch(panel, /QA-verifiziert|QA verified|emerald-/);
});
