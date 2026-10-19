// Authenticated Design C regression against qa:sales:server -- --built only.
// Accounts and business rows are synthetic. Login, MFA, cookies, CSRF, RLS and
// application APIs are real; no sessions, auth headers or provider IO are faked.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium, expect as baseExpect } from "@playwright/test";
import { createTextPdf } from "./lib/knowledge-document-fixtures.ts";
import { seedDesignCIntegration } from "./lib/design-c-integration-fixture.mjs";

const fixture = JSON.parse(
  await readFile(".npm-cache/qa/sales-browser-context.json", "utf8"),
);
const base = new URL(fixture.baseUrl);
assert(
  fixture.syntheticOnly &&
    base.hostname === "127.0.0.1" &&
    fixture.database?.host === "127.0.0.1" &&
    /^sales_qa_[a-f0-9]+$/.test(fixture.database.user),
  "Requires the disposable loopback sales QA server",
);
const workspaceOnly = process.argv.includes("--workspace-only");
assert(
  process.argv.slice(2).every((arg) => arg === "--workspace-only"),
  "Unknown browser QA argument",
);
const reportFile = workspaceOnly ? "result-workspace.json" : "result.json";
const output = path.resolve(".npm-cache/qa/design-c-integration");
assert.equal(
  fixture.fixtureMode,
  "design-c-actual-predecessors",
  "Start qa:sales:server with --built --design-c to preserve the actual 091–103 predecessor contracts",
);
assert.equal(fixture.database.database, "neondb");
await mkdir(output, { recursive: true });
for (const file of workspaceOnly ? [] : await readdir(output)) {
  if (/^failure-\d+-\d+\.png$/.test(file)) await rm(path.join(output, file));
}
const expect = baseExpect.configure({ timeout: 15000 });
const require = createRequire(import.meta.url);
const admin = new pg.Pool({ ...fixture.database, user: "qa_admin" });
const results = [],
  errors = [],
  serverErrors = [],
  outbound = [],
  consoleErrors = [],
  axeResults = [],
  privateLeaks = [],
  responseInspectionErrors = [],
  responseChecks = [],
  authenticationProofs = [];
const contexts = [];
let browser, accounts, operatorPage, customerPage, viewerPage, areaId, sourceId;

async function step(name, run, fatal = false) {
  try {
    const detail = await run();
    results.push({
      name,
      status: "PASS",
      ...(detail === undefined ? {} : { detail }),
    });
    console.log(`PASS ${name}`);
    return true;
  } catch (error) {
    results.push({ name, status: "FAIL", error: error.message });
    console.error(`FAIL ${name}: ${error.message.split("\n")[0]}`);
    for (const [index, page] of [
      operatorPage,
      customerPage,
      viewerPage,
    ].entries()) {
      if (page && !page.isClosed())
        await page
          .screenshot({
            path: path.join(output, `failure-${results.length}-${index}.png`),
            fullPage: true,
          })
          .catch(() => {});
    }
    if (fatal) throw error;
    return false;
  }
}

function totp(secret, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    bytes = [];
  let accumulator = 0,
    bits = 0;
  for (const character of secret) {
    const value = alphabet.indexOf(character);
    assert(value >= 0, "Invalid enrollment key from login UI");
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const digest = createHmac("sha1", Buffer.from(bytes))
    .update(counter)
    .digest();
  return String(
    (digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1000000,
  ).padStart(6, "0");
}

async function newPage(label) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "de-AT",
    timezoneId: "Europe/Vienna",
  });
  contexts.push(context);
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base.origin || ["blob:", "data:"].includes(url.protocol))
      return route.continue();
    outbound.push({
      role: label,
      method: route.request().method(),
      url: url.href,
    });
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(90000);
  page.on("pageerror", (error) =>
    errors.push({ role: label, message: error.message }),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      consoleErrors.push({ role: label, message: message.text() });
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === base.origin && response.status() >= 500)
      serverErrors.push({
        role: label,
        status: response.status(),
        path: url.pathname,
      });
    if (
      url.origin === base.origin &&
      url.pathname.startsWith("/api/") &&
      response.ok() &&
      (response.headers()["content-type"] || "").includes("application/json")
    ) {
      let timer;
      responseChecks.push(
        Promise.race([
          response.text(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("JSON response inspection timed out")),
              15000,
            );
          }),
        ])
          .then((body) => {
            if (
              /SYNTHETIC FOREIGN PRIVATE SENTINEL|FOREIGN-PRIVATE-UNIT/.test(
                body,
              )
            )
              privateLeaks.push({ role: label, path: url.pathname });
          })
          .catch((error) =>
            responseInspectionErrors.push({
              role: label,
              path: url.pathname,
              error: error.message,
            }),
          )
          .finally(() => clearTimeout(timer)),
      );
    }
  });
  return page;
}

async function api(
  page,
  pathname,
  workspaceId,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  return page.evaluate(
    async ({ pathname, workspaceId, body, method }) => {
      const url = new URL(pathname, location.origin);
      if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
      const headers = {};
      if (method !== "GET") {
        const tokenResponse = await fetch(
          "/api/auth/csrf?" +
            new URLSearchParams({ method, path: url.pathname }),
          { cache: "no-store" },
        );
        const token = await tokenResponse.json();
        headers["content-type"] = "application/json";
        headers["x-novalure-csrf-token"] = token.csrfToken;
      }
      const response = await fetch(url, {
        method,
        headers,
        cache: "no-store",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
    { pathname, workspaceId, body, method },
  );
}

async function login(page, account, negatives = false) {
  await page.goto(new URL("/login?lang=de", base).href);
  const consent = page.getByRole("button", {
    name: "Nur essentielle",
    exact: true,
  });
  if (await consent.isVisible()) await consent.click();
  async function password(value) {
    await page.locator("#login-email").fill(account.email);
    await page.locator("#login-password").fill(value);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.locator("form:has(#login-password) button[type=submit]").click(),
    ]);
  }
  if (negatives) {
    await password(account.password + "-invalid");
    await expect(page.getByRole("alert")).toBeVisible();
    assert.equal((await api(page, "/api/crm/core")).status, 401);
    assert(
      !(await page.context().cookies()).some(
        (cookie) => cookie.name === "novalure_session",
      ),
    );
  }
  await password(account.password);
  const workspaceChoice = account.name
    ? page.getByRole("button", { name: account.name, exact: false })
    : null;
  if (workspaceChoice && (await workspaceChoice.isVisible())) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      workspaceChoice.click(),
    ]);
  }
  const requiresMfa = account.requiresMfa !== false;
  if (requiresMfa) {
    const key = page
      .locator("p")
      .filter({ has: page.locator("strong", { hasText: "TOTP-Schlüssel:" }) })
      .locator("code");
    await expect(key).toBeVisible();
    const secret = (await key.innerText()).trim();
    assert.equal(
      (await api(page, "/api/crm/core")).status,
      401,
      "Password without MFA must remain unauthorized",
    );
    await page.locator("input[name=recoveryCodesSaved]").check();
    if (negatives) {
      const accepted = new Set(
        [-1, 0, 1].map((offset) => totp(secret, Date.now() + offset * 30000)),
      );
      let wrong = "000000";
      for (let value = 0; accepted.has(wrong); value++)
        wrong = String(value + 1).padStart(6, "0");
      await page.locator("#login-mfa-code").fill(wrong);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page
          .getByRole("button", { name: "Sicher bestätigen", exact: true })
          .click(),
      ]);
      await expect(page.getByRole("alert")).toBeVisible();
      assert.equal((await api(page, "/api/crm/core")).status, 401);
      await page.locator("input[name=recoveryCodesSaved]").check();
    }
    await page.locator("#login-mfa-code").fill(totp(secret));
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page
        .getByRole("button", { name: "Sicher bestätigen", exact: true })
        .click(),
    ]);
  }
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator(".crm-app")).toBeVisible();
  const cookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "novalure_session",
  );
  assert(
    cookie?.httpOnly && cookie.value.startsWith("v2."),
    "Session must be server issued and HttpOnly",
  );
  const persisted = await admin.query(
    "select mfa_verified_at from auth_sessions where auth_identity_id=$1 and revoked_at is null",
    [account.authIdentityId],
  );
  assert.equal(persisted.rows.length, 1);
  assert.equal(
    Boolean(persisted.rows[0].mfa_verified_at),
    requiresMfa,
    "Existing role-based MFA policy must be preserved",
  );
  authenticationProofs.push({
    userId: account.userId,
    ordinaryPassword: true,
    mfaRequired: requiresMfa,
    totpFromEnrollmentUi: requiresMfa,
    sessionInjected: false,
  });
  return {
    ordinaryPassword: true,
    mfaRequired: requiresMfa,
    totpFromEnrollmentUi: requiresMfa,
    sessionInjected: false,
  };
}

async function open(
  page,
  workspaceId,
  section = "dashboard",
  projectId = "all",
) {
  const url = new URL("/", base);
  url.search = new URLSearchParams({
    lang: "de",
    workspaceId,
    projectId,
  }).toString();
  url.hash = section;
  // The real CRM can poll live modules; readiness is its rendered shell and
  // scoped content, rather than the absence of background network activity.
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".crm-app")).toBeVisible();
  await expect(page.locator("[data-crm-content]")).toBeVisible();
  if (workspaceId === accounts?.customer.workspaceId && section === "knowledge")
    await expect(
      page.getByRole("button", { name: /^Wissensquellen \(/ }),
    ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function chooseProfile(page, profile) {
  // Initial hash/profile hydration can reset the focused sidebar. Perform the
  // actual toggle and observe its state before operating its conditional form.
  await expect(async () => {
    const sidebar = page.locator("[data-crm-sidebar]");
    if ((await sidebar.getAttribute("data-collapsed")) === "true")
      await page.locator("[data-crm-collapse]").click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "false", {
      timeout: 1500,
    });
    const select = page.locator("[data-crm-profile-card] select");
    await select.selectOption(profile, { timeout: 1500 });
    await expect(select).toHaveValue(profile, { timeout: 1500 });
  }).toPass({ timeout: 15000, intervals: [100, 250, 500] });
}

async function themeAndLayout(page) {
  await expect(page.locator(".crm-app.design-c")).toBeVisible();
  await expect(page.locator(".crm-app")).toHaveAttribute("data-design", "c");
  const styles = await page.locator(".crm-app").evaluate((element) => ({
    theme: element.getAttribute("data-design"),
    background: getComputedStyle(element).backgroundColor,
    accent: getComputedStyle(element).getPropertyValue("--dc-accent").trim(),
    sidebar: getComputedStyle(element.querySelector("[data-crm-sidebar]"))
      .backgroundColor,
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  assert.equal(
    styles.background,
    "rgb(247, 248, 252)",
    "Design C light canvas must be rendered",
  );
  assert.equal(
    styles.sidebar,
    "rgb(23, 29, 48)",
    "Actual CRM navigation must use Design C navy",
  );
  assert(styles.accent, "Design C token sheet must be present");
  assert(
    styles.document <= styles.viewport + 1,
    `Horizontal overflow: ${JSON.stringify(styles)}`,
  );
  await expect(
    page.getByRole("button", { name: "Kundenportal zeigen", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Demo-Mandant auswählen", exact: true }),
  ).toHaveCount(0);
  return styles;
}

async function axeScan(page, name) {
  if (!(await page.evaluate(() => Boolean(window.axe))))
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const scan = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return {
      version: window.axe.version,
      violations: result.violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        nodes: item.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      })),
      incomplete: result.incomplete.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      })),
      passes: result.passes.length,
    };
  });
  axeResults.push({ name, ...scan });
  assert.equal(
    scan.violations.length,
    0,
    `${name}: ${scan.violations.map((item) => `${item.id} (${item.nodes.length})`).join(", ")}`,
  );
  return {
    violations: 0,
    passes: scan.passes,
    manualReviewRules: scan.incomplete.length,
  };
}

async function verifyWorkspaceSwitch() {
  const list = await api(operatorPage, "/api/workspaces");
  assert.equal(list.status, 200);
  const ids = list.body.workspaces.map((workspace) => workspace.id);
  for (const id of [
    accounts.operator.workspaceId,
    accounts.customer.workspaceId,
    accounts.studio.workspaceId,
  ])
    assert(ids.includes(id));
  assert(!ids.includes(accounts.foreign.workspaceId));
  await open(operatorPage, accounts.operator.workspaceId, "contacts");
  const workspaceSwitch = operatorPage.getByLabel("Workspace wechseln");
  const details = workspaceSwitch.locator("xpath=ancestor::details[1]");
  if ((await details.count()) && !(await workspaceSwitch.isVisible()))
    await details.locator("summary").first().click();
  await workspaceSwitch.selectOption(accounts.customer.workspaceId);
  await expect(workspaceSwitch).toHaveValue(accounts.customer.workspaceId);
  // Workspace changes preserve the user's current section. The existing
  // Contacts view must replace its records with the target membership's data.
  await expect(
    operatorPage.locator(
      '[data-crm-sidebar] [data-crm-nav-item][aria-current="page"]',
    ),
  ).toHaveAttribute("aria-label", "Kontakte");
  await expect(operatorPage.locator("[data-crm-content]")).toContainText(
    "SYNTHETIC CUSTOMER CONTACT",
  );
  await expect(operatorPage.locator("[data-crm-content]")).not.toContainText(
    "SYNTHETIC SECOND PROJECT CONTACT",
  );
  await operatorPage.screenshot({
    path: path.join(output, "workspace-switch-live-1440.png"),
    fullPage: true,
  });
  const denied = await api(
    operatorPage,
    "/api/crm/core",
    accounts.foreign.workspaceId,
  );
  assert(
    [403, 404].includes(denied.status),
    "Even internal users require actual foreign-workspace membership",
  );
  // The existing controller changes managed workspaces through its authorized
  // dropdown; a URL scope alone does not change the server login membership.
  await workspaceSwitch.selectOption(accounts.studio.workspaceId);
  await expect(workspaceSwitch).toHaveValue(accounts.studio.workspaceId);
  await expect(operatorPage.locator("[data-crm-content]")).toContainText(
    list.body.workspaces.find(
      (workspace) => workspace.id === accounts.studio.workspaceId,
    ).name,
  );
  await chooseProfile(operatorPage, "novalureStudio");
  const studioCore = await api(
    operatorPage,
    "/api/crm/core",
    accounts.studio.workspaceId,
  );
  assert.equal(studioCore.status, 200);
  assert.equal(studioCore.body.source, "database");
  assert(
    studioCore.body.data.projects.some(
      (project) => project.id === accounts.studio.projectId,
    ),
  );
  assert(
    studioCore.body.data.contacts.some(
      (contact) => contact.name === "SYNTHETIC STUDIO CONTACT",
    ),
  );
  assert(
    studioCore.body.data.contacts.every(
      (contact) => contact.workspaceId === accounts.studio.workspaceId,
    ),
  );
  await themeAndLayout(operatorPage);
  await operatorPage.screenshot({
    path: path.join(output, "studio-live-1440.png"),
    fullPage: true,
  });
  return {
    authorizedWorkspaces: ids.length,
    studioUsesExistingProject: true,
  };
}

async function runIntegration() {
  const identity = await admin.query("select current_user as name");
  assert.equal(identity.rows[0].name, "qa_admin");
  accounts = await seedDesignCIntegration({
    admin,
    role: fixture.database.user,
  });
  await writeFile(
    path.join(
      output,
      workspaceOnly ? "fixture-private-workspace.json" : "fixture-private.json",
    ),
    JSON.stringify(accounts, null, 2),
  );
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.CRM_QA_CHROMIUM_PATH
      ? { executablePath: process.env.CRM_QA_CHROMIUM_PATH }
      : {}),
  });
  operatorPage = await newPage("operator");
  await step(
    "Anonymous CRM and Knowledge APIs deny access",
    async () => {
      await operatorPage.goto(new URL("/login?lang=de", base).href);
      for (const endpoint of [
        "/api/crm/core",
        "/api/knowledge-center",
        "/api/workspaces",
      ])
        assert.equal((await api(operatorPage, endpoint)).status, 401);
    },
    true,
  );
  await step(
    "Regular operator login rejects bad password/TOTP and completes real MFA",
    () => login(operatorPage, accounts.operator, true),
    true,
  );
  await step(
    "Operator chooses its existing authorized internal navigation profile",
    () => chooseProfile(operatorPage, "novalureInternal"),
    true,
  );
  if (workspaceOnly) {
    await step(
      "Explicit operator membership authorizes customer and canonical Studio workspaces only",
      verifyWorkspaceSwitch,
    );
    return;
  }

  await step(
    "Authorized database API supplies the dashboard without synthetic preview fallbacks",
    async () => {
      await open(operatorPage, accounts.operator.workspaceId);
      const core = await api(
        operatorPage,
        "/api/crm/core",
        accounts.operator.workspaceId,
      );
      assert.equal(core.status, 200);
      assert.equal(core.body.source, "database");
      assert.equal(core.body.activeWorkspaceId, accounts.operator.workspaceId);
      assert(
        core.body.data.contacts.some(
          (contact) => contact.id === accounts.operator.developerContactId,
        ),
      );
      assert(
        !JSON.stringify(core.body.data).includes(
          "SYNTHETIC FOREIGN PRIVATE SENTINEL",
        ),
      );
      await expect(
        operatorPage.locator("[data-evelyn-command-center]"),
      ).toBeVisible();
      const projects = operatorPage
        .locator(".ec-metric-grid .dc-metric")
        .filter({
          has: operatorPage.getByText("Aktive Projekte", { exact: true }),
        });
      await expect(projects.locator("strong")).toHaveText(
        String(
          core.body.data.projects.filter((project) =>
            ["Aktiv", "Skaliert"].includes(project.status),
          ).length,
        ),
      );
      const offers = operatorPage.locator(".ec-metric-grid .dc-metric").filter({
        has: operatorPage.getByText("Offene Angebote", { exact: true }),
      });
      await expect(offers.locator("strong")).toContainText("Nicht verfügbar");
      await expect(
        operatorPage.locator("[data-crm-content]"),
      ).not.toContainText(
        /Atelier Nord|Atelier Linden|Parkquartier · Demo|48\.250|Guten Morgen\. Ihr Fokus/,
      );
      await themeAndLayout(operatorPage);
      await operatorPage.screenshot({
        path: path.join(output, "operator-dashboard-1440.png"),
        fullPage: true,
      });
      return {
        source: core.body.source,
        counts: core.body.counts,
        moduleSources: core.body.moduleSources,
      };
    },
  );

  await step(
    "Every visible operator navigation entry retains the live Design C shell",
    async () => {
      await open(operatorPage, accounts.operator.workspaceId);
      const nav = operatorPage.locator("[data-crm-sidebar] [data-crm-nav]");
      const labels = await nav
        .locator("[data-crm-nav-item]")
        .evaluateAll((elements) =>
          elements.map(
            (element) =>
              element.getAttribute("aria-label") || element.textContent.trim(),
          ),
        );
      assert(
        labels.length >= 6,
        "Expected real role-authorized CRM navigation",
      );
      const visited = [];
      for (const label of labels) {
        await nav.getByRole("button", { name: label, exact: true }).click();
        await expect(
          nav.getByRole("button", { name: label, exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await themeAndLayout(operatorPage);
        visited.push({ label, hash: new URL(operatorPage.url()).hash });
      }
      return visited;
    },
  );

  await step(
    "Authorized search uses a native modal and never reveals another tenant",
    async () => {
      await open(operatorPage, accounts.operator.workspaceId);
      const trigger = operatorPage.getByRole("button", {
        name: "CRM durchsuchen",
        exact: true,
      });
      await trigger.focus();
      await trigger.click();
      const dialog = operatorPage.getByRole("dialog", {
        name: "CRM durchsuchen",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      assert(
        await dialog.evaluate(
          (element) =>
            element instanceof HTMLDialogElement && element.matches(":modal"),
        ),
      );
      const query = dialog.getByRole("searchbox", {
        name: "CRM durchsuchen",
        exact: true,
      });
      await query.fill("SYNTHETIC FOREIGN");
      await expect(dialog.locator("[data-crm-search-results]")).toHaveText(
        "Keine passenden Ergebnisse im geladenen Bereich.",
      );
      await query.fill("Synthetic developer representative");
      await expect(
        dialog.getByRole("button", {
          name: "Synthetic developer representative",
          exact: true,
        }),
      ).toBeVisible();
      for (let index = 0; index < 5; index++) {
        await operatorPage.keyboard.press("Tab");
        assert(
          await dialog.evaluate(
            (element) =>
              element.contains(document.activeElement) ||
              document.activeElement === document.body,
          ),
        );
      }
      await operatorPage.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
    },
  );

  await step(
    "A real empty Forms response never creates prepared business forms",
    async () => {
      const forms = await api(operatorPage, "/api/forms");
      assert.equal(forms.status, 200);
      assert.equal(forms.body.source, "database");
      assert.deepEqual(forms.body.forms, []);
      await chooseProfile(operatorPage, "marketing");
      await open(operatorPage, accounts.operator.workspaceId, "forms");
      await expect(
        operatorPage.getByText("Keine Formulare vorbereitet.", { exact: true }),
      ).toBeVisible();
      await expect(
        operatorPage.locator('[data-crm-content] a[href*="/forms/"]'),
      ).toHaveCount(0);
      await chooseProfile(operatorPage, "novalureInternal");
    },
  );

  for (const failure of ["fallback", "network"]) {
    await step(
      `Customer access ${failure} state exposes no sample records or unknown zero counts`,
      async () => {
        await chooseProfile(operatorPage, "management");
        const handler = async (route) => {
          if (failure === "network") return route.abort("failed");
          const response = await route.fetch();
          const payload = await response.json();
          payload.source = "fallback";
          payload.customerAccess = [
            {
              ...payload.customerAccess?.[0],
              name: "SYNTHETIC UNTRUSTED ACCESS SENTINEL",
              companyName: "SYNTHETIC UNTRUSTED ACCESS SENTINEL",
            },
          ];
          return route.fulfill({ response, json: payload });
        };
        await operatorPage.route("**/api/crm/customer-access**", handler);
        try {
          await open(
            operatorPage,
            accounts.operator.workspaceId,
            "customerAccess",
          );
          const unavailable = operatorPage.locator(
            '[data-customer-access-state="error"]',
          );
          await expect(unavailable).toBeVisible();
          await expect(unavailable).toContainText(
            "Die Kundendaten konnten nicht zuverlässig geladen werden.",
          );
          await expect(
            operatorPage.locator("[data-crm-content]"),
          ).not.toContainText("SYNTHETIC UNTRUSTED ACCESS SENTINEL");
          for (const text of await unavailable.locator("p").allTextContents())
            assert(
              !/^\s*\d+(?:[.,]\d+)?\s*$/.test(text),
              "Unavailable customer access displayed a numeric business count",
            );
          await expect(unavailable.getByRole("combobox")).toHaveCount(0);
        } finally {
          await operatorPage.unroute("**/api/crm/customer-access**", handler);
          await chooseProfile(operatorPage, "novalureInternal");
        }
      },
    );
  }

  await step(
    "Unlicensed Knowledge uses its actual entitlement state and rejects writes",
    async () => {
      await open(operatorPage, accounts.operator.workspaceId, "knowledge");
      const snapshot = await api(
        operatorPage,
        "/api/knowledge-center",
        accounts.operator.workspaceId,
      );
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.body.snapshot.available, false);
      await expect(
        operatorPage.getByText(
          "Das Knowledge-Modul ist nicht freigeschaltet.",
          { exact: true },
        ),
      ).toBeVisible();
      assert.equal(
        (
          await api(
            operatorPage,
            "/api/knowledge-center/areas",
            accounts.operator.workspaceId,
            { name: "SYNTHETIC forbidden entitlement", kind: "company" },
          )
        ).status,
        403,
      );
    },
  );

  await step(
    "Untrusted fallback response cannot populate contacts or manufacture dashboard zeros",
    async () => {
      await open(operatorPage, accounts.operator.workspaceId, "contacts");
      const handler = async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        assert.equal(response.status(), 200);
        payload.source = "mock";
        payload.data.source = "mock";
        payload.data.moduleSources = Object.fromEntries(
          Object.keys(payload.data.moduleSources).map((key) => [key, "mock"]),
        );
        payload.data.contacts = [
          {
            ...payload.data.contacts[0],
            name: "SYNTHETIC UNTRUSTED FALLBACK SENTINEL",
          },
        ];
        await route.fulfill({ response, json: payload });
      };
      await operatorPage.route("**/api/crm/core**", handler);
      try {
        const refresh = operatorPage
          .locator("[data-crm-header]")
          .getByRole("button", { name: "Aktualisieren", exact: true });
        await Promise.all([
          operatorPage.waitForResponse(
            (response) => new URL(response.url()).pathname === "/api/crm/core",
          ),
          refresh.click(),
        ]);
        await expect(refresh).toBeEnabled();
        await expect(
          operatorPage.locator("[data-crm-content]"),
        ).not.toContainText("SYNTHETIC UNTRUSTED FALLBACK SENTINEL");
        await expect(
          operatorPage.locator("[data-crm-content]"),
        ).not.toContainText("Synthetic developer representative");
        await operatorPage
          .locator("[data-crm-sidebar] [data-crm-nav-item]")
          .first()
          .click();
        await expect(
          operatorPage.locator("[data-evelyn-command-center]"),
        ).toBeVisible();
        for (const metric of await operatorPage
          .locator(".ec-metric-grid .dc-metric > strong")
          .all())
          assert(
            !/^\d/.test((await metric.innerText()).trim()),
            "Unknown data was presented as a numeric business result",
          );
      } finally {
        await operatorPage.unroute("**/api/crm/core**", handler);
        await open(operatorPage, accounts.operator.workspaceId);
      }
    },
  );

  await step(
    "Project scope switch clears another project's contact records",
    async () => {
      await open(
        operatorPage,
        accounts.operator.workspaceId,
        "contacts",
        accounts.operator.projectId,
      );
      await expect(operatorPage.locator("[data-crm-content]")).toContainText(
        "Synthetic developer representative",
      );
      await expect(
        operatorPage.locator("[data-crm-content]"),
      ).not.toContainText("SYNTHETIC SECOND PROJECT CONTACT");
      await open(
        operatorPage,
        accounts.operator.workspaceId,
        "contacts",
        accounts.secondProjectId,
      );
      await expect(operatorPage.locator("[data-crm-content]")).toContainText(
        "SYNTHETIC SECOND PROJECT CONTACT",
      );
      await expect(
        operatorPage.locator("[data-crm-content]"),
      ).not.toContainText("Synthetic developer representative");
      await operatorPage.setViewportSize({ width: 390, height: 844 });
      await operatorPage
        .getByRole("button", { name: "Navigation öffnen", exact: true })
        .click();
      const drawer = operatorPage.locator("[data-crm-mobile-drawer]");
      await drawer
        .getByRole("combobox", { name: "Projekte", exact: true })
        .selectOption(accounts.operator.projectId);
      await operatorPage.keyboard.press("Escape");
      await expect(operatorPage.locator("[data-crm-content]")).toContainText(
        "Synthetic developer representative",
      );
      await expect(
        operatorPage.locator("[data-crm-content]"),
      ).not.toContainText("SYNTHETIC SECOND PROJECT CONTACT");
      assert.equal(
        new URL(operatorPage.url()).searchParams.get("projectId"),
        accounts.operator.projectId,
      );
      await operatorPage.setViewportSize({ width: 1440, height: 1000 });
    },
  );

  await step(
    "Explicit operator membership authorizes customer and canonical Studio workspaces only",
    verifyWorkspaceSwitch,
  );

  customerPage = await newPage("customer_owner");
  await step(
    "Customer owner signs in through separate password and real MFA",
    () => login(customerPage, accounts.customer),
    true,
  );
  await step(
    "Customer chooses its existing authorized real-estate workspace profile",
    () => chooseProfile(customerPage, "realEstateBroker"),
    true,
  );
  await step(
    "Customer workspace cannot read operator, foreign contacts, projects or Knowledge",
    async () => {
      for (const workspaceId of [
        accounts.operator.workspaceId,
        accounts.foreign.workspaceId,
      ]) {
        for (const endpoint of ["/api/crm/core", "/api/knowledge-center"])
          assert(
            [403, 404].includes(
              (await api(customerPage, endpoint, workspaceId)).status,
            ),
          );
      }
      const list = await api(customerPage, "/api/workspaces");
      assert.equal(list.status, 200);
      assert.deepEqual(
        list.body.workspaces.map((item) => item.id),
        [accounts.customer.workspaceId],
      );
      await open(customerPage, accounts.customer.workspaceId, "knowledge");
      await expect(
        customerPage.locator("[data-crm-content]"),
      ).not.toContainText(/FOREIGN PRIVATE|SECOND PROJECT CONTACT/);
      const navText = await customerPage
        .locator("[data-crm-sidebar] [data-crm-nav]")
        .innerText();
      assert(
        !/Mandantenverwaltung|Customer Access|Kundenzugänge|Managed Service|Novalure Studio/.test(
          navText,
        ),
        `Internal administration exposed: ${navText}`,
      );
      const snapshot = await api(
        customerPage,
        "/api/knowledge-center",
        accounts.customer.workspaceId,
      );
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.body.snapshot.available, true);
      assert.equal(snapshot.body.snapshot.permissions.canWrite, true);
      await themeAndLayout(customerPage);
      await expect(customerPage.locator(".crm-app")).toHaveAttribute(
        "data-crm-audience",
        "customer",
      );
    },
  );

  await step(
    "Customer property and assistant views show actual scoped database records",
    async () => {
      const core = await api(
        customerPage,
        "/api/crm/core",
        accounts.customer.workspaceId,
      );
      assert.equal(core.status, 200);
      assert(
        core.body.data.propertyUnits.some(
          (unit) => unit.id === accounts.customer.unitId,
        ),
      );
      assert(
        core.body.data.crmBots.some(
          (bot) => bot.id === accounts.customer.botId,
        ),
      );
      await open(customerPage, accounts.customer.workspaceId, "units");
      await expect(customerPage.locator("[data-crm-content]")).toContainText(
        "SYNTHETIC-C-01",
      );
      await open(customerPage, accounts.customer.workspaceId, "bots");
      await expect(customerPage.locator("[data-crm-content]")).toContainText(
        "SYNTHETIC DESIGN C CUSTOMER ASSISTANT",
      );
      const profile = await api(customerPage, "/api/settings/company-profile");
      assert.equal(profile.status, 200);
      assert(
        JSON.stringify(profile.body).includes(
          "SYNTHETIC DESIGN C CUSTOMER COMPANY",
        ),
      );
      await open(customerPage, accounts.customer.workspaceId, "knowledge");
    },
  );

  await step(
    "Unknown assistant approval and conversation data remains unavailable rather than zero",
    async () => {
      const handler = (route) => route.abort("failed");
      await customerPage.route("**/api/approvals**", handler);
      try {
        await open(customerPage, accounts.customer.workspaceId, "bots");
        for (const label of ["Policy-Ausnahmen", "Offene Gespräche"]) {
          const metric = customerPage
            .locator(".evelyn-bot-metric")
            .filter({ has: customerPage.getByText(label, { exact: true }) });
          await expect(metric.locator(".evelyn-bot-metric-value")).toHaveText(
            "Live-Daten nicht erreichbar",
          );
        }
      } finally {
        await customerPage.unroute("**/api/approvals**", handler);
        await open(customerPage, accounts.customer.workspaceId, "knowledge");
      }
    },
  );

  await step(
    "Customer Knowledge area and draft are saved by the real self-service forms",
    async () => {
      await customerPage
        .getByRole("button", { name: /^Wissensbereiche \(/ })
        .click();
      await customerPage
        .getByRole("button", { name: "Bereich erstellen", exact: true })
        .click();
      const form = customerPage.locator("form").filter({
        has: customerPage.getByRole("heading", {
          name: "Bereich erstellen",
          exact: true,
        }),
      });
      await form
        .getByLabel("Name", { exact: true })
        .fill("SYNTHETIC DESIGN C COMPANY KNOWLEDGE");
      await form
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await expect(
        customerPage.getByText("Änderung gespeichert.", { exact: true }),
      ).toBeVisible();
      await customerPage
        .getByRole("button", { name: /^Wissensquellen \(/ })
        .click();
      await customerPage
        .getByRole("button", { name: "Wissen hinzufügen", exact: true })
        .click();
      const sourceForm = customerPage.locator("form").filter({
        has: customerPage.getByRole("heading", {
          name: "Wissen hinzufügen",
          exact: true,
        }),
      });
      await sourceForm
        .getByLabel("Wissensbereich", { exact: true })
        .selectOption({ label: "SYNTHETIC DESIGN C COMPANY KNOWLEDGE" });
      await sourceForm
        .getByLabel("Name", { exact: true })
        .fill("SYNTHETIC DESIGN C HOURS");
      await sourceForm
        .getByLabel("Inhalt", { exact: true })
        .fill("SYNTHETIC integrationpear: Office opens at 09:00.");
      await sourceForm
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await expect(
        customerPage.getByRole("heading", {
          name: "SYNTHETIC DESIGN C HOURS",
          exact: true,
        }),
      ).toBeVisible();
      const snapshot = (
        await api(
          customerPage,
          "/api/knowledge-center",
          accounts.customer.workspaceId,
        )
      ).body.snapshot;
      areaId = snapshot.areas.find(
        (area) => area.name === "SYNTHETIC DESIGN C COMPANY KNOWLEDGE",
      ).id;
      sourceId = snapshot.sources.find(
        (source) => source.name === "SYNTHETIC DESIGN C HOURS",
      ).id;
      const row = await admin.query(
        "select workspace_id,approved_version_id,draft_version_id from knowledge_sources where id=$1",
        [sourceId],
      );
      assert.equal(row.rows[0].workspace_id, accounts.customer.workspaceId);
      assert.equal(row.rows[0].approved_version_id, null);
      assert(row.rows[0].draft_version_id);
    },
  );

  await step(
    "Knowledge assignment and explicit publication gate real webchat retrieval",
    async () => {
      assert(areaId && sourceId, "Requires the persisted self-service draft");
      await customerPage
        .getByRole("button", { name: "KI-Zuordnungen", exact: true })
        .click();
      await customerPage
        .getByLabel("KI-Assistent", { exact: true })
        .selectOption(accounts.customer.botId);
      await customerPage
        .getByRole("checkbox", { name: /SYNTHETIC DESIGN C COMPANY KNOWLEDGE/ })
        .check();
      await customerPage
        .getByRole("button", { name: "Zuordnungen speichern", exact: true })
        .click();
      await expect(
        customerPage.getByText("Wissenszuordnungen gespeichert.", {
          exact: true,
        }),
      ).toBeVisible();
      let query = await api(
        customerPage,
        "/api/knowledge-center/query",
        accounts.customer.workspaceId,
        {
          query: "integrationpear",
          botId: accounts.customer.botId,
          channel: "webchat",
        },
      );
      assert.equal(query.status, 200);
      assert.equal(query.body.matches.length, 0);
      const source = (
        await api(
          customerPage,
          "/api/knowledge-center",
          accounts.customer.workspaceId,
        )
      ).body.snapshot.sources.find((item) => item.id === sourceId);
      const publication = await api(
        customerPage,
        "/api/knowledge-center/publish",
        accounts.customer.workspaceId,
        {
          sourceId,
          versionId: source.version.id,
          expectedVersion: source.revision,
        },
      );
      assert.equal(publication.status, 200, JSON.stringify(publication.body));
      query = await api(
        customerPage,
        "/api/knowledge-center/query",
        accounts.customer.workspaceId,
        {
          query: "integrationpear",
          botId: accounts.customer.botId,
          channel: "webchat",
        },
      );
      assert.equal(query.status, 200);
      assert.equal(query.body.matches.length, 1);
      assert.equal(query.body.matches[0].sourceId, sourceId);
      const bot = await admin.query("select status from bots where id=$1", [
        accounts.customer.botId,
      ]);
      assert.equal(
        bot.rows[0].status,
        "Entwurf",
        "Assigning Knowledge must never activate a paid assistant",
      );
    },
  );

  await step(
    "Customer PDF upload extracts private text and requires explicit review",
    async () => {
      await customerPage
        .getByRole("button", { name: /^Wissensquellen \(/ })
        .click();
      await customerPage
        .getByRole("button", { name: "Datei hochladen", exact: true })
        .click();
      const form = customerPage.locator("form").filter({
        has: customerPage.getByRole("heading", {
          name: "Wissen hinzufügen",
          exact: true,
        }),
      });
      await form
        .getByLabel("Wissensbereich", { exact: true })
        .selectOption({ label: "SYNTHETIC DESIGN C COMPANY KNOWLEDGE" });
      await form
        .getByLabel("Name (optional)", { exact: true })
        .fill("SYNTHETIC DESIGN C PDF");
      await form
        .getByLabel("Privates Dokument hochladen", { exact: true })
        .setInputFiles({
          name: "synthetic-design-c.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from(
            await createTextPdf([
              "SYNTHETIC designcprivatepdf: Local office document.",
            ]),
          ),
        });
      const card = customerPage.locator("li").filter({
        has: customerPage.getByRole("heading", {
          name: "SYNTHETIC DESIGN C PDF",
          exact: true,
        }),
      });
      await expect(
        card.getByText("Inhalt erkannt · Bitte prüfen", { exact: true }),
      ).toBeVisible();
      const review = card.getByRole("region", {
        name: "Erkannter Inhalt",
        exact: true,
      });
      await expect(review).toContainText("designcprivatepdf");
      await expect(
        review.getByRole("button", {
          name: "Diese Version freigeben",
          exact: true,
        }),
      ).toBeDisabled();
      await review.getByRole("checkbox").check();
      await review
        .getByRole("button", { name: "Diese Version freigeben", exact: true })
        .click();
      await expect(
        card.getByText("Freigegebene Version aktiv", { exact: true }).first(),
      ).toBeVisible();
    },
  );

  viewerPage = await newPage("customer_viewer");
  await step(
    "Read-only customer authenticates normally and cannot escalate Knowledge rights",
    async () => {
      await login(viewerPage, accounts.viewer);
      await open(viewerPage, accounts.customer.workspaceId, "knowledge");
      const snapshot = await api(
        viewerPage,
        "/api/knowledge-center",
        accounts.customer.workspaceId,
      );
      assert.equal(snapshot.status, 200);
      assert.deepEqual(snapshot.body.snapshot.permissions, {
        canWrite: false,
        canPublish: false,
        canAssign: false,
      });
      for (const label of [
        "Wissen hinzufügen",
        "Datei hochladen",
        "Bereich erstellen",
      ]) {
        const button = viewerPage.getByRole("button", {
          name: label,
          exact: true,
        });
        assert(
          (await button.count()) === 0 || !(await button.isEnabled()),
          `Viewer can activate ${label}`,
        );
      }
      assert.equal(
        (
          await api(
            viewerPage,
            "/api/knowledge-center/areas",
            accounts.customer.workspaceId,
            { name: "SYNTHETIC viewer denied", kind: "company" },
          )
        ).status,
        403,
      );
      const publishedSource = snapshot.body.snapshot.sources.find(
        (source) => source.id === sourceId,
      );
      assert(
        publishedSource?.approvedVersionId,
        "Requires an actual published source to test viewer authorization",
      );
      assert.equal(
        (
          await api(
            viewerPage,
            "/api/knowledge-center/publish",
            accounts.customer.workspaceId,
            {
              sourceId,
              versionId: publishedSource.approvedVersionId,
              expectedVersion: publishedSource.revision,
            },
          )
        ).status,
        403,
      );
      assert(
        [403, 404].includes(
          (await api(viewerPage, "/api/crm/core", accounts.foreign.workspaceId))
            .status,
        ),
      );
      await themeAndLayout(viewerPage);
    },
  );

  for (const width of [1440, 768, 390, 360]) {
    await customerPage.setViewportSize({
      width,
      height: width < 768 ? 844 : 1000,
    });
    for (const section of [
      "dashboard",
      "contacts",
      "properties",
      "bots",
      "knowledge",
      "settings",
    ]) {
      await step(
        `Customer ${section}: live theme and responsive layout at ${width}px`,
        async () => {
          await open(customerPage, accounts.customer.workspaceId, section);
          if (section === "knowledge")
            await expect(
              customerPage.getByRole("heading", {
                name: "SYNTHETIC DESIGN C HOURS",
                exact: true,
              }),
            ).toBeVisible();
          const layout = await themeAndLayout(customerPage);
          if (
            ["dashboard", "knowledge", "properties"].includes(section) &&
            [1440, 390].includes(width)
          )
            await customerPage.screenshot({
              path: path.join(output, `customer-${section}-${width}.png`),
              fullPage: true,
            });
          if (
            width === 1440 &&
            ["dashboard", "knowledge", "settings"].includes(section)
          )
            await axeScan(customerPage, `${section}-${width}`);
          return layout;
        },
      );
    }
  }

  await step(
    "Customer mobile navigation traps focus, closes with Escape and restores trigger",
    async () => {
      await customerPage.setViewportSize({ width: 390, height: 844 });
      await open(customerPage, accounts.customer.workspaceId);
      const trigger = customerPage.getByRole("button", {
        name: "Navigation öffnen",
        exact: true,
      });
      await trigger.focus();
      await trigger.click();
      const dialog = customerPage.locator("[data-crm-mobile-drawer]");
      await expect(dialog).toBeVisible();
      assert.equal(await dialog.getAttribute("aria-modal"), "true");
      const controls = await dialog
        .locator(
          "button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href]",
        )
        .count();
      for (let index = 0; index < controls + 2; index++) {
        await customerPage.keyboard.press("Tab");
        assert(
          await dialog.evaluate((element) =>
            element.contains(document.activeElement),
          ),
          "Keyboard focus escaped mobile navigation",
        );
      }
      await customerPage.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await axeScan(customerPage, "customer-mobile-dashboard");
    },
  );

  await step(
    "Reduced motion preference disables integration shell movement",
    async () => {
      await customerPage.emulateMedia({ reducedMotion: "reduce" });
      const moving = await customerPage.locator(".crm-app").evaluate((root) =>
        Array.from(
          root.querySelectorAll("button,aside,header,[data-crm-mobile-drawer]"),
        )
          .filter((element) => {
            const css = getComputedStyle(element);
            return [
              ...css.transitionDuration.split(","),
              ...css.animationDuration.split(","),
            ].some((duration) => parseFloat(duration) > 0.001);
          })
          .map((element) => ({
            tag: element.tagName,
            class: element.className,
          })),
      );
      assert.deepEqual(moving, []);
    },
  );

  await step(
    "RLS remains forced and runtime role cannot bypass row security",
    async () => {
      const role = await admin.query(
        "select rolsuper,rolbypassrls from pg_roles where rolname=$1",
        [fixture.database.user],
      );
      assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
      const protectedTables = [
        "knowledge_areas",
        "knowledge_sources",
        "knowledge_source_versions",
        "knowledge_area_grants",
        "knowledge_center_entitlements",
        "media_assets",
      ];
      const tables = await admin.query(
        "select relname,relrowsecurity,relforcerowsecurity from pg_class where oid=any($1::regclass[]) order by relname",
        [protectedTables],
      );
      assert.equal(tables.rows.length, protectedTables.length);
      for (const table of tables.rows)
        assert(
          table.relrowsecurity && table.relforcerowsecurity,
          `RLS disabled on ${table.relname}`,
        );
      return tables.rows;
    },
  );

  await step(
    "No browser exceptions, server failures, browser outbound requests or preview UI",
    async () => {
      await Promise.all(responseChecks);
      assert.deepEqual(errors, []);
      assert.deepEqual(serverErrors, []);
      assert.deepEqual(outbound, []);
      assert.deepEqual(
        privateLeaks,
        [],
        "A successful API response leaked unauthorized foreign records",
      );
      const reactErrors = consoleErrors.filter((item) =>
        /hydration|react error|invalid.*(?:aria|html)|validateDOMNesting/i.test(
          item.message,
        ),
      );
      assert.deepEqual(reactErrors, []);
      return {
        uncaughtErrors: 0,
        serverErrors: 0,
        outboundRequests: 0,
        sessionInjection: false,
      };
    },
  );
}

try {
  await runIntegration();
} catch (error) {
  if (
    !results.some(
      (result) => result.status === "FAIL" && result.error === error.message,
    )
  )
    results.push({
      name: "Prerequisite or browser setup",
      status: "FAIL",
      error: error.stack || error.message,
    });
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
  await admin.end();
  const failed = results.filter((result) => result.status === "FAIL");
  const report = {
    syntheticOnly: true,
    productionAccess: 0,
    sessionInjection: false,
    ordinaryPasswordAndMfa: workspaceOnly
      ? false
      : authenticationProofs.length === 3,
    scope: workspaceOnly ? "focused-workspace-studio" : "whole-integration",
    authenticationProofs,
    generatedAt: new Date().toISOString(),
    baseUrl: base.href,
    summary: {
      passed: results.length - failed.length,
      failed: failed.length,
      axeScans: axeResults.length,
    },
    results,
    axe: axeResults,
    errors,
    serverErrors,
    outbound,
    privateLeaks,
    responseInspectionErrors,
    consoleErrors,
    limitations: [
      "Production target isolation relies on the required qa:sales:server disposable loopback database and environment allowlist; browser routing observes browser outbound traffic, not server-side provider IO.",
      "Passive browser body inspection records stale/cancelled or unavailable bodies separately. Explicit role and tenant checks inspect consumed API JSON; passive inspection alone is not proof of every response body.",
      "The isolated fixture applies unchanged pinned 091–096 and 100–103; optional pgvector, historical manual media migration 062, and preview migrations 097–099 remain excluded. This is not a full production migration proof.",
      "axe incomplete findings remain manual-review items; automated checks are not a full WCAG certification.",
    ],
  };
  await writeFile(
    path.join(output, reportFile),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        ...report.summary,
        failures: failed.map((result) => ({
          name: result.name,
          error: result.error.split("\n")[0],
        })),
        report: path.join(output, reportFile),
      },
      null,
      2,
    ),
  );
  if (failed.length) process.exitCode = 1;
}
