import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgeCommandCenter } from "../src/components/knowledge-command-center";
import { getKnowledgeCenterCopy } from "../src/lib/knowledge-center/copy";
import type { KnowledgeItem, Project } from "../src/lib/crm-types";

const legacyItems: KnowledgeItem[] = [
  {
    id: "legacy-source",
    workspaceId: "foreign-workspace",
    projectId: "foreign-project",
    name: "UNAUTHORIZED_LEGACY_SOURCE",
    items: 900,
    coverage: "100%",
    status: "approved",
  },
];
const legacyProjects: Project[] = [
  {
    id: "foreign-project",
    workspaceId: "foreign-workspace",
    name: "UNAUTHORIZED_LEGACY_PROJECT",
    type: "Legacy fixture",
    leads: 0,
    revenue: "0",
    status: "Aktiv",
    defaultPipelineId: "legacy-pipeline",
  },
];

test("Knowledge Center initial rendering waits for authorized data and never shows legacy source fixtures", () => {
  const html = renderToStaticMarkup(
    createElement(KnowledgeCommandCenter, {
      language: "en",
      items: legacyItems,
      projects: legacyProjects,
      projectLabel: "UNAUTHORIZED_LEGACY_LABEL",
      workspaceId: "selected-workspace",
      workspaceName: "Selected Company",
    }),
  );
  assert.match(html, /Loading knowledge center/);
  assert.match(html, /Selected Company/);
  assert.doesNotMatch(
    html,
    /UNAUTHORIZED_LEGACY|900|100%|Vector bereit|prepared_call|prepared_url/,
  );
  assert.doesNotMatch(
    html,
    /<progress|Knowledge sources \(/,
    "loading does not invent usage or source counts",
  );
});

test("the loading view provides a named section, visible context labels and announced status in both supported CRM languages", () => {
  for (const language of ["de", "en"] as const) {
    const html = renderToStaticMarkup(
      createElement(KnowledgeCommandCenter, {
        language,
        workspaceName: "Company <script>unsafe()</script>",
      }),
    );
    const text = getKnowledgeCenterCopy(language);
    assert.match(html, /<section aria-labelledby="[^"]+"/);
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
    assert.ok(html.includes(text.company));
    assert.ok(html.includes(text.project));
    assert.ok(html.includes(text.loading));
    assert.match(
      html,
      new RegExp(`<label[^>]*for="[^"]+"[^>]*>${text.company}</label>`),
    );
    assert.match(
      html,
      new RegExp(`<label[^>]*for="[^"]+"[^>]*>${text.project}</label>`),
    );
    assert.doesNotMatch(
      html,
      /<label[^>]*>(?:(?!<\/label>)[\s\S])*<select/,
      "select option text is outside the accessible field label",
    );
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  }
});

test("knowledge copy has complete German, English and Spanish customer-facing states", () => {
  const languages = ["de", "en", "es"] as const;
  const required = [
    "loadError",
    "unavailable",
    "disabled",
    "noAreas",
    "noSources",
    "draftHint",
    "assignmentEmpty",
    "usageHint",
    "uploadError",
  ] as const;
  for (const language of languages) {
    const copy = getKnowledgeCenterCopy(language);
    for (const key of required)
      assert.ok(copy[key].trim(), `${language}: ${key}`);
    assert.doesNotMatch(
      copy.draftHint,
      /Arbeitspaket|work package|paquete de trabajo/,
      "product copy does not expose work-package implementation details",
    );
  }
});

test("blank industry templates preserve existing structured values, types and nested data across edits", async () => {
  const {
    knowledgeTemplates,
    createStructuredKnowledgeRows,
    addKnowledgeTemplateFields,
    serializeStructuredKnowledge,
  } = await import("../src/lib/knowledge-center/templates");
  for (const template of knowledgeTemplates) {
    const rows = addKnowledgeTemplateFields([], {}, template.id);
    assert.ok(rows.length > 0);
    assert.ok(
      rows.every((row) => row.value === ""),
      "templates contain field metadata only, never business values",
    );
    assert.deepEqual(serializeStructuredKnowledge({}, rows), {});
  }
  const saved = {
    companyName: "Current customer company",
    customNumber: 0,
    customFlag: false,
    customNull: null,
    contact: { email: "real@example.test", departments: ["service"] },
  };
  const rows = addKnowledgeTemplateFields(
    createStructuredKnowledgeRows(saved),
    saved,
    "developer_unit",
  );
  const edited = rows.map((row) =>
    row.key === "companyName"
      ? { ...row, value: "Updated company" }
      : row.key === "rooms"
        ? { ...row, value: "3" }
        : row,
  );
  const result = serializeStructuredKnowledge(saved, edited);
  assert.equal(result.companyName, "Updated company");
  assert.equal(result.rooms, "3");
  assert.equal(result.customNumber, 0);
  assert.equal(result.customFlag, false);
  assert.equal(result.customNull, null);
  assert.deepEqual(result.contact, saved.contact);
  assert.equal(
    saved.companyName,
    "Current customer company",
    "serialization does not mutate loaded source data",
  );
});

test("structured edits require explicit removal and reject collisions with preserved values or unsafe keys", async () => {
  const { createStructuredKnowledgeRows, serializeStructuredKnowledge } =
    await import("../src/lib/knowledge-center/templates");
  const saved = {
    description: "Retained description",
    nested: { important: true },
  };
  assert.deepEqual(serializeStructuredKnowledge(saved, []), saved);
  assert.deepEqual(serializeStructuredKnowledge(saved, [], ["description"]), {
    nested: saved.nested,
  });
  for (const key of ["nested", "__proto__", "constructor", "prototype"]) {
    assert.throws(() =>
      serializeStructuredKnowledge(saved, [
        { id: "new", key, value: "overwrite" },
      ]),
    );
  }
  assert.throws(() =>
    serializeStructuredKnowledge({}, [
      { id: "one", key: "same", value: "1" },
      { id: "two", key: "same", value: "2" },
    ]),
  );
  const rows = createStructuredKnowledgeRows(saved);
  assert.deepEqual(serializeStructuredKnowledge(saved, rows), saved);
});
