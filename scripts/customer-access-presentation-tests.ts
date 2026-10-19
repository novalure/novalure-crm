import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerAccessCockpit, isPersistedCustomerAccessPayload } from "../src/components/customer-access-cockpit";
import { customerWorkspaceAccess, projects, users } from "../src/lib/crm-data";

const emptyDatabasePayload = {
  source: "database", audits: [], customerAccess: [], grants: [], projects: [], users: [],
};

test("fixture fallback, absent provenance and malformed customer responses cannot become loaded data", () => {
  const fallback = { ...emptyDatabasePayload, source: "fallback", customerAccess: customerWorkspaceAccess };
  assert.equal(isPersistedCustomerAccessPayload(fallback), false);
  assert.equal(isPersistedCustomerAccessPayload({ ...fallback, source: undefined }), false);
  assert.equal(isPersistedCustomerAccessPayload({ ...emptyDatabasePayload, users: null }), false);
  assert.equal(isPersistedCustomerAccessPayload(null), false);
});

test("an explicitly empty database response remains an authoritative empty collection", () => {
  assert.equal(isPersistedCustomerAccessPayload(emptyDatabasePayload), true);
  assert.equal(isPersistedCustomerAccessPayload({ ...emptyDatabasePayload, customerAccess: customerWorkspaceAccess }), true);
});

test("initial customer rendering waits for the API without showing passed fixture names, metrics or actions", () => {
  for (const language of ["de", "en"] as const) {
    const html = renderToStaticMarkup(createElement(CustomerAccessCockpit, {
      language,
      projectLabel: "Authorized scope",
      customerAccess: customerWorkspaceAccess.map((customer) => ({ ...customer, customerName: "UNVERIFIED_CUSTOMER_SENTINEL", activeUsers: 87654321 })),
      projects: projects.map((project) => ({ ...project, name: "UNVERIFIED_PROJECT_SENTINEL" })),
      users: users.map((user) => ({ ...user, name: "UNVERIFIED_USER_SENTINEL" })),
    }));
    assert.match(html, /data-customer-access-state="loading"/);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /UNVERIFIED_|87654321|<button|<form|<strong/);
  }
});
