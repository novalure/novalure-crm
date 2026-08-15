#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/components/contact-command-center.tsx", import.meta.url),
  "utf8",
);

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test("zero contacts resolve to an explicit null selection instead of an editable draft", () => {
  const selection = sourceBetween(
    "const selectedContact: Contact | null =",
    "const selectedOrganization",
  );

  assert.match(selection, /contactRecords\[0\]\s*\?\?\s*null;/);
  assert.doesNotMatch(selection, /createContactDraft/);
  assert.doesNotMatch(source, /const hasSelectedContact\b/);
  assert.doesNotMatch(source, /if \(!hasSelectedContact/);
});

test("detail-only calculations and editable contact UI require a real contact", () => {
  assert.match(source, /const dataModelMapping = selectedContact\s*\?/);
  assert.match(source, /const qualityChecks = selectedContact\s*\?/);
  assert.match(source, /const qualityScore = qualityChecks\.length\s*\?/);

  const selectedUi = sourceBetween(
    "{selectedContact ? (",
    "data-contact-empty-state=\"true\"",
  );
  assert.match(selectedUi, /value=\{selectedContact\.name\}/);
  assert.match(selectedUi, /\{selectedContact\.name \|\| copy\.noValue\}/);
});

test("empty state exposes the existing create flow only to contact writers", () => {
  const emptyState = source.slice(source.indexOf('data-contact-empty-state="true"'));

  assert.match(emptyState, /<h4[^>]*>\{copy\.noContact\}<\/h4>/);
  assert.match(
    emptyState,
    /\{canWriteContacts \? \([\s\S]*onClick=\{openCreateContact\}[\s\S]*\) : \(\s*<p[^>]*>\{copy\.readOnlyContacts\}<\/p>\s*\)\}/,
  );
  assert.equal(source.match(/onClick=\{openCreateContact\}/g)?.length, 2);
});

test("both create entry points reset a genuine draft through one handler", () => {
  const handler = sourceBetween("const openCreateContact = () => {", "const refreshAfterContactChange");

  assert.match(handler, /setNewContact\(createContactDraft\(/);
  assert.match(handler, /setIsCreateOpen\(true\)/);
  assert.match(handler, /setArchiveConfirmContactId\(""\)/);
  assert.match(handler, /clearFeedback\(\)/);
});
