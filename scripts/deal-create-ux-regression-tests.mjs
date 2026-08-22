#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(
  new URL("../src/components/deal-pipeline-workspace.tsx", import.meta.url),
  "utf8",
);

test("deal create reports every required field and focuses the first invalid input", () => {
  assert.match(component, /type CreateDealField = "contactId" \| "expectedCloseDate" \| "value"/);
  assert.match(component, /if \(!contact\) fieldErrors\.contactId = text\.contactMissing/);
  assert.match(component, /if \(valueValidationCode\) fieldErrors\.value/);
  assert.match(component, /fieldErrors\.expectedCloseDate = validationMessages\[closeDateValidationCode\]/);
  assert.match(component, /document\.getElementById\(`new-deal-\$\{firstInvalidField\}`\)\?\.focus\(\)/);
  assert.match(component, /id="new-deal-value"/);
  assert.match(component, /id="new-deal-expectedCloseDate"/);
  assert.match(component, /role="alert"/);
});

test("deal create uses form semantics and a synchronous duplicate-submit guard", () => {
  assert.match(component, /const createDealInFlight = useRef\(false\)/);
  assert.match(component, /if \(createDealInFlight\.current\)/);
  assert.match(component, /createDealInFlight\.current = true/);
  assert.match(component, /createDealInFlight\.current = false/);
  assert.match(component, /noValidate[\s\S]*onSubmit=\{\(event\) => \{/);
  assert.match(component, /type="submit"/);
  assert.doesNotMatch(component, /onClick=\{\(\) => void createDeal\(\)\}/);
});
