#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const consent = await readFile(
  new URL("../src/components/cookie-consent-button.tsx", import.meta.url),
  "utf8",
);

test("consent records persist explicit categories and support withdrawal", () => {
  assert.match(consent, /type CookieConsentChoice = "necessary" \| "all" \| "custom"/);
  assert.match(consent, /analytics: isAll \|\| \(isCustom && parsed\.analytics === true\)/);
  assert.match(consent, /marketing: isAll \|\| \(isCustom && parsed\.marketing === true\)/);
  assert.match(consent, /localStorage\.setItem\(storageKey, JSON\.stringify\(record\)\)/);
  assert.match(consent, /document\.cookie = `\$\{cookieName\}=/);
  assert.match(consent, /onClick=\{\(\) => choose\("necessary"\)\}/);
  assert.match(consent, /onClick=\{\(\) => choose\("custom"\)\}/);
  assert.match(consent, /onClick=\{\(\) => choose\("all"\)\}/);
});

test("consent dialog has deterministic keyboard focus and localized announcements", () => {
  assert.match(consent, /aria-describedby=\{descriptionId\}/);
  assert.match(consent, /aria-labelledby=\{titleId\}/);
  assert.match(consent, /role="dialog"/);
  assert.match(consent, /dialogRef\.current\?\.focus\(\)/);
  assert.match(consent, /previousFocus\?\.isConnected/);
  assert.match(consent, /previousFocusRef\.current = event\.currentTarget/);
  assert.match(consent, /hidden=\{isOpen\}/);
  assert.match(consent, /onClick=\{openConsentDialog\}/);
  assert.doesNotMatch(consent, /consent && !isOpen/);
  assert.match(consent, /preferencesRef\.current\?\.focus\(\)/);
  assert.match(consent, /event\.key === "Escape" && consent/);
  assert.match(consent, /aria-modal="true"/);
  assert.match(consent, /event\.key !== "Tab"/);
  assert.match(consent, /querySelectorAll<HTMLElement>/);
  assert.match(consent, /activeElement === last/);
  assert.match(consent, /aria-live="polite"[\s\S]*role="status"/);
  assert.match(consent, /min-h-11/);
});

test("consent changes synchronize across the current window and browser tabs", () => {
  assert.match(consent, /addEventListener\("storage", handleStorage\)/);
  assert.match(consent, /addEventListener\("novalure-cookie-consent", handleConsentEvent\)/);
  assert.match(consent, /removeEventListener\("storage", handleStorage\)/);
  assert.match(consent, /removeEventListener\("novalure-cookie-consent", handleConsentEvent\)/);
});
