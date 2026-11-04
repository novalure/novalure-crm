import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect as playwrightExpect } from "@playwright/test";

// Requires an owned, disposable loopback server with real password and MFA.
// The browser never reaches an external host or submits a business mutation.
const fixture = JSON.parse(await readFile(".npm-cache/qa/sales-browser-context.json", "utf8"));
const base = new URL(fixture.baseUrl);
assert.equal(base.hostname, "127.0.0.1");
assert.equal(fixture.syntheticOnly, true);
assert.equal(fixture.database?.host, "127.0.0.1");
assert.match(fixture.database?.user ?? "", /^sales_qa_[a-f0-9]+$/);
const output = path.resolve(".npm-cache/qa/compact-navigation");
await mkdir(output, { recursive: true });
const expect = playwrightExpect.configure({ timeout: 20000 });
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "de-AT", timezoneId: "Europe/Vienna" });
const results = [], browserErrors = [], serverErrors = [], externalRequests = [];
await context.route("**/*", route => {
  const url = new URL(route.request().url());
  if (["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
  externalRequests.push({ hostname: url.hostname, pathname: url.pathname });
  return route.abort();
});
await context.addInitScript(() => localStorage.setItem("novalure-crm-navigation-preset-v1", "realEstateBroker"));
const page = await context.newPage();
page.on("pageerror", error => browserErrors.push(error.message));
page.on("response", response => {
  const url = new URL(response.url());
  if (url.origin === base.origin && response.status() >= 500) serverErrors.push({ pathname: url.pathname, status: response.status() });
});

function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes = [];
  for (const character of secret) {
    const digit = alphabet.indexOf(character);
    assert.ok(digit >= 0);
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); value &= (1 << bits) - 1; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  return String((digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) % 1000000).padStart(6, "0");
}
async function step(name, fn) {
  try { const evidence = await fn(); results.push({ name, status: "PASS", ...(evidence ? { evidence } : {}) }); console.log("PASS " + name); }
  catch (error) { results.push({ name, status: "FAIL", error: error.message }); await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {}); throw error; }
}
async function revealControl(control) {
  if (await control.isVisible()) return;
  const details = control.locator("xpath=ancestor::details[1]");
  if (await details.count()) await details.locator("summary").first().click();
  await expect(control).toBeVisible();
}
async function chooseProfile(id) {
  const control = page.locator("[data-crm-profile-select]").first();
  await revealControl(control);
  await control.selectOption(id);
  await expect(control).toHaveValue(id);
  const details = control.locator("xpath=ancestor::details[1]");
  if (await details.count() && await details.getAttribute("open") !== null) await details.locator("summary").first().click();
}
async function expandSidebar() {
  const sidebar = page.locator("[data-crm-sidebar]");
  if (await sidebar.getAttribute("data-collapsed") === "true") await sidebar.locator("[data-crm-collapse]").click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
}
async function assertSidebarFits() {
  const evidence = await page.locator("[data-crm-sidebar]").evaluate(element => {
    const box = element.getBoundingClientRect();
    const navigation = element.querySelector("[data-crm-primary-nav]");
    const visibleButtons = [...element.querySelectorAll("button,summary")].filter(button => button.getBoundingClientRect().height > 0);
    return { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, top: box.top, bottom: box.bottom, viewportHeight: innerHeight,
      clippedButtons: visibleButtons.filter(button => { const rect = button.getBoundingClientRect(); return rect.top < box.top - 1 || rect.bottom > box.bottom + 1; }).map(button => button.getAttribute("aria-label") || button.textContent?.trim()),
      viewportWidth: innerWidth, primaryGroups: element.querySelectorAll('[data-crm-nav-group]:not([data-crm-nav-group="management"])').length,
      navigationHeight: navigation?.clientHeight, navigationScrollHeight: navigation?.scrollHeight };
  });
  assert.ok(evidence.scrollHeight <= evidence.clientHeight + 1, JSON.stringify(evidence));
  assert.ok(evidence.navigationScrollHeight <= evidence.navigationHeight + 1, "Primary navigation still needs scrolling: " + JSON.stringify(evidence));
  assert.ok(evidence.top >= -1 && evidence.bottom <= evidence.viewportHeight + 1, JSON.stringify(evidence));
  assert.deepEqual(evidence.clippedButtons, []);
  assert.ok(evidence.primaryGroups <= 8);
  return evidence;
}
async function assertNoHorizontalOverflow() {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), "Document overflows horizontally");
}
async function activeEntry() { return page.locator("[data-crm-section-entry][data-active='true']").getAttribute("data-crm-section-entry"); }

try {
  await step("real synthetic password and TOTP login reaches protected CRM", async () => {
    await page.goto(base.origin + "/login?lang=de", { waitUntil: "domcontentloaded" });
    const consent = page.getByRole("button", { name: /^(Nur essenzielle|Only necessary)$/ });
    if (await consent.isVisible()) await consent.click();
    await page.locator("#login-email").fill(fixture.email);
    await page.locator("#login-password").fill(fixture.password);
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator("form:has(#login-password) button[type=submit]").click()]);
    await expect(page.locator("#login-mfa-code")).toBeVisible();
    let secret = fixture.mfaTotpSecret ?? fixture.totpSecret;
    if (!secret) {
      secret = (await page.locator("p").filter({ has: page.locator("strong", { hasText: /TOTP-Schlüssel:|TOTP key:/ }) }).locator("code").innerText()).trim();
      await page.locator('input[name="recoveryCodesSaved"]').check();
    }
    await page.locator("#login-mfa-code").fill(totp(secret));
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.getByRole("button", { name: /^(Sicher bestätigen|Verify securely)$/ }).click()]);
    await expect(page.locator("[data-crm-sidebar]")).toBeVisible();
    assert.equal((await page.request.get(base.origin + "/api/crm/core")).status(), 200);
    const cookie = (await context.cookies()).find(item => item.name === "novalure_session");
    assert.ok(cookie?.httpOnly && cookie.value.startsWith("v2."));
    await expandSidebar();
  });

  await step("all primary groups and their authorized subsection buttons remain reachable", async () => {
    const visited = [];
    for (const preset of ["realEstateBroker", "novalureInternal", "novalureAdmin"]) {
      await chooseProfile(preset);
      await expandSidebar();
      const groups = await page.locator("[data-crm-sidebar] [data-crm-nav-group]").evaluateAll(elements => elements.map(element => element.getAttribute("data-crm-nav-group")));
      assert.equal(new Set(groups).size, groups.length);
      for (const group of groups) {
        await page.locator(`[data-crm-sidebar] [data-crm-nav-group="${group}"]`).click();
        await expect(page.locator(`[data-crm-sidebar] [data-crm-nav-group="${group}"]`)).toHaveAttribute("data-active", "true");
        await expect(page.locator("[data-crm-header-title]")).not.toHaveText("");
        const entries = await page.locator("[data-crm-section-entry]").evaluateAll(elements => elements.map(element => element.getAttribute("data-crm-section-entry")));
        for (const entry of entries) {
          const button = page.locator(`[data-crm-section-entry="${entry}"]`);
          await button.click();
          await expect(button).toHaveAttribute("data-active", "true");
          await expect(page.locator(`[data-crm-sidebar] [data-crm-nav-group="${group}"]`)).toHaveAttribute("data-active", "true");
          await expect(page.locator("[data-crm-header-title]")).not.toHaveText("");
          visited.push({ preset, group, entry, hash: new URL(page.url()).hash });
        }
        if (!entries.length) visited.push({ preset, group, hash: new URL(page.url()).hash });
      }
    }
    return visited;
  });

  await step("original deep links, browser back/forward and reload retain selected subsection", async () => {
    await chooseProfile("realEstateBroker");
    await page.locator('[data-crm-sidebar] [data-crm-nav-group="marketing"]').click();
    const entries = await page.locator("[data-crm-section-entry]").evaluateAll(elements => elements.map(element => element.getAttribute("data-crm-section-entry")));
    assert.ok(entries.length >= 2);
    await page.locator(`[data-crm-section-entry="${entries[0]}"]`).click();
    const firstUrl = page.url();
    await page.locator(`[data-crm-section-entry="${entries[1]}"]`).click();
    const secondUrl = page.url();
    assert.notEqual(firstUrl, secondUrl);
    await page.goBack();
    await expect(page).toHaveURL(firstUrl);
    await expect.poll(activeEntry).toBe(entries[0]);
    await page.goForward();
    await expect(page).toHaveURL(secondUrl);
    await expect.poll(activeEntry).toBe(entries[1]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(activeEntry).toBe(entries[1]);
    return { firstHash: new URL(firstUrl).hash, secondHash: new URL(secondUrl).hash };
  });

  await step("compact scope selector keeps original project URL and selected scope", async () => {
    const control = page.locator("[data-crm-project-select]").first();
    await revealControl(control);
    await control.selectOption(fixture.projectId);
    await expect.poll(() => new URL(page.url()).searchParams.get("projectId")).toBe(fixture.projectId);
    await expect(control).toHaveValue(fixture.projectId);
    await control.selectOption("all");
    await expect(control).toHaveValue("all");
    const details = control.locator("xpath=ancestor::details[1]");
    if (await details.count() && await details.getAttribute("open") !== null) await details.locator("summary").first().click();
  });

  await step("expanded and collapsed sidebar fit ordinary laptop screens", async () => {
    const sizes = [];
    await chooseProfile("realEstateBroker");
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1200, height: 720 }]) {
      await page.setViewportSize(viewport);
      await expandSidebar();
      sizes.push({ ...await assertSidebarFits(), collapsed: false });
      await page.screenshot({ path: path.join(output, `desktop-${viewport.width}x${viewport.height}.png`), fullPage: false });
      await page.locator("[data-crm-sidebar] [data-crm-collapse]").click();
      await expect(page.locator("[data-crm-sidebar]")).toHaveAttribute("data-collapsed", "true");
      sizes.push({ ...await assertSidebarFits(), collapsed: true });
    }
    return sizes;
  });

  await step("keyboard activation and focus remain available for primary navigation", async () => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await expandSidebar();
    const button = page.locator('[data-crm-sidebar] [data-crm-nav-group="contacts"]');
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("data-active", "true");
    const focus = await button.evaluate(element => { const style = getComputedStyle(element); return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor }; });
    assert.notEqual(focus.outlineStyle, "none");
    return focus;
  });

  await step("mobile drawer retains every destination, closes on navigation and restores focus", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalOverflow();
    const trigger = page.locator("[data-crm-mobile-trigger]");
    await trigger.click();
    await expect(page.locator("[data-crm-mobile-drawer]")).toBeVisible();
    const desktopGroups = await page.locator("[data-crm-sidebar] [data-crm-nav-group]").evaluateAll(elements => elements.map(element => element.getAttribute("data-crm-nav-group")).sort());
    const mobileGroups = await page.locator("[data-crm-mobile-drawer] [data-crm-nav-group]").evaluateAll(elements => elements.map(element => element.getAttribute("data-crm-nav-group")).sort());
    assert.deepEqual(mobileGroups, desktopGroups, "Mobile must retain every authorized area");
    await expect(page.locator("[data-crm-mobile-drawer]")).toHaveAttribute("aria-modal", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-crm-mobile-drawer]")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    for (const group of mobileGroups) {
      await trigger.click();
      await page.locator(`[data-crm-mobile-drawer] [data-crm-nav-group="${group}"]`).click();
      await expect(page.locator("[data-crm-mobile-drawer]")).toHaveCount(0);
      const entries = await page.locator("[data-crm-section-entry]").evaluateAll(elements => elements.map(element => element.getAttribute("data-crm-section-entry")));
      if (entries.length) {
        const lastEntry = page.locator(`[data-crm-section-entry="${entries.at(-1)}"]`);
        await lastEntry.click();
        await expect(lastEntry).toHaveAttribute("data-active", "true");
      }
      await assertNoHorizontalOverflow();
    }
    await assertNoHorizontalOverflow();
    await page.screenshot({ path: path.join(output, "mobile-390x844.png"), fullPage: false });
  });

  await step("authenticated brand palette is applied to rail and primary controls", async () => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const colors = await page.locator(".crm-app").evaluate(element => {
      const style = getComputedStyle(element);
      const rail = getComputedStyle(element.querySelector("[data-crm-sidebar]"));
      const selected = getComputedStyle(element.querySelector('[data-crm-sidebar] [data-active="true"]'));
      return { rail: rail.backgroundColor, selected: selected.backgroundColor, selectedText: selected.color,
        accent: style.getPropertyValue("--dc-accent").trim(), railToken: style.getPropertyValue("--dc-rail").trim(), link: style.getPropertyValue("--dc-link").trim() };
    });
    assert.notEqual(colors.rail, "rgba(0, 0, 0, 0)");
    assert.notEqual(colors.selected, "rgba(0, 0, 0, 0)");
    assert.notEqual(colors.selected, colors.rail);
    return colors;
  });

  assert.deepEqual(browserErrors, [], "Navigation produced browser runtime errors");
  console.log("PASS no browser runtime errors");
} finally {
  await writeFile(path.join(output, "results.json"), JSON.stringify({ syntheticOnly: true, realAuthentication: true, productionWrites: 0, results, browserErrors, serverErrors, externalRequests }, null, 2));
  await context.close();
  await browser.close();
}
