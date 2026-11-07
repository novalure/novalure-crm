import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceNavigation } from "../src/components/workspace-navigation";
import { WorkspaceSectionTabs } from "../src/components/workspace-section-tabs";

const items = ["aiAssistant", "dashboard", "properties", "units", "knowledge", "bots", "contacts", "tasks", "calendar", "settings"].map(id => ({ id, label: id }));
test("current actual navigation markup binds dashboard, units and bot readiness selectors", () => {
  for (const activeId of ["dashboard", "units", "bots"]) {
    const html = renderToStaticMarkup(createElement(WorkspaceNavigation, { items, activeId, collapsed: false, language: "de", onNavigate() {}, renderIcon: () => null }));
    const active = html.match(/<button[^>]*aria-current="page"[^>]*>/g) ?? [];
    assert.equal(active.length, 1);
    assert.ok(active[0].includes(`data-crm-nav-target="${activeId}"`));
    if (activeId === "dashboard") assert.ok(active[0].includes('data-crm-nav-group="overview"'));
    if (activeId === "bots") {
      const tabs = renderToStaticMarkup(createElement(WorkspaceSectionTabs, { items, activeId: "aiAssistant", language: "de", onNavigate() {} }));
      assert.match(tabs, /data-crm-section-entry="bots"/);
    }
  }
});
test("authenticated brand rail is the explicit blue override used by the browser assertion", async () => {
  const css = await readFile("src/styles/crm-brand.css", "utf8");
  assert.match(css, /\.crm-app\.design-c\s*\{/);
  assert.match(css, /--dc-rail:\s*#1e4fc2\s*;/);
});
