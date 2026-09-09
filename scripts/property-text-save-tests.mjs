import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const propertyId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const source = ts.transpileModule(fs.readFileSync("src/lib/db/property-department-repositories.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function repository({ exists = true, fail = false } = {}) {
  let transaction = null;
  let directWrites = 0;
  const sql = { query: (query, params) => ({ query, params }), transaction: async (queries) => { transaction = queries; if (fail) throw new Error("insert failed"); return []; } };
  const exports = {};
  vm.runInNewContext(source, { exports, require: (id) => {
    if (id.endsWith("db/client")) return { getSqlClient: () => sql, executeQuery: async () => { directWrites++; }, queryOne: async (query) => query.includes("from seller_listings") ? (exists ? { projectId } : null) : { id: propertyId } };
    if (id.endsWith("runtime-repositories")) return { canPersist: () => true, isUuid: () => true, writeAuditLog: async () => {} };
    return {};
  }, console, Date, JSON });
  return { save: exports.savePropertyTextBlocks, transaction: () => transaction, directWrites: () => directWrites };
}

const document = { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Schöne Wohnung" }] }] };
const input = { session: { workspaceId, userId: propertyId }, propertyId, projectId: "44444444-4444-4444-8444-444444444444", textBlocks: [{ textKey: "expose", content: "Schöne Wohnung", title: "Exposé", metadata: { editorDocument: document } }] };

test("formatted text and its plain text fallback are saved together in one transaction", async () => {
  const repo = repository();
  const result = await repo.save(input);
  assert.equal(result.persisted, true);
  const queries = repo.transaction();
  assert.equal(queries.length, 3);
  assert.match(queries[0].query, /for update/);
  assert.match(queries[1].query, /delete from property_text_blocks/);
  assert.equal(queries[2].params[1], projectId, "use the property's actual project, not a caller-supplied one");
  assert.equal(queries[2].params[6], "Schöne Wohnung");
  assert.deepEqual(JSON.parse(queries[2].params[12]).editorDocument, document);
  assert.equal(repo.directWrites(), 0);
});

test("a failed insert never performs a standalone delete before the transaction", async () => {
  const repo = repository({ fail: true });
  await assert.rejects(repo.save(input), /insert failed/);
  assert.equal(repo.directWrites(), 0);
});

test("a property outside the current workspace is rejected before any text write", async () => {
  const repo = repository({ exists: false });
  assert.equal((await repo.save(input)).persisted, false);
  assert.equal(repo.transaction(), null);
});
