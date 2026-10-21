import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, expect as playwrightExpect } from "@playwright/test";

// Run against the isolated static preview, never the production CRM.
const base = new URL(process.env.DESIGN_C_BASE_URL || "http://127.0.0.1:3190");
const output = fileURLToPath(new URL("../verification/", import.meta.url));
const require = createRequire(import.meta.url);
const checks = [],
  axe = [],
  errors = [],
  consoleErrors = [],
  nonStaticRequests = [],
  failedResponses = [];
const views = [
  ["dashboard", "Dashboard", "Alles verbunden."],
  ["customers", "Kunden & Mandanten", "Kunden & Kontakte"],
  ["tenants", "Kunden & Mandanten", "Mandanten"],
  ["studio", "Websites & Studio", "Von der Idee zum Erlebnis."],
  ["properties", "Immobilien", "Lebensräume. Klar im Blick."],
  ["assistants", "KI-Assistenten", "Hilfreich. Im richtigen Kontext."],
  ["knowledge", "Knowledge Center", "Gutes Wissen. Gute Antworten."],
  ["activity", "Evelyn Activity Center", "Evelyn Activity Center"],
  ["components", "Designsystem", "Eine gemeinsame Grundlage."],
  ["settings", "Einstellungen", "Einstellungen"],
];
let browser, page;
await mkdir(output, { recursive: true });
for (const file of await readdir(output)) {
  if (/^failure-\d+\.png$/.test(file)) await rm(path.join(output, file));
}
const expect = playwrightExpect.configure({ timeout: 4500 });

async function check(name, run) {
  try {
    const detail = await run();
    checks.push({
      name,
      passed: true,
      ...(detail === undefined ? {} : { detail }),
    });
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message.split("\n")[0]}`);
    if (page && !page.isClosed())
      await page
        .screenshot({
          path: path.join(output, `failure-${checks.length}.png`),
          fullPage: true,
        })
        .catch(() => {});
  }
}

async function fresh(width = 1440, height = 1000) {
  await page.setViewportSize({ width, height });
  await page.goto(base.href, { waitUntil: "networkidle" });
  await expect(page.locator(".design-c")).toBeVisible();
  await expect(page.locator("main h1")).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
}

async function navigate(id) {
  const entry = views.find((item) => item[0] === id);
  assert(entry, `Unknown view ${id}`);
  if (
    await page
      .getByRole("button", { name: "Mobile Navigation öffnen", exact: true })
      .isVisible()
  ) {
    await page
      .getByRole("button", { name: "Mobile Navigation öffnen", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Navigation", exact: true })
      .getByRole("button", { name: entry[1], exact: true })
      .click();
  } else {
    await page
      .locator(".dc-rail")
      .getByRole("button", { name: entry[1], exact: true })
      .click();
  }
  if (id === "tenants")
    await page
      .getByRole("button", { name: "Mandantenübersicht öffnen", exact: true })
      .click();
  await expect(page.locator("main h1")).toHaveText(entry[2]);
  await expect(
    page.getByRole("dialog", { name: "Navigation", exact: true }),
  ).not.toBeVisible();
}

async function noOverflow() {
  const measurement = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    offenders: Array.from(document.querySelectorAll("main *"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          (rect.right > innerWidth + 1 || rect.left < -1) &&
          !element.closest(".dc-table-scroll, .dc-tabs")
        );
      })
      .slice(0, 5)
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        text: element.textContent.slice(0, 70),
      })),
  }));
  assert(
    measurement.document <= measurement.viewport + 1 &&
      measurement.body <= measurement.viewport + 1,
    `Horizontal document overflow: ${JSON.stringify(measurement)}`,
  );
  return { viewport: measurement.viewport, document: measurement.document };
}

function contrastRatio(first, second) {
  function luminance(color) {
    const rgb = color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number);
    assert.equal(rgb?.length, 3, `Unsupported computed color: ${color}`);
    const [red, green, blue] = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  }
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function accessibility(name) {
  if (!(await page.evaluate(() => Boolean(window.axe))))
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const result = await page.evaluate(async () => {
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
        help: item.help,
        nodes: item.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      })),
      passes: result.passes.length,
      incomplete: result.incomplete.map((item) => ({
        id: item.id,
        nodes: item.nodes.length,
      })),
    };
  });
  axe.push({ name, ...result });
  assert.equal(
    result.violations.length,
    0,
    `axe violations in ${name}: ${result.violations.map((item) => `${item.id} (${item.nodes.length})`).join(", ")}`,
  );
  return { passes: result.passes, incomplete: result.incomplete };
}

async function dialogKeyboard(trigger, title) {
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog).toBeVisible();
  assert(
    await dialog.evaluate(
      (element) =>
        element instanceof HTMLDialogElement && element.matches(":modal"),
    ),
    "Dialog must use native showModal",
  );
  const controls = await dialog
    .locator(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
    )
    .count();
  for (let index = 0; index < controls + 2; index++) {
    await page.keyboard.press("Tab");
    // Chromium can hand focus to browser chrome between cycles (activeElement
    // becomes body). No background page control may receive keyboard focus.
    assert(
      await dialog.evaluate(
        (element) =>
          element.contains(document.activeElement) ||
          document.activeElement === document.body,
      ),
      "Tab reached a background page control",
    );
  }
  await page.keyboard.press("Shift+Tab");
  assert(
    await dialog.evaluate(
      (element) =>
        element.contains(document.activeElement) ||
        document.activeElement === document.body,
    ),
    "Reverse Tab reached a background page control",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  return {
    native: true,
    escape: true,
    focusTrapped: true,
    focusRestored: true,
  };
}

try {
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: "de-AT",
  });
  page.setDefaultTimeout(6000);
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Record any attempted boundary violation and prevent it reaching a service.
    if (
      !["data:", "blob:"].includes(url.protocol) &&
      (url.origin !== base.origin ||
        request.method() !== "GET" ||
        /^\/api(?:\/|$)/.test(url.pathname))
    )
      return route.abort("blockedbyclient");
    return route.continue();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      !["data:", "blob:"].includes(url.protocol) &&
      (url.origin !== base.origin ||
        request.method() !== "GET" ||
        /^\/api(?:\/|$)/.test(url.pathname))
    ) {
      nonStaticRequests.push({
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
      });
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      failedResponses.push({ status: response.status(), url: response.url() });
  });

  for (const width of [1440, 1920, 360, 390, 768]) {
    await fresh(width, width < 768 ? 844 : 1050);
    for (const [id] of views) {
      await check(`${id}: navigation and layout at ${width}px`, async () => {
        await navigate(id);
        const dimensions = await noOverflow();
        if (
          id === "dashboard" ||
          (width === 1440 &&
            !["tenants", "activity", "settings"].includes(id)) ||
          (width === 390 && ["properties", "knowledge"].includes(id))
        ) {
          await page.screenshot({
            path: path.join(output, `${id}-${width}.png`),
            fullPage: true,
          });
        }
        return dimensions;
      });
      if (
        width === 1440 ||
        (width === 390 && ["dashboard", "knowledge"].includes(id))
      ) {
        await check(`${id}: axe at ${width}px`, () =>
          accessibility(`${id}-${width}`),
        );
      }
    }
  }

  await check(
    "Native notification dialog: Escape, keyboard trap and focus return",
    async () => {
      await fresh();
      return dialogKeyboard(
        page.getByRole("button", {
          name: "Demo-Benachrichtigungen öffnen",
          exact: true,
        }),
        "Benachrichtigungen · Demo",
      );
    },
  );

  await check(
    "Native chat dialog: Escape, keyboard trap and focus return",
    async () => {
      await fresh();
      return dialogKeyboard(
        page.getByRole("button", {
          name: "Evelyn Chat-Vorschau öffnen",
          exact: true,
        }),
        "Mit Evelyn sprechen · Vorschau",
      );
    },
  );

  await check(
    "Native preview-action dialog: Escape, keyboard trap and focus return",
    async () => {
      await fresh();
      await navigate("components");
      return dialogKeyboard(
        page.getByRole("button", { name: /Primäre Aktion/, exact: false }),
        "Primäre Aktion · Vorschau",
      );
    },
  );

  await check(
    "Mobile drawer: native modal, Escape, focus return and navigation",
    async () => {
      await fresh(390, 844);
      const trigger = page.getByRole("button", {
        name: "Mobile Navigation öffnen",
        exact: true,
      });
      const detail = await dialogKeyboard(trigger, "Navigation");
      await trigger.click();
      const dialog = page.getByRole("dialog", {
        name: "Navigation",
        exact: true,
      });
      await expect(
        dialog.getByRole("navigation", {
          name: "CRM-Hauptnavigation",
          exact: true,
        }),
      ).toBeVisible();
      await dialog
        .getByRole("button", { name: "Knowledge Center", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      await expect(page.locator("main h1")).toHaveText(
        "Gutes Wissen. Gute Antworten.",
      );
      return detail;
    },
  );

  await check(
    "Global search opens matching area and has a useful empty state",
    async () => {
      await fresh();
      const search = page.getByRole("textbox", {
        name: "Bereich suchen",
        exact: true,
      });
      await search.fill("does-not-exist");
      await expect(
        page.getByText("Kein Bereich gefunden.", { exact: true }),
      ).toBeVisible();
      await search.fill("Knowledge");
      await search.press("Enter");
      await expect(page.locator("main h1")).toHaveText(
        "Gutes Wissen. Gute Antworten.",
      );
      await expect(search).toHaveValue("");
    },
  );

  await check(
    "Gallery form validates fields, recovers and opens local preview only",
    async () => {
      await fresh();
      await navigate("components");
      await expect(page.locator("main p p")).toHaveCount(0);
      const name = page.getByRole("textbox", { name: "Name", exact: true });
      const email = page.getByRole("textbox", { name: "E-Mail", exact: true });
      await page
        .getByRole("button", { name: "Beispiel prüfen", exact: true })
        .click();
      await expect(name).toHaveAttribute("aria-invalid", "true");
      await expect(email).toHaveAttribute("aria-invalid", "true");
      await expect(
        page.getByText("Bitte einen Namen eingeben.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Bitte eine gültige E-Mail-Adresse eingeben.", {
          exact: true,
        }),
      ).toBeVisible();
      for (const field of [name, email]) {
        const description = await field.getAttribute("aria-describedby");
        assert(description, "Validation must be associated with its field");
        await expect(page.locator(`[id="${description}"]`)).toBeVisible();
      }
      await name.fill("Demo Browserprüfung");
      await email.fill("invalid");
      await page
        .getByRole("button", { name: "Beispiel prüfen", exact: true })
        .click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await email.fill("browser@example.com");
      await page
        .getByRole("button", { name: "Beispiel prüfen", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", {
          name: "Formular prüfen · Vorschau",
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(name).toHaveAttribute("aria-invalid", "false");
      await expect(email).toHaveAttribute("aria-invalid", "false");
      await page.getByRole("button", { name: "Fehler", exact: true }).click();
      await expect(
        page.getByText("Beispielfehler: Daten konnten nicht geladen werden.", {
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Beispiel zurücksetzen", exact: true })
        .click();
      await expect(
        page.getByText("Noch keine Dokumente", { exact: true }),
      ).toBeVisible();
    },
  );

  await check(
    "Table: search, numeric sorting, status, pagination, reset and page bounds",
    async () => {
      await fresh();
      await navigate("components");
      const table = page.locator(".dc-data-table");
      const rows = table.locator("tbody tr");
      const search = table.getByRole("searchbox");
      const filter = table.getByRole("combobox", {
        name: "Nach Status filtern",
        exact: true,
      });
      const next = table.getByRole("button", {
        name: "Nächste Seite",
        exact: true,
      });
      const reset = table.getByRole("button", {
        name: "Zurücksetzen",
        exact: true,
      });
      await expect(rows).toHaveCount(6);
      await expect(rows.first()).toContainText("Demoprojekt 01");
      await expect(reset).toBeDisabled();
      await next.click();
      await next.click();
      await expect(table).toContainText("Seite 3 von 3");
      await expect(rows).toHaveCount(2);
      await expect(next).toBeDisabled();
      await search.fill("Demoprojekt 14");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("Demoprojekt 14");
      await expect(table).toContainText("Seite 1 von 1");
      await reset.click();
      await expect(rows).toHaveCount(6);
      const sort = table.getByRole("button", { name: /Projekt.*sortieren/ });
      await sort.click();
      await expect(table.locator("th").first()).toHaveAttribute(
        "aria-sort",
        "ascending",
      );
      await expect(rows.first()).toContainText("Demoprojekt 01");
      await sort.click();
      await expect(table.locator("th").first()).toHaveAttribute(
        "aria-sort",
        "descending",
      );
      await expect(rows.first()).toContainText("Demoprojekt 14");
      await sort.click();
      await expect(table.locator("th").first()).toHaveAttribute(
        "aria-sort",
        "none",
      );
      await filter.selectOption("Aktiv");
      await expect(table).toContainText("von 7 Einträgen");
      await next.click();
      await expect(rows).toHaveCount(1);
      await filter.selectOption("In Bearbeitung");
      await expect(table).toContainText("Seite 1 von 2");
      await expect(rows).toHaveCount(6);
      await search.fill("Webchat");
      await expect(rows).toHaveCount(0);
      await expect(table).toContainText("Keine Einträge gefunden.");
      await expect(table).toContainText("Seite 1 von 1");
      await expect(
        table.getByRole("button", { name: "Vorherige Seite", exact: true }),
      ).toBeDisabled();
      await expect(next).toBeDisabled();
      await reset.click();
      await expect(search).toHaveValue("");
      await expect(filter).toHaveValue("");
      await expect(rows.first()).toContainText("Demoprojekt 01");
      await expect(reset).toBeDisabled();
      return {
        records: 14,
        pageSize: 6,
        emptyState: true,
        latePageReset: true,
      };
    },
  );

  await check(
    "Demo context switch clears chat, search and unsaved assistant edits",
    async () => {
      await fresh();
      await page
        .getByRole("button", {
          name: "Evelyn Chat-Vorschau öffnen",
          exact: true,
        })
        .click();
      await page
        .getByRole("textbox", { name: "Beispielfrage an Evelyn", exact: true })
        .fill("CONTEXT-RESET-BROWSER-MARKER");
      await page
        .getByRole("button", { name: "Beispielfrage senden", exact: true })
        .click();
      await expect(page.getByRole("log")).toContainText(
        "CONTEXT-RESET-BROWSER-MARKER",
      );
      await page.keyboard.press("Escape");
      await navigate("assistants");
      await page
        .getByRole("group", { name: /Assistent/ })
        .getByRole("button", { name: "Konfiguration", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Anzeigename", exact: true })
        .fill("UNSAVED-ASSISTANT-BROWSER-MARKER");
      await page
        .getByRole("textbox", { name: "Bereich suchen", exact: true })
        .fill("Studio");
      await page
        .getByRole("combobox", { name: "Demo-Mandant auswählen", exact: true })
        .selectOption("demo-developer");
      await expect(page.locator("main")).toContainText("Parkquartier · Demo");
      await expect(page.locator("main")).not.toContainText(
        "Novalure Studio · Demo",
      );
      await expect(
        page.getByRole("textbox", { name: "Bereich suchen", exact: true }),
      ).toHaveValue("");
      await expect(page.locator(".design-c")).not.toContainText(
        "CONTEXT-RESET-BROWSER-MARKER",
      );
      await page
        .getByRole("button", {
          name: "Evelyn Chat-Vorschau öffnen",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("dialog", {
          name: "Mit Evelyn sprechen · Vorschau",
          exact: true,
        }),
      ).toContainText("Parkquartier · Demo");
      await expect(page.getByRole("log")).not.toContainText(
        "CONTEXT-RESET-BROWSER-MARKER",
      );
      await page.keyboard.press("Escape");
      await navigate("assistants");
      await page
        .getByRole("group", { name: /Assistent/ })
        .getByRole("button", { name: "Konfiguration", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "Anzeigename", exact: true }),
      ).not.toHaveValue("UNSAVED-ASSISTANT-BROWSER-MARKER");
      await expect(page.locator("main")).not.toContainText(
        "Novalure Studio · Demo",
      );
    },
  );

  await check(
    "Studio offers: filter options match the visible business status",
    async () => {
      await fresh();
      await navigate("studio");
      await page
        .getByRole("group", { name: "Studio-Bereiche", exact: true })
        .getByRole("button", { name: "Angebote", exact: true })
        .click();
      const table = page.locator(".dc-data-table");
      const filter = table.getByRole("combobox", {
        name: "Nach Status filtern",
        exact: true,
      });
      await filter.selectOption("Offen");
      await expect(table.locator("tbody tr")).toHaveCount(1);
      await expect(table.locator("tbody tr").first()).toContainText(
        "Offen · Demo",
      );
      await expect(table.locator("tbody tr").first()).toContainText(
        "ANG-demo-studio-01",
      );
      await filter.selectOption("Angenommen");
      await expect(table.locator("tbody tr")).toHaveCount(1);
      await expect(table.locator("tbody tr").first()).toContainText(
        "Angenommen · Demo",
      );
      await expect(table.locator("tbody tr").first()).toContainText(
        "ANG-demo-studio-02",
      );
    },
  );

  await check(
    "Studio amounts sort numerically across German thousands formatting",
    async () => {
      await fresh();
      await navigate("studio");
      await page
        .getByRole("group", { name: "Studio-Bereiche", exact: true })
        .getByRole("button", { name: "Angebote", exact: true })
        .click();
      const table = page.locator(".dc-data-table");
      const amount = table.getByRole("button", {
        name: /Wert netto.*sortieren/,
      });
      await amount.click();
      await expect(table.locator("tbody tr").first()).toContainText("€ 490");
      await expect(table.locator("tbody tr").first()).toContainText(
        "ANG-demo-studio-02",
      );
      await amount.click();
      await expect(table.locator("tbody tr").first()).toContainText("€ 8.400");
      await expect(table.locator("tbody tr").first()).toContainText(
        "ANG-demo-studio-01",
      );
      return { ascending: [490, 8400], descending: [8400, 490] };
    },
  );

  for (const [workspace, propertyVisible] of [
    ["demo-studio", false],
    ["demo-developer", true],
    ["demo-broker", true],
    ["demo-company", false],
  ]) {
    await check(
      `Portal scope and module visibility: ${workspace}`,
      async () => {
        await fresh(390, 844);
        await page
          .getByRole("combobox", {
            name: "Demo-Mandant auswählen",
            exact: true,
          })
          .selectOption(workspace);
        await page
          .getByRole("button", { name: "Kundenportal zeigen", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: "Mobile Navigation öffnen",
            exact: true,
          })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "Navigation",
          exact: true,
        });
        const nav = dialog.getByRole("navigation", {
          name: "Kundenportal-Navigation",
          exact: true,
        });
        await expect(nav).toBeVisible();
        for (const label of [
          "Kunden & Mandanten",
          "Vertrieb",
          "Marketing",
          "Organisation",
          "Finanzen",
          "Designsystem",
        ])
          await expect(dialog.getByText(label, { exact: true })).toHaveCount(0);
        await expect(
          nav.getByRole("button", { name: "Meine Immobilien", exact: true }),
        ).toHaveCount(propertyVisible ? 1 : 0);
        await nav
          .getByRole("button", { name: "Wissensverwaltung", exact: true })
          .click();
        await expect(page.locator("main h1")).toHaveText(
          "Ihr freigegebenes Wissen",
        );
        for (const label of [
          "AI-Wissen",
          "Website-Scans",
          "AI-Vorschläge",
          "Freigabe vorbereiten",
          "Wissen hinzufügen",
        ])
          await expect(
            page.locator("main").getByText(label, { exact: true }),
          ).toHaveCount(0);
        await expect(
          page.locator("main").getByRole("combobox", {
            name: "Wissensstatus filtern",
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(page.locator("main")).not.toContainText(
          "Lokaler Beispielentwurf",
        );
        return noOverflow();
      },
    );
  }

  await check(
    "Keyboard focus rings contrast with their actual light and dark surfaces",
    async () => {
      await fresh();
      const measurements = [];
      for (const theme of ["light", "dark"]) {
        if (theme === "dark")
          await page
            .getByRole("button", {
              name: "Dunklen Modus einschalten",
              exact: true,
            })
            .click();
        for (const [control, surface] of [
          [".dc-logo", ".dc-rail"],
          [".dc-prompt-launch", ".dc-intelligence"],
          [".dc-chat-launcher", ".design-c"],
        ]) {
          await page.keyboard.press("Tab");
          const target = page.locator(control);
          await target.focus();
          const outline = await target.evaluate((element) => {
            const css = getComputedStyle(element);
            return {
              color: css.outlineColor,
              width: parseFloat(css.outlineWidth),
              style: css.outlineStyle,
              visible: element.matches(":focus-visible"),
            };
          });
          const background = await page
            .locator(surface)
            .evaluate((element) => getComputedStyle(element).backgroundColor);
          assert(
            outline.visible && outline.style !== "none" && outline.width >= 2,
            `Missing visible keyboard focus for ${control} in ${theme}`,
          );
          const ratio = contrastRatio(outline.color, background);
          assert(
            ratio >= 3,
            `${control} focus contrast ${ratio.toFixed(2)}:1 in ${theme}; expected at least 3:1`,
          );
          measurements.push({
            theme,
            control,
            ratio: Number(ratio.toFixed(2)),
          });
        }
      }
      return measurements;
    },
  );

  await check(
    "Dark appearance changes computed colors and retains accessible settings",
    async () => {
      await fresh();
      await navigate("settings");
      const light = await page
        .locator(".design-c")
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      await page
        .getByRole("button", { name: "Dunklen Modus einschalten", exact: true })
        .click();
      await expect(page.locator(".design-c")).toHaveAttribute(
        "data-theme",
        "dark",
      );
      const dark = await page
        .locator(".design-c")
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      assert.notEqual(dark, light, "Dark theme must change rendered colors");
      await page.screenshot({
        path: path.join(output, "settings-dark-1440.png"),
        fullPage: true,
      });
      await accessibility("settings-dark-1440");
      await page
        .getByRole("button", { name: "Light Mode aktivieren", exact: true })
        .click();
      await expect(page.locator(".design-c")).toHaveAttribute(
        "data-theme",
        "light",
      );
      return { light, dark };
    },
  );

  await check(
    "Reduced motion disables transitions and animated hover movement",
    async () => {
      await fresh();
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert(
        await page.evaluate(
          () => matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      );
      const moving = await page.locator(".design-c").evaluate((root) =>
        Array.from(root.querySelectorAll("*"))
          .filter((element) => {
            const css = getComputedStyle(element);
            return [
              ...css.transitionDuration.split(","),
              ...css.animationDuration.split(","),
            ].some((duration) => parseFloat(duration) > 0.001);
          })
          .map((element) => element.className),
      );
      assert.deepEqual(
        moving,
        [],
        "Motion remains active with reduced-motion preference",
      );
      const button = page.getByRole("button", {
        name: "Kundenportal zeigen",
        exact: true,
      });
      await button.hover();
      assert.equal(
        await button.evaluate((element) => getComputedStyle(element).transform),
        "none",
      );
      await page.emulateMedia({ reducedMotion: "no-preference" });
    },
  );

  await check(
    "Runtime and network boundary: no errors, external/API or write requests",
    async () => {
      assert.deepEqual(errors, [], "Uncaught browser errors");
      assert.deepEqual(consoleErrors, [], "Browser console errors");
      assert.deepEqual(failedResponses, [], "Failed resource responses");
      assert.deepEqual(
        nonStaticRequests,
        [],
        "Preview issued non-static requests",
      );
      return {
        uncaughtErrors: errors.length,
        consoleErrors: consoleErrors.length,
        failedResponses: failedResponses.length,
        nonStaticRequests: nonStaticRequests.length,
      };
    },
  );
} catch (error) {
  checks.push({
    name: "Browser setup or navigation",
    passed: false,
    error: error.stack || error.message,
  });
} finally {
  await browser?.close();
  const failed = checks.filter((check) => !check.passed);
  const report = {
    base: base.href,
    generatedAt: new Date().toISOString(),
    browser: "Chromium",
    summary: {
      passed: checks.length - failed.length,
      failed: failed.length,
      axeScans: axe.length,
    },
    checks,
    axe,
    errors,
    consoleErrors,
    nonStaticRequests,
    failedResponses,
  };
  await writeFile(
    path.join(output, "browser-results.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        ...report.summary,
        failures: failed.map((check) => ({
          name: check.name,
          error: check.error.split("\n")[0],
        })),
        report: path.join(output, "browser-results.json"),
      },
      null,
      2,
    ),
  );
  if (failed.length) process.exitCode = 1;
}
