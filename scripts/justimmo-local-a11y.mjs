#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createA11yBrowserContextOptions } from "./lib/a11y-browser-context.mjs";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const allowedLocalAuthWrites = new Set(["/api/auth/session"]);
const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const fixtureWorkspaceId = "ws_novalure";
const fixtureProjectId = "project_wohnpark_graz";
const navigationPresetStorageKey = "novalure-crm-navigation-preset-v1";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--base-url", "--browser-executable"].includes(name) || !value || value.startsWith("--")) {
      throw new Error("Only --base-url and optional --browser-executable are supported.");
    }
    if (args.has(name)) throw new Error(`Duplicate argument: ${name}`);
    args.set(name, value);
  }
  return args;
}

function requireLocalTarget(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error("--base-url must be a valid localhost URL.");
  }
  assert.ok(
    target.hostname === "127.0.0.1" || target.hostname === "localhost",
    "Local Axe verification refuses every non-localhost target.",
  );
  assert.ok(target.protocol === "http:" || target.protocol === "https:", "Local target must use HTTP or HTTPS.");
  assert.equal(target.username, "", "Local target must not contain credentials.");
  assert.equal(target.password, "", "Local target must not contain credentials.");
  assert.equal(target.search, "", "Local target must not contain query parameters.");
  assert.equal(target.hash, "", "Local target must not contain a fragment.");
  assert.equal(target.pathname, "/", "Local target must use the application root.");
  return target;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    const modulePath = process.env.NOVALURE_PLAYWRIGHT_MODULE_PATH?.trim();
    if (!modulePath) {
      throw new Error("Playwright is unavailable. Set NOVALURE_PLAYWRIGHT_MODULE_PATH to the bundled runtime.", { cause: error });
    }
    return import(pathToFileURL(path.resolve(modulePath)).href);
  }
}

function propertyFixtureResponse() {
  return {
    data: {
      assets: [{
        activeReservations: 0,
        address: "Musterstraße 1, 8010 Graz",
        areaSqm: 82,
        approvedDocumentCount: 1,
        availableUnits: 2,
        buildingCount: 1,
        costItemCount: 1,
        coverImageCount: 1,
        documentCount: 1,
        energyDocumentCount: 0,
        floorplanDocumentCount: 1,
        id: "listing:local-a11y-property",
        imageCount: 3,
        kind: "property",
        location: "8010 Graz",
        objectType: "Wohnung",
        price: 425000,
        priceVisibility: "publish_price",
        projectId: fixtureProjectId,
        projectName: "Wohnpark Graz",
        publicDocumentCount: 1,
        publicImageCount: 2,
        reservedUnits: 1,
        sellerListingId: "local-a11y-property",
        soldUnits: 0,
        status: "published",
        textBlockCount: 2,
        title: "Lokales Axe-Testobjekt",
        unitCount: 3,
        unitIds: [],
        workspaceId: fixtureWorkspaceId,
      }],
    },
    pagination: { hasMore: false, limit: 25, nextOffset: null, offset: 0, total: 1 },
    persisted: false,
    source: "local_a11y_fixture",
  };
}

async function installLocalReadOnlyFixtureGuard(context, base, blockedRequests) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    let url;
    try {
      url = new URL(request.url());
    } catch {
      blockedRequests.push({ category: "invalid_url", method });
      await route.abort("blockedbyclient");
      return;
    }

    if (url.origin !== base.origin) {
      blockedRequests.push({ category: "cross_origin", method });
      await route.abort("blockedbyclient");
      return;
    }
    if (!safeMethods.has(method) && !(method === "POST" && allowedLocalAuthWrites.has(url.pathname))) {
      blockedRequests.push({ category: "unexpected_write", method });
      await route.abort("blockedbyclient");
      return;
    }
    if (method === "GET" && url.pathname === "/api/crm/properties") {
      assert.equal(url.searchParams.get("workspaceId"), fixtureWorkspaceId);
      assert.equal(url.searchParams.get("projectId"), fixtureProjectId);
      await route.fulfill({
        body: JSON.stringify(propertyFixtureResponse()),
        contentType: "application/json; charset=utf-8",
        status: 200,
      });
      return;
    }
    if (method === "GET" && /^\/api\/crm\/broker\/(?:operations|offers|viewings|activities|closings)$/u.test(url.pathname)) {
      await route.fulfill({
        body: JSON.stringify({
          data: [],
          financialsVisible: url.pathname.endsWith("/closings"),
          pagination: { hasMore: false, limit: 50, offset: 0, total: 0 },
          persisted: false,
        }),
        contentType: "application/json; charset=utf-8",
        status: 200,
      });
      return;
    }
    await route.continue();
  });
}

async function injectAxe(page, axeSource) {
  await page.addScriptTag({ content: axeSource });
  assert.equal(await page.evaluate(() => typeof window.axe?.run), "function", "axe-core was not injected.");
}

async function auditRegion(page, selector, id) {
  const audit = await page.evaluate(async ({ regionSelector, tags }) => {
    const region = document.querySelector(regionSelector);
    if (!region) throw new Error(`Axe region not found: ${regionSelector}`);
    const result = await window.axe.run(region, { runOnly: { type: "tag", values: tags } });
    return {
      incomplete: result.incomplete.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.length })),
      passes: result.passes.length,
      violations: result.violations.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.length })),
    };
  }, { regionSelector: selector, tags: wcagTags });
  const blocking = [...audit.violations, ...audit.incomplete]
    .filter((item) => item.impact === "serious" || item.impact === "critical");
  assert.deepEqual(blocking, [], `${id} has unresolved serious or critical Axe findings.`);
  return { ...audit, id, passed: true };
}

function appUrl(base, hash) {
  const url = new URL("/", base);
  url.searchParams.set("lang", "de");
  url.searchParams.set("workspaceId", fixtureWorkspaceId);
  url.searchParams.set("projectId", fixtureProjectId);
  url.hash = hash;
  return url;
}

const args = parseArgs(process.argv.slice(2));
const base = requireLocalTarget(args.get("--base-url") ?? "");
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  executablePath: args.get("--browser-executable") || process.env.NOVALURE_BROWSER_EXECUTABLE || undefined,
  headless: true,
});
const axeSource = await readFile(path.resolve("node_modules", "axe-core", "axe.min.js"), "utf8");
const blockedRequests = [];
const results = [];

try {
  const mobileContext = await browser.newContext(createA11yBrowserContextOptions({
    height: 844,
    isMobile: true,
    width: 390,
  }));
  await installLocalReadOnlyFixtureGuard(mobileContext, base, blockedRequests);
  try {
    const page = await mobileContext.newPage();
    await page.goto(appUrl(base, "properties").href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator("[data-property-mobile-list] article").first().waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.locator("[data-property-desktop-table]").evaluate((element) => getComputedStyle(element).display), "none");
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      return response.json();
    });
    assert.equal(session.authenticated, true, "Local browser is not authenticated.");
    assert.equal(session.demoAuth, true, "Local browser did not use demo auth.");
    assert.equal(session.source, "demo", "Local browser did not resolve a demo session.");
    await injectAxe(page, axeSource);
    results.push(await auditRegion(page, "[data-property-mobile-list]", "property-mobile-cards"));
  } finally {
    await mobileContext.close();
  }

  const desktopContext = await browser.newContext(createA11yBrowserContextOptions({ height: 900, width: 1440 }));
  await desktopContext.addInitScript(({ key, presetId }) => {
    window.localStorage.setItem(key, presetId);
  }, { key: navigationPresetStorageKey, presetId: "realEstateBroker" });
  await installLocalReadOnlyFixtureGuard(desktopContext, base, blockedRequests);
  try {
    const page = await desktopContext.newPage();
    await page.goto(appUrl(base, "objects-mandates").href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator("#broker-operations-title").waitFor({ state: "visible", timeout: 30_000 });
    await injectAxe(page, axeSource);
    const workflows = [
      { legend: "Suchprofil", tab: "Suchprofile" },
      { legend: "Angebotsentwurf", tab: "Angebote" },
      { legend: "Besichtigung", tab: "Besichtigungen" },
      { legend: "Aktivität und Nachfassaufgabe", tab: "Aktivitäten" },
      { legend: "Abschluss, Geldbeträge und Provision", tab: "Abschlüsse" },
    ];
    for (const workflow of workflows) {
      await page.getByRole("tab", { exact: true, name: workflow.tab }).click();
      await page.getByRole("button", { exact: true, name: "Neu anlegen" }).click();
      const form = page.getByRole("form", { name: "Neuen Datensatz anlegen" });
      await form.waitFor({ state: "visible" });
      assert.equal(await form.locator("fieldset > legend").first().textContent(), workflow.legend);
      results.push(await auditRegion(page, 'form[aria-label="Neuen Datensatz anlegen"]', `broker-${workflow.tab}`));
      await page.getByRole("button", { exact: true, name: "Abbrechen" }).click();
    }
  } finally {
    await desktopContext.close();
  }
} finally {
  await browser.close();
}

assert.equal(
  blockedRequests.filter((request) => request.category === "unexpected_write").length,
  0,
  "The UI attempted an unexpected HTTP write during local Axe verification.",
);

console.log(JSON.stringify({
  audits: results,
  blockedCrossOriginRequests: blockedRequests.filter((request) => request.category === "cross_origin").length,
  demoAuth: true,
  fixtureTransport: "browser_intercepted_read_only_get",
  localhostOnly: true,
  mode: "LOCAL_DEMO_DIAGNOSTIC",
  passed: results.length === 6 && results.every((result) => result.passed),
  unexpectedWriteAttempts: 0,
}, null, 2));
