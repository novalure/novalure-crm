import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/components/form-command-center.tsx", import.meta.url), "utf8");
const loaderSource = source.slice(source.indexOf("async function loadPersistedForms()"), source.indexOf("    loadPersistedForms();"));
assert.ok(loaderSource.startsWith("async function loadPersistedForms()"));
const compiledLoader = ts.transpileModule(loaderSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function runLoader(response, { cancelled = false, rejects = false } = {}) {
  const changes = {};
  const loader = vm.runInNewContext(`${compiledLoader}\nloadPersistedForms`, {
    cancelled,
    copy: {},
    csrfFetch: async (url, options) => {
      assert.equal(url, "/api/forms");
      assert.equal(options.cache, "no-store");
      if (rejects) throw new Error("Network unavailable");
      return response;
    },
    ensureFormStructure: form => ({ ...form, normalized: true }),
    setForms: forms => { changes.forms = forms; },
    setSelectedFormId: id => { changes.selectedId = id; },
    setSubmissionRows: submissions => { changes.submissions = submissions; },
    setPersistenceSource: value => { changes.source = value; },
  });
  await loader();
  return changes;
}

test("mounted forms start with no business records and templates require explicit creation", () => {
  assert.match(source, /useState<WebsiteForm\[\]>\(\[\]\)/);
  assert.doesNotMatch(source, /createInitialForms|Wohnpark Graz|form_beratung_wohnpark/);
  assert.match(source, /function addForm\(\) \{\s*const form = createNewForm\(/);
  assert.match(source, /persistenceSource === "loading"[\s\S]*?Loading forms/);
  assert.match(source, /persistenceSource === "fallback"[\s\S]*?Saved forms are currently unavailable/);
});

test("a verified empty database response clears forms and selection", async () => {
  const result = await runLoader({ ok: true, json: async () => ({ source: "database", forms: [], submissions: [] }) });
  assert.deepEqual(result, { source: "database", forms: [], submissions: [], selectedId: "" });
});

test("real persisted forms and submissions retain the existing normalization flow", async () => {
  const form = { id: "persisted-form", name: "Actual form" };
  const submission = { id: "persisted-submission", formId: form.id };
  const result = await runLoader({ ok: true, json: async () => ({ source: "database", forms: [form], submissions: [submission] }) });
  assert.deepEqual(result, { source: "database", forms: [{ ...form, normalized: true }], submissions: [submission], selectedId: form.id });
});

test("HTTP, network and repository fallback failures stay unavailable instead of confirmed empty", async () => {
  for (const [response, options] of [
    [{ ok: false }, {}],
    [null, { rejects: true }],
    [{ ok: true, json: async () => ({ source: "fallback", forms: [], submissions: [] }) }, {}],
    [{ ok: true, json: async () => ({ source: "database", error: "Unavailable", forms: [], submissions: [] }) }, {}],
  ]) {
    assert.deepEqual(await runLoader(response, options), { source: "fallback" });
  }
});

test("responses after unmount never mutate form state", async () => {
  assert.deepEqual(await runLoader({ ok: false }, { cancelled: true }), {});
});
