#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./justimmo-local-a11y.mjs", import.meta.url), "utf8");

test("local Justimmo Axe harness refuses external targets and unsafe browser requests", () => {
  assert.match(source, /target\.hostname === "127\.0\.0\.1" \|\| target\.hostname === "localhost"/);
  assert.match(source, /Local Axe verification refuses every non-localhost target/);
  assert.match(source, /url\.origin !== base\.origin/);
  assert.match(source, /category: "cross_origin"/);
  assert.match(source, /category: "unexpected_write"/);
  assert.match(source, /allowedLocalAuthWrites = new Set\(\["\/api\/auth\/session"\]\)/);
  assert.match(source, /unexpected HTTP write during local Axe verification/);
});

test("local Justimmo Axe harness proves demo auth and injects only read-only UI fixtures", () => {
  assert.match(source, /session\.authenticated, true/);
  assert.match(source, /session\.demoAuth, true/);
  assert.match(source, /session\.source, "demo"/);
  assert.match(source, /fixtureTransport: "browser_intercepted_read_only_get"/);
  assert.match(source, /method === "GET" && url\.pathname === "\/api\/crm\/properties"/);
  assert.match(source, /\/api\\\/crm\\\/broker/);
  assert.doesNotMatch(source, /route\.fulfill\([\s\S]*?method:\s*"POST"/);
});

test("local Justimmo Axe harness covers the mobile cards and all five broker editor groups", () => {
  assert.match(source, /\[data-property-mobile-list\] article/);
  assert.match(source, /\[data-property-desktop-table\]/);
  assert.match(source, /auditRegion\(page, "\[data-property-mobile-list\]", "property-mobile-cards"\)/);
  assert.match(source, /navigationPresetStorageKey = "novalure-crm-navigation-preset-v1"/);
  assert.match(source, /presetId: "realEstateBroker"/);
  for (const label of [
    "Suchprofil",
    "Angebotsentwurf",
    "Besichtigung",
    "Aktivität und Nachfassaufgabe",
    "Abschluss, Geldbeträge und Provision",
  ]) assert.match(source, new RegExp(label));
  assert.match(source, /fieldset > legend/);
  assert.match(source, /window\.axe\.run/);
  assert.match(source, /"wcag22aa"/);
  assert.match(source, /results\.length === 6/);
});
