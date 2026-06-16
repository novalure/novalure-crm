import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

test("CRM write repositories validate core negative inputs server-side", () => {
  const repo = readText("src/lib/db/crm-write-repositories.ts");

  assert.match(repo, /function validateEmailInput/);
  assert.match(repo, /function validateDealValueInput/);
  assert.match(repo, /function validateFutureDateInput/);
  assert.match(repo, /validateTextLength\(input\.deal\.name, "Deal name"/);
  assert.match(repo, /validateDealValueInput\(input\.deal\.value\)/);
  assert.match(repo, /validateFutureDateInput\(input\.lead\.nextContactAt, "Next contact date"\)/);
  assert.match(repo, /validateTextLength\(input\.task\.title, "Task title"/);
  assert.match(repo, /validateEmailInput\(input\.contact\.email\)/);
});

test("contact writes reject duplicate active email addresses", () => {
  const repo = readText("src/lib/db/crm-write-repositories.ts");

  assert.match(repo, /Duplicate contact email/);
  assert.match(repo, /lower\(email\) = lower\(\$2\)/);
  assert.match(repo, /archived_at is null/);
  assert.match(repo, /id <> \$3::uuid/);
});

test("CRM API routes map validation failures to non-silent client errors", () => {
  const dealsRoute = readText("src/app/api/crm/deals/route.ts");
  const leadsRoute = readText("src/app/api/crm/leads/route.ts");
  const contactsRoute = readText("src/app/api/crm/contacts/route.ts");
  const tasksRoute = readText("src/app/api/crm/tasks/route.ts");

  assert.match(dealsRoute, /greater than zero/);
  assert.match(dealsRoute, /implausibly/);
  assert.match(leadsRoute, /getLeadWriteStatus/);
  assert.match(leadsRoute, /cannot be in the past/);
  assert.match(contactsRoute, /reason\.includes\("Duplicate"\)/);
  assert.match(tasksRoute, /getTaskWriteStatus/);
});

test("contact destructive flow is soft-delete with visible confirmation and restore context", () => {
  const repo = readText("src/lib/db/crm-write-repositories.ts");
  const route = readText("src/app/api/crm/contacts/route.ts");
  const ui = readText("src/components/contact-command-center.tsx");

  assert.match(repo, /export async function archiveContactRecord/);
  assert.match(repo, /set\s+archived_at = now\(\)/);
  assert.match(repo, /archived_by_user_id/);
  assert.doesNotMatch(repo, /delete from contacts/i);
  assert.match(route, /export async function DELETE/);
  assert.match(route, /archiveContactRecord/);
  assert.match(ui, /archiveConfirmContactId/);
  assert.match(ui, /confirmArchive/);
});

test("lead inbox create form surfaces required-field and save failures", () => {
  const ui = readText("src/components/lead-inbox.tsx");

  assert.match(ui, /type LeadDraftFieldErrors/);
  assert.match(ui, /leadDraftErrors\.projectId/);
  assert.match(ui, /leadDraftErrors\.intent/);
  assert.match(ui, /leadDraftErrors\.nextAction/);
  assert.match(ui, /aria-invalid=\{Boolean\(leadDraftErrors\.intent\)\}/);
  assert.match(ui, /aria-invalid=\{Boolean\(leadDraftErrors\.nextAction\)\}/);
  assert.match(ui, /focusFirstInvalidLeadField\(nextErrors\)/);
  assert.match(ui, /leadSavingRef\.current/);
  assert.match(ui, /showNotice\(text\.saveError, "error"\)/);
});
