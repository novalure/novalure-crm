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
import {
  seedDesignCIntegration,
  seedDesignCReaderRows,
} from "./lib/design-c-integration-fixture.mjs";

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
const readersOnly = process.argv.includes("--readers-only");
assert(
  process.argv
    .slice(2)
    .every((arg) => ["--workspace-only", "--readers-only"].includes(arg)) &&
    !(workspaceOnly && readersOnly),
  "Unknown browser QA argument",
);
const reportFile = readersOnly
  ? "result-readers.json"
  : workspaceOnly
    ? "result-workspace.json"
    : "result.json";
const artifactPrefix = readersOnly ? "readers-" : "";
const output = path.resolve(".npm-cache/qa/design-c-integration");
assert.equal(
  fixture.fixtureMode,
  "design-c-actual-predecessors",
  "Start qa:sales:server with --built --design-c to preserve the actual 091–106 predecessor contracts and additive account-language schema",
);
assert.equal(fixture.database.database, "neondb");
await mkdir(output, { recursive: true });
for (const file of workspaceOnly || readersOnly ? [] : await readdir(output)) {
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
  readerMutations = [],
  authenticationProofs = [];
const contexts = [];
let browser, accounts, operatorPage, customerPage, viewerPage, areaId, sourceId;
const operationalReaders = [
  {
    id: "channels",
    path: "/api/bots/channels",
    tab: "Gespräche",
    heading: "Webhook-Eingang",
    empty: ["Noch keine Webhook-Events gespeichert."],
    unavailable: "Live-Daten nicht erreichbar",
  },
  {
    id: "approvals",
    path: "/api/approvals",
    tab: "Automationen",
    heading: "Autonomie-Kontrolle",
    empty: ["Keine manuellen Ausnahmefälle."],
    unavailable:
      "Bot-Kontrolldaten konnten nicht geladen oder aktualisiert werden.",
  },
  {
    id: "actions",
    path: "/api/bots/actions",
    tab: "Automationen",
    heading: "Bot-Aktionsmonitor",
    empty: [
      "Keine wartenden Dokumentversande.",
      "Keine wartenden Terminvorschläge.",
    ],
    unavailable: "Bot-Aktionen konnten nicht geladen oder aktualisiert werden.",
  },
  {
    id: "calendar",
    path: "/api/meetings/oauth/status",
    heading: "Kalender verbinden",
    empty: ["Welchen Kalender möchten Sie verbinden?"],
    unavailable: "Verbindungsstatus derzeit nicht verfügbar.",
  },
];

function scopedReaderPath(reader, scope = {}) {
  const query = new URLSearchParams(scope).toString();
  return reader.path + (query ? `?${query}` : "");
}

function assertDatabaseReader(response) {
  assert.equal(response.status, 200);
  assert.equal(response.body?.source, "database");
  assert.match(response.cacheControl || "", /private/);
  assert.match(response.cacheControl || "", /no-store/);
}

function assertEmptyReader(reader, response) {
  assertDatabaseReader(response);
  if (reader.id === "channels") {
    assert.deepEqual(response.body.channelAccounts, []);
    assert.deepEqual(response.body.recentWebhookEvents, []);
  } else if (reader.id === "approvals") {
    assert.deepEqual(response.body.approvals, []);
    assert.equal(response.body.status, "pending");
  } else if (reader.id === "actions") {
    assert.deepEqual(response.body.documentSends, []);
    assert.deepEqual(response.body.meetingBookings, []);
    assert.deepEqual(response.body.metrics, {
      openDocuments: 0,
      openMeetings: 0,
    });
  } else {
    for (const provider of ["google", "microsoft"]) {
      assert.equal(response.body[provider].provider, provider);
      assert.equal(response.body[provider].connected, false);
      assert.equal(response.body[provider].accountLabel, null);
      assert.deepEqual(response.body[provider].scopes, []);
    }
  }
}

async function readerPanel(
  page,
  reader,
  workspaceId = accounts.operator.workspaceId,
) {
  const previousUrl = page.url();
  await open(page, workspaceId, reader.id === "calendar" ? "calendar" : "bots");
  // An identical URL containing a fragment can be a same-document navigation.
  // Repeated checks need a fresh request after their interceptor is installed.
  if (previousUrl === page.url()) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-crm-content]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  }
  if (reader.tab)
    await page
      .getByRole("navigation", { name: "Bot-Arbeitsbereich", exact: true })
      .getByRole("button", { name: reader.tab, exact: true })
      .click();
  const heading = page.getByRole("heading", {
    name: reader.heading,
    exact: true,
  });
  await expect(heading).toBeVisible();
  return heading.locator(
    reader.id === "approvals"
      ? "xpath=ancestor::section[1]"
      : "xpath=ancestor::article[1]",
  );
}

async function verifyReaderUi(reader, failure, beforeAssertion) {
  const panel = await readerPanel(operatorPage, reader);
  if (beforeAssertion) await beforeAssertion();
  if (failure) {
    await expect(panel).toContainText(reader.unavailable);
    for (const message of reader.empty)
      await expect(panel).not.toContainText(message);
    if (reader.id === "calendar")
      await expect(panel).not.toContainText("Noch nicht verbunden");
  } else {
    for (const message of reader.empty)
      await expect(panel).toContainText(message);
    await expect(panel).not.toContainText(reader.unavailable);
    await themeAndLayout(operatorPage);
  }
  return panel;
}

function assertPublicReaderRows(reader, response, group, seeded) {
  assertDatabaseReader(response);
  const body = response.body;
  const json = JSON.stringify(body);
  assert(
    !json.includes(seeded.secret),
    "Private provider/metadata credential material reached a read response",
  );
  assert(
    !json.includes("SYNTHETIC FOREIGN PRIVATE SENTINEL"),
    "A foreign operational record reached a read response",
  );
  if (reader.id === "channels") {
    assert(body.channelAccounts.some((row) => row.id === group.accountId));
    assert(body.recentWebhookEvents.some((row) => row.id === group.webhookId));
    assert(json.includes(`${group.label} MESSAGE`));
    assert(
      !body.channelAccounts.some(
        (row) => "credentialsRef" in row || "metadata" in row,
      ),
    );
    assert(!body.recentWebhookEvents.some((row) => "payload" in row));
  } else if (reader.id === "approvals") {
    assert(body.approvals.some((row) => row.id === group.approvalId));
    assert(json.includes(`${group.label} APPROVAL`));
  } else if (reader.id === "actions") {
    assert(body.documentSends.some((row) => row.id === group.documentId));
    assert(json.includes(`${group.label} DOCUMENT`));
    assert(!json.includes("https://private.invalid/"));
  } else {
    assert.equal(body.google.connected, true);
    assert.equal(
      body.google.accountLabel,
      "SYNTHETIC READER CUSTOMER CALENDAR",
    );
    assert(!("config" in body.google));
  }
}

async function verifyOperationalReaders() {
  const applied = await admin.query(
    "select version from novalure_schema_migrations where version='106_crm_operational_readers'",
  );
  assert.equal(
    applied.rows.length,
    1,
    "The unchanged additive 106 read migration must be provisioned locally",
  );
  await step(
    "Scoped reader functions leave raw table privileges and runtime identity restricted",
    async () => {
      const runtime = new pg.Pool(fixture.database);
      try {
        const identity = await runtime.query(
          "select current_user as role,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
        );
        assert.equal(identity.rows[0].role, fixture.database.user);
        assert.equal(identity.rows[0].rolsuper, false);
        assert.equal(identity.rows[0].rolbypassrls, false);
        for (const table of [
          "approval_requests",
          "bot_channel_webhooks",
          "bot_document_sends",
          "provider_connections",
        ]) {
          const privileges = await runtime.query(
            "select has_table_privilege(current_user,$1,'SELECT') as read,has_table_privilege(current_user,$1,'INSERT') as insert,has_table_privilege(current_user,$1,'UPDATE') as update,has_table_privilege(current_user,$1,'DELETE') as delete",
            [`public.${table}`],
          );
          assert.deepEqual(privileges.rows[0], {
            read: false,
            insert: false,
            update: false,
            delete: false,
          });
        }
      } finally {
        await runtime.end();
      }
    },
  );
  for (const reader of operationalReaders) {
    await step(
      `${reader.id}: real runtime returns a verified empty database result`,
      async () => {
        assertEmptyReader(reader, await api(operatorPage, reader.path));
      },
    );
    await step(
      `${reader.id}: actual read panel distinguishes verified empty data`,
      async () => {
        await verifyReaderUi(reader, false);
        await operatorPage.screenshot({
          path: path.join(output, `readers-${reader.id}-empty-1440.png`),
          fullPage: true,
        });
      },
    );
    for (const failure of ["missing-source", "network"])
      await step(
        `${reader.id}: ${failure} becomes unavailable without an empty-success claim`,
        async () => {
          let intercepted = 0;
          const handler = async (route) => {
            intercepted++;
            if (failure === "network") return route.abort("failed");
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            const payload = await response.json();
            assert.equal(payload.source, "database");
            delete payload.source;
            await route.fulfill({ response, json: payload });
          };
          await operatorPage.route(`**${reader.path}**`, handler);
          try {
            await verifyReaderUi(reader, true, async () => {
              await expect.poll(() => intercepted).toBeGreaterThan(0);
            });
            return { interceptedRequests: intercepted };
          } finally {
            await operatorPage.unroute(`**${reader.path}**`, handler);
          }
        },
      );
  }
  const seeded = await seedDesignCReaderRows({ admin, accounts });
  const { alpha, beta, customer, foreign } = seeded.groups;
  await step(
    "Nonempty operational reads preserve safe records while excluding raw private payloads",
    async () => {
      for (const reader of operationalReaders.filter(
        (reader) => reader.id !== "calendar",
      )) {
        const response = await api(operatorPage, reader.path);
        assertPublicReaderRows(reader, response, alpha, seeded);
        assertPublicReaderRows(reader, response, beta, seeded);
      }
    },
  );
  await step(
    "Real project and bot filters exclude another authorized project",
    async () => {
      for (const reader of operationalReaders.filter(
        (reader) => reader.id !== "calendar",
      )) {
        for (const scope of [
          { projectId: alpha.projectId },
          { botId: alpha.botId },
          { projectId: alpha.projectId, botId: alpha.botId },
        ]) {
          const response = await api(
            operatorPage,
            scopedReaderPath(reader, scope),
          );
          assertPublicReaderRows(reader, response, alpha, seeded);
          assert(!JSON.stringify(response.body).includes(beta.label));
        }
      }
    },
  );
  await step(
    "Malformed, ambiguous and unsupported read scopes are rejected",
    async () => {
      const cases = [
        [
          "/api/bots/channels?workspaceId=" +
            alpha.workspaceId +
            "&workspaceId=" +
            alpha.workspaceId,
          400,
        ],
        ["/api/approvals?unexpected=true", 400],
        ["/api/bots/actions?botId=invalid", 400],
        ["/api/meetings/oauth/status?projectId=" + alpha.projectId, 400],
        ["/api/bots/actions?projectId=" + foreign.projectId, 403],
        ["/api/approvals?botId=" + foreign.botId, 403],
        [
          "/api/bots/channels?projectId=" +
            alpha.projectId +
            "&botId=" +
            beta.botId,
          403,
        ],
      ];
      for (const [request, status] of cases)
        assert.equal(
          (await api(operatorPage, request)).status,
          status,
          request,
        );
      for (const reader of operationalReaders)
        assert.equal(
          (await api(operatorPage, reader.path, foreign.workspaceId)).status,
          403,
        );
    },
  );
  await step(
    "Managed workspace selection uses the target membership's operational rows",
    async () => {
      await open(operatorPage, accounts.operator.workspaceId, "contacts");
      const workspaceSwitch = operatorPage.getByLabel("Workspace wechseln");
      const details = workspaceSwitch.locator("xpath=ancestor::details[1]");
      if (!(await workspaceSwitch.isVisible()))
        await details.locator("summary").first().click();
      await workspaceSwitch.selectOption(customer.workspaceId);
      await expect(workspaceSwitch).toHaveValue(customer.workspaceId);
      await expect(operatorPage.locator("[data-crm-content]")).toContainText(
        "SYNTHETIC CUSTOMER CONTACT",
      );
      const responses = [];
      const unsupportedHomeRequests = [];
      const requestListener = (request) => {
        const url = new URL(request.url());
        if (
          url.origin === base.origin &&
          [
            "/api/bots/documents",
            "/api/meetings/bookings",
            "/api/meetings/settings",
          ].includes(url.pathname)
        )
          unsupportedHomeRequests.push({
            path: url.pathname,
            method: request.method(),
          });
      };
      const listener = (response) => {
        const url = new URL(response.url());
        if (operationalReaders.some((reader) => reader.path === url.pathname))
          responses.push(url);
      };
      operatorPage.on("response", listener);
      operatorPage.on("request", requestListener);
      try {
        await operatorPage
          .locator(
            "[data-crm-sidebar] [data-crm-nav-item][aria-label='KI-Bots']",
          )
          .click();
        await expect(
          operatorPage.getByRole("navigation", {
            name: "Bot-Arbeitsbereich",
            exact: true,
          }),
        ).toBeVisible();
        for (const reader of operationalReaders.filter(
          (reader) => reader.id !== "calendar",
        )) {
          await expect
            .poll(() =>
              responses.some(
                (url) =>
                  url.pathname === reader.path &&
                  url.searchParams.get("workspaceId") === customer.workspaceId,
              ),
            )
            .toBe(true);
        }
        for (const reader of operationalReaders.filter(
          (reader) => reader.id !== "calendar",
        )) {
          const response = await api(
            operatorPage,
            reader.path,
            customer.workspaceId,
          );
          assertPublicReaderRows(reader, response, customer, seeded);
          assert(!JSON.stringify(response.body).includes(alpha.label));
        }
        const botNavigation = operatorPage.getByRole("navigation", {
          name: "Bot-Arbeitsbereich",
          exact: true,
        });
        await botNavigation
          .getByRole("button", { name: "Gespräche", exact: true })
          .click();
        await expect(operatorPage.locator("[data-crm-content]")).toContainText(
          `${customer.label} MESSAGE`,
        );
        await expect(
          operatorPage.locator("[data-crm-content]"),
        ).not.toContainText(alpha.label);
        await botNavigation
          .getByRole("button", { name: "Automationen", exact: true })
          .click();
        await expect(operatorPage.locator("[data-crm-content]")).toContainText(
          `${customer.label} APPROVAL`,
        );
        await expect(operatorPage.locator("[data-crm-content]")).toContainText(
          `${customer.label} DOCUMENT`,
        );
        await expect(
          operatorPage.locator("[data-crm-content]"),
        ).not.toContainText(seeded.secret);
        await expect(operatorPage.locator("[data-crm-content]")).toContainText(
          "Die Kanal-, Freigabe- und Aktionshistorien sind hier nur lesbar.",
        );
        const approvalButtons = operatorPage.locator(
          ".evelyn-bot-approval button",
        );
        await expect(approvalButtons).toHaveCount(3);
        for (const button of await approvalButtons.all())
          await expect(button).toBeDisabled();
        for (const upload of await operatorPage
          .locator('[data-crm-content] input[type="file"]')
          .all())
          await expect(upload).toBeDisabled();
        await operatorPage.screenshot({
          path: path.join(output, "readers-managed-nonempty-bots-1440.png"),
          fullPage: true,
        });
        await operatorPage
          .locator(
            "[data-crm-sidebar] [data-crm-nav-item][aria-label='Termine']",
          )
          .click();
        await expect
          .poll(() =>
            responses.some(
              (url) =>
                url.pathname === "/api/meetings/oauth/status" &&
                url.searchParams.get("workspaceId") === customer.workspaceId,
            ),
          )
          .toBe(true);
        const calendarPanel = operatorPage
          .getByRole("heading", { name: "Kalender verbinden", exact: true })
          .locator("xpath=ancestor::article[1]");
        await expect(calendarPanel).toContainText(
          "SYNTHETIC READER CUSTOMER CALENDAR",
        );
        await expect(calendarPanel.locator('input[type="email"]')).toHaveCount(
          0,
        );
        await expect(calendarPanel).not.toContainText(
          "Verbindungsstatus derzeit nicht verfügbar.",
        );
        await expect(calendarPanel).not.toContainText(seeded.secret);
        await expect(calendarPanel).toContainText(
          "Kalenderverbindungen sind hier schreibgeschützt.",
        );
        await expect(
          operatorPage.getByRole("button", {
            name: "Neuen Termin anlegen",
            exact: true,
          }),
        ).toBeDisabled();
        await operatorPage
          .getByRole("button", { name: /^Buchungen\s/ })
          .click();
        await expect(operatorPage.locator("[data-crm-content]")).toContainText(
          "Buchungen, Benachrichtigungen und Freigabelinks sind für diesen Workspace hier nicht verfügbar.",
        );
        assert.deepEqual(
          unsupportedHomeRequests,
          [],
          "Managed workspace must not read home-only documents, booking or settings adapters",
        );
        await operatorPage.screenshot({
          path: path.join(output, "readers-managed-nonempty-calendar-1440.png"),
          fullPage: true,
        });
      } finally {
        operatorPage.off("response", listener);
        operatorPage.off("request", requestListener);
      }
    },
  );
  customerPage = await newPage("reader_customer_owner");
  await step(
    "Reader customer owner uses ordinary password and TOTP",
    () => login(customerPage, accounts.customer),
    true,
  );
  await step(
    "Customer reads own operational records and cannot select another tenant",
    async () => {
      for (const reader of operationalReaders) {
        assertPublicReaderRows(
          reader,
          await api(customerPage, reader.path),
          customer,
          seeded,
        );
        assert.equal(
          (await api(customerPage, reader.path, foreign.workspaceId)).status,
          403,
        );
        assert.equal(
          (await api(customerPage, reader.path, alpha.workspaceId)).status,
          403,
        );
      }
    },
  );
  viewerPage = await newPage("reader_viewer");
  await step(
    "Reader viewer signs in normally with existing role-based MFA policy",
    () => login(viewerPage, accounts.viewer),
    true,
  );
  await step(
    "Viewer read permissions and tenant boundaries remain enforced",
    async () => {
      for (const reader of operationalReaders) {
        const response = await api(viewerPage, reader.path);
        if (["approvals", "calendar"].includes(reader.id))
          assert.equal(response.status, 403);
        else {
          assertEmptyReader(reader, response);
          assert(!JSON.stringify(response.body).includes(alpha.label));
          assert(!JSON.stringify(response.body).includes(foreign.label));
          assert(!JSON.stringify(response.body).includes(seeded.secret));
          assert.equal(
            (
              await api(
                viewerPage,
                scopedReaderPath(reader, { projectId: customer.projectId }),
              )
            ).status,
            403,
            "An ungranted viewer project must not become a workspace-wide read",
          );
        }
        assert.equal(
          (await api(viewerPage, reader.path, foreign.workspaceId)).status,
          403,
        );
      }
    },
  );
  await step(
    "Existing owner cookie cannot retain privileges after a real membership downgrade",
    async () => {
      await admin.query(
        "update workspace_users set role='assistant',product_role='viewer' where id=$1",
        [accounts.customer.userId],
      );
      try {
        for (const reader of operationalReaders.filter((reader) =>
          ["approvals", "calendar"].includes(reader.id),
        ))
          assert.equal((await api(customerPage, reader.path)).status, 403);
      } finally {
        await admin.query(
          "update workspace_users set role='owner',product_role='customer_owner' where id=$1",
          [accounts.customer.userId],
        );
      }
    },
  );
  await step(
    "Targeted reader traffic has no HTTP500, browser exception, mutation or observed foreign leak",
    async () => {
      await Promise.all(responseChecks);
      assert.deepEqual(serverErrors, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(outbound, []);
      assert.deepEqual(readerMutations, []);
      assert.deepEqual(privateLeaks, []);
      return {
        serverErrors: 0,
        uncaughtErrors: 0,
        browserOutboundRequests: 0,
        operationalMutations: 0,
      };
    },
  );
}

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
            path: path.join(
              output,
              `${artifactPrefix}failure-${results.length}-${index}.png`,
            ),
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
  if (readersOnly)
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin === base.origin &&
        operationalReaders.some((reader) => reader.path === url.pathname) &&
        request.method() !== "GET"
      )
        readerMutations.push({ path: url.pathname, method: request.method() });
    });
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
        cacheControl: response.headers.get("cache-control"),
      };
    },
    { pathname, workspaceId, body, method },
  );
}

async function login(page, account, negatives = false) {
  await page.goto(new URL("/login", base).href);
  const consent = page.getByRole("button", {
    name: /^(Nur essenzielle|Only necessary)$/,
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
    await expect(page.locator('p[role="alert"]')).toBeVisible();
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
      .filter({ has: page.locator("strong", { hasText: /TOTP-Schlüssel:|TOTP key:/ }) })
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
          .getByRole("button", { name: /^(Sicher bestätigen|Verify securely)$/ })
          .click(),
      ]);
      await expect(page.locator('p[role="alert"]')).toBeVisible();
      assert.equal((await api(page, "/api/crm/core")).status, 401);
      await page.locator("input[name=recoveryCodesSaved]").check();
    }
    await page.locator("#login-mfa-code").fill(totp(secret));
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page
        .getByRole("button", { name: /^(Sicher bestätigen|Verify securely)$/ })
        .click(),
    ]);
  }
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator(".crm-app")).toBeVisible();
  // The regression's German selectors follow a real personal account choice,
  // independent of country headers or obsolete query/browser preferences.
  const language = await api(page, "/api/settings/language", undefined, {
    preference: "de",
    expectedUserId: account.userId,
  });
  assert.equal(language.status, 200, "The ordinary session must save its own account language");
  assert.equal(language.body.persisted, true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
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
      readersOnly
        ? "fixture-private-readers.json"
        : workspaceOnly
          ? "fixture-private-workspace.json"
          : "fixture-private.json",
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
    readersOnly
      ? "Anonymous operational readers deny access"
      : "Anonymous CRM, booking page and Knowledge APIs deny access",
    async () => {
      await operatorPage.goto(new URL("/login", base).href);
      for (const endpoint of [
        "/api/crm/core",
        "/api/knowledge-center",
        "/api/workspaces",
        ...(readersOnly ? operationalReaders.map((reader) => reader.path) : []),
      ])
        assert.equal((await api(operatorPage, endpoint)).status, 401);
      if (!readersOnly) {
        await operatorPage.goto(new URL("/booking", base).href);
        await expect(operatorPage).toHaveURL(/\/login(?:\?|$)/);
        await expect(operatorPage.getByRole("heading", { name: "Terminbuchung", exact: true })).toHaveCount(0);
      }
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
  if (readersOnly) {
    await verifyOperationalReaders();
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
    "Every operator navigation button retains Design C and the booking link returns to the CRM calendar",
    async () => {
      await open(operatorPage, accounts.operator.workspaceId);
      const nav = operatorPage.locator("[data-crm-sidebar] [data-crm-nav]");
      const entries = await nav
        .locator("[data-crm-nav-item]")
        .evaluateAll((elements) =>
          elements.map((element) => ({
            label: element.getAttribute("aria-label") || element.textContent.trim(),
            tag: element.tagName.toLowerCase(),
            href: element.getAttribute("href"),
          })),
        );
      assert(
        entries.length >= 6,
        "Expected real role-authorized CRM navigation",
      );
      assert.deepEqual(entries.filter(entry => entry.tag === "a"), [
        { label: "Terminbuchung", tag: "a", href: "/booking" },
      ], "The authorized operator has exactly the explicit booking-page link");
      const visited = [];
      for (const { label, tag, href } of entries) {
        if (tag === "a") {
          assert.equal(href, "/booking");
          await nav.getByRole("link", { name: label, exact: true }).click();
          await expect(operatorPage).toHaveURL(new URL("/booking", base).href);
          await expect(operatorPage.getByRole("heading", { name: "Terminbuchung", exact: true })).toBeVisible();
          const back = operatorPage.getByRole("link", { name: "Zurück zum CRM", exact: true });
          await expect(back).toHaveAttribute("href", "/#meetings");
          await back.click();
          // The CRM may add its current scope query during hydration; the
          // backlink's path/hash and any restored scope must stay exact.
          await expect(operatorPage).toHaveURL(url => url.origin === base.origin && url.pathname === "/" && url.hash === "#meetings" &&
            (url.searchParams.get("workspaceId") ?? accounts.operator.workspaceId) === accounts.operator.workspaceId &&
            (url.searchParams.get("projectId") ?? "all") === "all");
          await themeAndLayout(operatorPage);
          await expect(nav.locator('button[aria-current="page"]')).toHaveCount(1);
          visited.push({ label, href, returnHash: new URL(operatorPage.url()).hash });
          continue;
        }
        assert.equal(tag, "button", `Unsupported role-authorized navigation element: ${label}`);
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
      await customerPage.route("**/api/bots/chat**", handler);
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
        await customerPage.unroute("**/api/bots/chat**", handler);
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
      const review = card.getByTestId("knowledge-lifecycle");
      await expect(review).toBeVisible();
      await expect(review).toContainText("designcprivatepdf");
      await expect(review.getByTestId("knowledge-submit")).toBeDisabled();
      for (const action of ["submit", "review", "approve", "publish"]) {
        const button = review.getByTestId(`knowledge-${action}`);
        await expect(button).toBeVisible();
        await review.locator("form textarea").first().fill(
          "SYNTHETIC Design C: extracted private document fully reviewed",
        );
        if (action !== "submit") {
          await expect(button).toBeDisabled();
          await review.getByRole("checkbox", {
            name: "Ich habe den Inhalt vollständig geprüft.",
            exact: true,
          }).check();
        }
        await expect(button).toBeEnabled();
        await button.click();
        await expect(button).toHaveCount(0);
      }
      await expect(
        card.getByText("Für Assistenten aktive Version", { exact: true }).first(),
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
    scope: readersOnly
      ? "focused-operational-readers"
      : workspaceOnly
        ? "focused-workspace-studio"
        : "whole-integration",
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
    ...(readersOnly ? { readerMutations } : {}),
    responseInspectionErrors,
    consoleErrors,
    limitations: [
      "Production target isolation relies on the required qa:sales:server disposable loopback database and environment allowlist; browser routing observes browser outbound traffic, not server-side provider IO.",
      "Passive browser body inspection records stale/cancelled or unavailable bodies separately. Explicit role and tenant checks inspect consumed API JSON; passive inspection alone is not proof of every response body.",
      "The isolated fixture applies unchanged pinned 091–096 and 100–106, including package-3 workflow/monitoring and operational readers, plus additive account-language migration 110 for the current browser runtime; optional pgvector, historical manual media migration 062 and preview migrations 097–099 remain excluded. This is not a full production migration proof.",
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
