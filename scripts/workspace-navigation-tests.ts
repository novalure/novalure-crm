import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Children, createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceNavigation } from "../src/components/workspace-navigation";
import { WorkspaceSectionTabs } from "../src/components/workspace-section-tabs";
import {
  getWorkspaceNavigationGroupId,
  getWorkspaceNavigationGroups,
  getWorkspaceNavigationTarget,
} from "../src/lib/workspace-navigation";

const source = readFileSync(new URL("../src/components/crm-workspace.tsx", import.meta.url), "utf8");
const entryUnion = source.match(/type NavigationEntryId\s*=([\s\S]*?);/)?.[1];
assert.ok(entryUnion, "the workspace still defines its available navigation entries");
const allEntryIds = [...entryUnion.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const items = allEntryIds.map((id) => Object.freeze({ id, label: `Authorized ${id}`, extra: id }));

test("all workspace entries remain reachable once with no new permissions or lost labels", () => {
  const original = Object.freeze(items.slice());
  const groups = getWorkspaceNavigationGroups(original, "de");
  const regrouped = groups.flatMap((group) => group.items);
  assert.equal(regrouped.length, original.length);
  assert.deepEqual(regrouped.map((item) => item.id).sort(), allEntryIds.slice().sort());
  assert.equal(new Set(regrouped.map((item) => item.id)).size, original.length);
  for (const item of regrouped) assert.equal(item, original.find((entry) => entry.id === item.id));
  assert.equal(groups.filter((group) => !group.isUtility).length, 8);
  assert.equal(groups.filter((group) => group.isUtility).length, 1);
});

test("every actual navigation preset partitions within eight primary areas", () => {
  const presetEntries = [...source.matchAll(/navigationEntries:\s*\[([^\]]*)\]/g)];
  assert.ok(presetEntries.length >= 10);
  for (const match of presetEntries) {
    const ids = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
    const authorized = ids.map((id) => ({ id, label: id }));
    const groups = getWorkspaceNavigationGroups(authorized, "de");
    assert.deepEqual(groups.flatMap((group) => group.items.map((item) => item.id)).sort(), ids.slice().sort());
    assert.ok(groups.filter((group) => !group.isUtility).length <= 8);
  }
});

test("restricted views gain no entries and contacts plus enquiries stay in primary areas", () => {
  const authorized = [
    { id: "studioWebsiteEnquiries", label: "Website-Anfragen" },
    { id: "contacts", label: "Kontakte" },
  ];
  const groups = getWorkspaceNavigationGroups(authorized, "de");
  assert.deepEqual(groups.map((group) => group.id), ["contacts", "sales"]);
  assert.ok(groups.every((group) => !group.isUtility));
  assert.deepEqual(groups.flatMap((group) => group.items.map((item) => item.id)).sort(), ["contacts", "studioWebsiteEnquiries"]);
  assert.deepEqual(getWorkspaceNavigationGroups([], "de"), []);
});

test("future authorized modules fall back to reachable management without exposing others", () => {
  const authorized = [{ id: "futureAuthorizedTool", label: "My new tool" }];
  const groups = getWorkspaceNavigationGroups(authorized, "en");
  assert.equal(getWorkspaceNavigationGroupId(authorized[0].id), "management");
  assert.deepEqual(groups, [{ id: "management", label: "Management", items: authorized, isUtility: true }]);
});

test("area selection preserves the current original entry or chooses an authorized entry in preset order", () => {
  const groups = getWorkspaceNavigationGroups([
    { id: "newsletter", label: "Newsletter" },
    { id: "forms", label: "Forms" },
  ], "en");
  assert.equal(getWorkspaceNavigationTarget(groups[0], "forms")?.id, "forms");
  assert.equal(getWorkspaceNavigationTarget(groups[0], "contacts")?.id, "newsletter");
});

test("primary labels stay stable in DE, EN and ES even when only one module is authorized", () => {
  const authorized = [{ id: "pipelines", label: "Original pipeline label" }];
  for (const [language, label] of [["de", "Vertrieb"], ["en", "Sales"], ["es", "Ventas"], ["constructor", "Sales"]]) {
    const groups = getWorkspaceNavigationGroups(authorized, language);
    assert.equal(groups[0].label, label);
    assert.equal(groups[0].items[0].label, "Original pipeline label");
  }
});

test("sidebar marks the active area and keeps management out of primary navigation", () => {
  const props = {
    items, activeId: "forms", collapsed: false, language: "de",
    onNavigate: () => undefined,
    renderIcon: () => null,
  };
  const primary = renderToStaticMarkup(createElement(WorkspaceNavigation, { ...props, area: "primary" }));
  const utility = renderToStaticMarkup(createElement(WorkspaceNavigation, { ...props, area: "utility" }));
  assert.equal((primary.match(/data-crm-nav-group=/g) ?? []).length, 8);
  assert.doesNotMatch(primary, /data-crm-nav-group="management"/);
  assert.match(primary, /aria-current="page"[^>]*data-crm-nav-group="marketing"[^>]*data-crm-nav-target="forms"/);
  assert.equal((utility.match(/data-crm-nav-group=/g) ?? []).length, 1);
  assert.match(utility, /data-crm-nav-group="management"/);
  assert.doesNotMatch(primary + utility, /<details|Weitere Bereiche/);
});

test("content navigation preserves every authorized subpage label and original navigation ID", () => {
  const html = renderToStaticMarkup(createElement(WorkspaceSectionTabs, {
    items, activeId: "newsletter", language: "de", onNavigate: () => undefined,
  }));
  for (const id of ["marketing", "funnels", "forms", "newsletter", "sequences"]) {
    assert.match(html, new RegExp(`data-crm-section-entry="${id}"`));
    assert.match(html, new RegExp(`Authorized ${id}`));
  }
  assert.match(html, /aria-current="page"[^>]*data-crm-section-entry="newsletter"/);
  assert.doesNotMatch(html, /Authorized contacts|Authorized billing|Authorized leadInbox/);
  const hidden = renderToStaticMarkup(createElement(WorkspaceSectionTabs, {
    items: [{ id: "contacts", label: "Contacts" }], activeId: "contacts", language: "en", onNavigate: () => undefined,
  }));
  assert.equal(hidden, "");
});

test("clicking the active area or tab preserves dynamic page context while other entries navigate by original ID", () => {
  const authorized = [
    { id: "contacts", label: "Contacts" },
    { id: "marketing", label: "Marketing" },
    { id: "forms", label: "Dynamically opened form" },
  ];
  const navigations: string[] = [];
  let activeSelections = 0;
  const onNavigate = (id: string) => { navigations.push(id); };
  const sidebar = WorkspaceNavigation({
    items: authorized, activeId: "forms", collapsed: false, language: "en", onNavigate, renderIcon: () => null,
    onActiveNavigate: () => { activeSelections += 1; },
  });
  type ButtonProps = { onClick: () => void; "data-crm-nav-group"?: string; "data-crm-section-entry"?: string };
  const sidebarButtons = Children.toArray(sidebar.props.children)
    .filter((child): child is ReactElement<ButtonProps> => isValidElement<ButtonProps>(child));
  const activeArea = sidebarButtons.find((button) => button.props["data-crm-nav-group"] === "marketing");
  assert.ok(activeArea);
  activeArea.props.onClick();
  assert.deepEqual(navigations, []);
  assert.equal(activeSelections, 1, "the mobile drawer may close without resetting the active page context");

  const tabs = WorkspaceSectionTabs({ items: authorized, activeId: "forms", language: "en", onNavigate });
  assert.ok(tabs);
  const tabButtons = Children.toArray(tabs.props.children)
    .filter((child): child is ReactElement<ButtonProps> => isValidElement<ButtonProps>(child));
  const activeTab = tabButtons.find((button) => button.props["data-crm-section-entry"] === "forms");
  assert.ok(activeTab);
  activeTab.props.onClick();
  assert.deepEqual(navigations, []);

  const marketingTab = tabButtons.find((button) => button.props["data-crm-section-entry"] === "marketing");
  assert.ok(marketingTab);
  marketingTab.props.onClick();
  const contactsArea = sidebarButtons.find((button) => button.props["data-crm-nav-group"] === "contacts");
  assert.ok(contactsArea);
  contactsArea.props.onClick();
  assert.deepEqual(navigations, ["marketing", "contacts"]);
  assert.equal(activeSelections, 1, "other areas invoke only their normal navigation callback");
});
