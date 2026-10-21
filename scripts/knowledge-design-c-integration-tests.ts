import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgeLifecyclePanel } from "../src/components/knowledge-lifecycle-panel";
import { KnowledgeMaintenancePanel } from "../src/components/knowledge-maintenance-panel";
import { getKnowledgeMaintenanceCopy } from "../src/lib/knowledge-center/maintenance-copy";
import type { KnowledgeCenterSnapshot, KnowledgeSource } from "../src/lib/knowledge-center/types";

const source: KnowledgeSource = {
  id: "source", areaId: "area", projectId: null, name: "Hours", type: "manual",
  status: "draft", revision: 2, approvedVersionId: null, draftVersionId: "version", archivedAt: null,
  version: {
    id: "version", sourceId: "source", version: 2, name: "Hours", content: "Monday <script>unsafe()</script>",
    structuredData: {}, url: null, mediaAssetId: null, status: "draft", createdAt: "2026-10-19T12:00:00Z",
    approvedAt: null, processingStatus: "manual", processingMessage: null, processingFormat: null,
  },
};
const snapshot: KnowledgeCenterSnapshot = {
  workspace: { id: "workspace", name: "Company" }, available: true,
  areas: [{ id: "area", name: "Company facts", kind: "company", projectId: null, description: "", archivedAt: null }],
  sources: [source], projects: [], bots: [], assignments: [],
  entitlement: {
    enabled: true, maxSources: 20, maxStorageBytes: 100_000, maxQueriesPerMonth: 1000, contractReference: null,
    features: { websiteImport: true, monitoring: true, advancedMaintenance: true },
    limits: { maxAreas: 20, maxWebsites: 5, maxScansPerMonth: 100, maxUsers: 5, maxAssistants: 5 },
  },
  usage: { sources: 1, storageBytes: 0, queriesThisMonth: 0 },
  permissions: { canWrite: true, canPublish: true, canAssign: true },
};
const scopedPath = (path: string) => path;
const onChanged = async () => {};

test("maintenance filter names exclude their option values and point to unique controls in every CRM language", () => {
  for (const language of ["de", "en"] as const) {
    const html = renderToStaticMarkup(createElement(KnowledgeMaintenancePanel, { snapshot, language, scopedPath, onChanged }));
    const text = getKnowledgeMaintenanceCopy(language);
    const labels = [...html.matchAll(/<label[^>]*for="([^"]+)"[^>]*>([^<]*)<\/label>/g)];
    for (const label of [text.area, text.status]) {
      const match = labels.find((item) => item[2] === label);
      assert.ok(match, `${language}: ${label} has a standalone label`);
      assert.ok([...html.matchAll(/<select\b[^>]*>/g)].some((select) => select[0].includes(`id="${match[1]}"`)));
    }
    assert.equal(new Set(labels.map((item) => item[1])).size, labels.length);
    assert.doesNotMatch(html, /<label[^>]*>(?:(?!<\/label>)[\s\S])*<select/);
    assert.match(html, /role="tablist"/);
    assert.match(html, /role="tabpanel"/);
  }
});

test("source review renders saved content safely and waits for workflow data before offering transitions", () => {
  const html = renderToStaticMarkup(createElement(KnowledgeLifecyclePanel, { source, snapshot, language: "en", scopedPath, onChanged, showHistory: true }));
  assert.match(html, /Monday &lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.match(html, /role="status"/);
  assert.match(html, /<details open=""/);
  assert.doesNotMatch(html, /data-testid="knowledge-(submit|review|approve|publish|revoke|restore)"/);
  assert.doesNotMatch(html, /<script>/);
});
