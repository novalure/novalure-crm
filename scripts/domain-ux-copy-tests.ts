import assert from "node:assert/strict";
import test from "node:test";
import { getKnowledgeCenterCopy, getKnowledgeErrorMessage } from "../src/lib/knowledge-center/copy";

test("knowledge failures keep internal service details out of user feedback in both CRM languages", () => {
  for (const language of ["de", "en"] as const) {
    const fallback = getKnowledgeCenterCopy(language).saveError;
    for (const cause of [
      new Error("Database connection failed at postgres://internal-host/customer"),
      new TypeError("Failed to fetch /api/knowledge-center/workflow"),
      "UNKNOWN_INTERNAL_ERROR_KEY",
      { error: "private implementation detail" },
    ]) {
      assert.equal(getKnowledgeErrorMessage(language, cause, fallback), fallback);
    }
  }
});

test("known knowledge conflicts and access failures give localized next steps", () => {
  for (const language of ["de", "en"] as const) {
    const fallback = getKnowledgeCenterCopy(language).saveError;
    const conflict = getKnowledgeErrorMessage(language, new Error("VERSION_CONFLICT"), fallback);
    const access = getKnowledgeErrorMessage(language, new Error("FORBIDDEN"), fallback);
    assert.notEqual(conflict, fallback);
    assert.notEqual(access, fallback);
    assert.match(conflict, language === "de" ? /Aktualisieren/ : /Refresh/);
    assert.match(access, language === "de" ? /Berechtigungen/ : /permissions/);
    assert.doesNotMatch(conflict + access, /VERSION_CONFLICT|FORBIDDEN/);
  }
});

test("expired knowledge sessions give a sign-in next step without exposing a service code", () => {
  assert.match(getKnowledgeErrorMessage("de", new Error("SESSION_EXPIRED"), "fallback"), /erneut an/);
  assert.match(getKnowledgeErrorMessage("en", new Error("UNAUTHORIZED"), "fallback"), /sign in again/);
});
