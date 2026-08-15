import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

function block(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `${start} not found`);
  assert.notEqual(endIndex, -1, `${end} not found`);
  return source.slice(startIndex, endIndex);
}

test("company profile migration creates separated profile scopes, versions and Novalure operator seed", () => {
  const migration = readText("migrations/036_company_profiles.sql");

  assert.match(migration, /create table if not exists company_profiles\b/i);
  assert.match(migration, /create table if not exists company_profile_versions\b/i);
  assert.match(migration, /platform_operator/);
  assert.match(migration, /workspace_owner/);
  assert.match(migration, /crm_account/);
  assert.match(migration, /company_profiles_scope_owner_check/);
  assert.match(migration, /Novalure CLG/);
  assert.match(migration, /796735/);
  assert.match(migration, /workspace_users_status_check[\s\S]*suspended/);
});

test("system database diagnostics and schema include company profile tables", () => {
  assert.match(readText("src/app/api/system/database/route.ts"), /migrations\/036_company_profiles\.sql/);
  const schema = readText("src/lib/db/schema.ts");
  assert.match(schema, /"company_profiles"/);
  assert.match(schema, /"company_profile_versions"/);
});

test("company profile repository enforces scope separation, country preflight and legal audit", () => {
  const repo = readText("src/lib/db/company-profile-repositories.ts");

  for (const country of ["AT", "DE", "IE"]) assert.match(repo, new RegExp(`countryCode: "${country}"`));
  for (const field of [
    "Firmenbuchnummer",
    "Handelsregisternummer",
    "CRO registration number",
    "Paragraph 34c GewO",
    "PSRA licence information",
  ]) {
    assert.match(repo, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(repo, /scope === "platform_operator"/);
  assert.match(repo, /scope === "crm_account" && !organizationId/);
  assert.match(repo, /company_profile_versions/);
  assert.match(repo, /writeAuditLog/);
});

test("company profile and access APIs are mounted under settings", () => {
  const profileRoute = readText("src/app/api/settings/company-profile/route.ts");
  const accessRoute = readText("src/app/api/settings/access/users/route.ts");
  const passwordRoute = readText("src/app/api/settings/access/password/route.ts");

  assert.match(profileRoute, /getCompanyProfilePayload/);
  assert.match(profileRoute, /saveCompanyProfile/);
  assert.match(profileRoute, /operator_profile_forbidden/);
  assert.match(accessRoute, /inviteSettingsWorkspaceUser/);
  assert.match(accessRoute, /resendWorkspaceInvitation/);
  assert.match(accessRoute, /revokeWorkspaceInvitation/);
  assert.match(accessRoute, /triggerWorkspacePasswordReset/);
  assert.match(passwordRoute, /changeOwnWorkspacePassword/);
  assert.match(passwordRoute, /getRequestSession/);
});

test("customer-managed settings access exposes only customer roles and uses trusted app origin", () => {
  const repo = readText("src/lib/db/settings-access-repositories.ts");
  const roleBlock = block(
    repo,
    "export const customerAssignableSettingsProductRoles",
    "export const settingsWorkspaceRoles",
  );

  for (const role of [
    "customer_owner",
    "workspace_admin",
    "team_member",
    "broker_agent",
    "developer_sales",
    "project_sales_member",
    "assistant_backoffice",
    "external_partner",
    "viewer",
  ]) {
    assert.match(roleBlock, new RegExp(`"${role}"`));
  }

  for (const internalRole of [
    "platform_admin",
    "novalureGrowth",
    "novalureServiceOps",
    "novalureAdmin",
    "novalure_sales",
    "novalure_onboarding",
    "novalure_customer_success",
    "novalure_operator",
  ]) {
    assert.doesNotMatch(roleBlock, new RegExp(`"${internalRole}"`));
  }

  assert.match(repo, /getTrustedAppOrigin/);
  assert.match(repo, /changeOwnWorkspacePassword/);
  assert.match(repo, /verifyPassword/);
  assert.match(repo, /settings_access\.own_password_changed/);
  assert.match(readText("src/app/api/crm/customer-access/route.ts"), /origin: getTrustedAppOrigin\(\)/);
});

test("password setup uses 15 characters and reset links no longer trust request host", () => {
  assert.match(readText("src/lib/auth/passwords.ts"), /minimumPasswordLength = 15/);
  assert.match(readText("src/app/login/reset-password/page.tsx"), /minLength=\{15\}/);
  assert.match(readText("src/lib/i18n.ts"), /at least 15 characters/);
  assert.match(readText("src/lib/i18n.ts"), /mindestens 15 Zeichen/);
  assert.match(readText("src/lib/auth/password-reset.ts"), /getTrustedAppOrigin\(\)/);
});

test("settings UI exposes company profile tabs and access management", () => {
  const component = readText("src/components/company-profile-settings.tsx");
  const workspace = readText("src/components/crm-workspace.tsx");

  for (const tab of [
    "master",
    "register",
    "contact",
    "representation",
    "licenses",
    "privacy",
    "branding",
    "usage",
    "approval",
  ]) {
    assert.match(component, new RegExp(`"${tab}"`));
  }

  assert.match(component, /workspace_owner/);
  assert.match(component, /platform_operator/);
  assert.match(component, /crm_account/);
  assert.match(component, /\/api\/settings\/access\/users/);
  assert.match(component, /\/api\/settings\/access\/password/);
  assert.match(component, /mapProductRoleToTechnicalRole/);
  assert.match(workspace, /CompanyProfileSettings/);
});
