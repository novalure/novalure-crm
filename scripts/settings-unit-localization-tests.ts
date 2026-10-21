import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReservationBoard } from "../src/components/reservation-board";
import type { PropertyReservation } from "../src/lib/crm-types";
import {
  getCompanyProfileFieldLabel,
  getCompanyProfileIssueLabel,
  getCompanyProfileSettingsCopy,
  getCompanySettingsFeedback,
} from "../src/components/company-profile-settings";
import { getUnitBoardErrorMessage, getUnitBoardFeedbackCopy } from "../src/lib/unit-board-feedback";
import { getPropertyCoreObjectTypeLabel } from "../src/components/property-core-editor";

test("company settings provide paired labels for roles, statuses, uses and history", () => {
  const de = getCompanyProfileSettingsCopy("de");
  const en = getCompanyProfileSettingsCopy("en");
  for (const key of ["usageLabels", "statuses", "workspaceRoles", "roles", "actions"] as const) {
    assert.deepEqual(Object.keys(de[key]).sort(), Object.keys(en[key]).sort());
    assert.ok(Object.values(de[key]).every(Boolean));
    assert.ok(Object.values(en[key]).every(Boolean));
  }
  assert.equal(en.roles.team_member, "Team member");
  assert.equal(en.roles.developer_sales, "Project sales lead");
  assert.equal(en.usageLabels.botDisclosures, "AI assistant disclosures");
  assert.equal(en.statuses.needs_review, "Review required");
  assert.equal(getCompanyProfileFieldLabel("usageSettings", "en"), "Usage");
  assert.equal(getCompanyProfileFieldLabel("unknown_internal_field", "en"), en.otherFields);
});

test("settings feedback preserves actionable password and access failures without displaying raw errors", () => {
  for (const language of ["de", "en"] as const) {
    const text = getCompanyProfileSettingsCopy(language);
    assert.equal(getCompanySettingsFeedback("saved", language).message, text.saved);
    assert.equal(getCompanySettingsFeedback("saved", language).error, false);
    assert.equal(getCompanySettingsFeedback("password_mismatch", language).message, text.passwordMismatch);
    assert.equal(getCompanySettingsFeedback("current_password_invalid", language).message, text.currentPasswordInvalid);
    assert.equal(getCompanySettingsFeedback("forbidden", language).message, text.forbidden);
    assert.equal(getCompanySettingsFeedback("INTERNAL_QUERY_FAILED /private/path", language).message, text.actionFailed);
    assert.equal(getCompanySettingsFeedback("INTERNAL_QUERY_FAILED /private/path", language).error, true);
    assert.equal(getCompanySettingsFeedback("Password changed; sign in again", language).message, text.signInAfterPassword);
  }
});

test("company preflight translations preserve licence and approval requirements", () => {
  const licence = { field: "licenses.realEstate", severity: "blocker" as const, message: "Erlaubnis nach Paragraph 34c GewO fehlt." };
  assert.match(getCompanyProfileIssueLabel(licence, "en"), /34c GewO.*required/);
  assert.match(getCompanyProfileIssueLabel(licence, "de"), /34c GewO.*fehlt/);
  assert.match(getCompanyProfileIssueLabel({ ...licence, message: "PSRA licence information fehlt." }, "en"), /PSRA licence.*required/);
  assert.equal(getCompanyProfileIssueLabel({ field: "status", usage: "portalExport", severity: "blocker", message: "Freigabe fehlt für portalExport." }, "en"), "Approval required for: Portal export.");
  assert.equal(getCompanyProfileIssueLabel({ field: "publicEmail", severity: "warning", message: "Öffentliche E-Mail ist formal ungültig." }, "en"), "Check the public email address.");
});

test("unit failures keep drafts recoverable and distinguish saved refresh failures from unconfirmed changes", () => {
  for (const language of ["de", "en"] as const) {
    const text = getUnitBoardFeedbackCopy(language);
    assert.equal(getUnitBoardErrorMessage(language, new Error("Database failure at internal-host")), text.unconfirmed);
    assert.equal(getUnitBoardErrorMessage(language, new Error("VERSION_CONFLICT")), text.conflict);
    assert.equal(getUnitBoardErrorMessage(language, new Error("Unauthorized")), text.session);
    assert.notEqual(text.refreshFailed, text.unconfirmed);
    assert.match(text.priceConfirmation, language === "de" ? /Preis/ : /price/);
  }
});

test("property type display labels translate existing stored enum values", () => {
  assert.equal(getPropertyCoreObjectTypeLabel("Wohnung", "de"), "Wohnung");
  assert.equal(getPropertyCoreObjectTypeLabel("Wohnung", "en"), "Apartment");
  assert.equal(getPropertyCoreObjectTypeLabel("Grundstück", "en"), "Land");
  assert.equal(getPropertyCoreObjectTypeLabel("Gewerbe", "en"), "Commercial property");
});

test("reservation rendering labels a missing unit without displaying its stored identifier", () => {
  const reservation: PropertyReservation = {
    id: "reservation-fixture", workspaceId: "workspace-fixture", projectId: "project-fixture",
    unitId: "f8440c5b-144f-44ae-83d9-bc846b58c8da", contactId: "contact-fixture", status: "requested",
    expiresAt: "2030-10-21T12:00:00.000Z", depositCents: 0, contractMilestone: "not_started", nextAction: "",
  };
  for (const language of ["de", "en"] as const) {
    const html = renderToStaticMarkup(createElement(ReservationBoard, {
      contacts: [], deals: [], language, onOpenUnits() {}, projectLabel: "Selected company", projects: [], reservations: [reservation], units: [],
    }));
    assert.match(html, language === "de" ? /Einheit nicht verfügbar/ : /Unit unavailable/);
    assert.ok(!html.includes(reservation.unitId));
  }
  assert.equal(reservation.unitId, "f8440c5b-144f-44ae-83d9-bc846b58c8da");
});
