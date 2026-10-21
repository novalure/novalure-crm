import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanyProfileIssueList } from "../src/components/company-profile-settings";
import type { CompanyProfilePreflightIssue } from "../src/lib/crm-types";

test("English company preflight renders localized issue bodies from a German repository fixture", () => {
  const issues: CompanyProfilePreflightIssue[] = [
    { field: "publicEmail", message: "Öffentliche E-Mail ist formal ungültig.", severity: "blocker" },
    { field: "legalName", message: "Firmenname fehlt.", severity: "blocker" },
    { field: "vatId", message: "VAT/UID passt nicht zum ausgewählten Land.", severity: "warning" },
    { field: "licenses.realEstate", message: "Erlaubnis nach Paragraph 34c GewO fehlt.", severity: "blocker" },
    { field: "usageSettings", message: "Freigabe für Formulare fehlt.", severity: "warning", usage: "forms" },
  ];
  const html = renderToStaticMarkup(createElement(CompanyProfileIssueList, { issues, language: "en" }));
  for (const expected of [
    "Check the public email address.",
    "Company name is required.",
    "The VAT ID does not match the selected country.",
    "A licence under section 34c GewO is required.",
    "Approval required for: Forms.",
  ]) assert.ok(html.includes(expected), `Rendered warning is missing: ${expected}`);
  for (const issue of issues) assert.ok(!html.includes(issue.message), "German source messages must not appear in the English rendered issue body");
  assert.equal((html.match(/<p /g) ?? []).length, issues.length, "localization must retain every blocker and warning");
  assert.match(html, /border-amber-200/);
  assert.match(html, /border-blue-200/);
});
