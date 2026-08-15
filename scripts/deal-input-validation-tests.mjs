#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  maxDealValueCents,
  parseDealValueCents,
  validateDealCloseDate,
  validateDealValue,
} from "../src/lib/deal-validation.ts";

test("deal values are required, positive, locale-tolerant and bounded", () => {
  assert.equal(validateDealValue("", { required: true }), "value_required");
  assert.equal(validateDealValue("", { required: false }), null);
  assert.equal(validateDealValue("0", { required: true }), "value_invalid");
  assert.equal(validateDealValue("-1", { required: true }), "value_invalid");
  assert.equal(parseDealValueCents("250.000 €"), 25_000_000);
  assert.equal(parseDealValueCents("EUR 250,000"), 25_000_000);
  assert.equal(parseDealValueCents("2,5 Mio."), 250_000_000);
  assert.equal(parseDealValueCents("500.000.000"), maxDealValueCents);
  assert.equal(validateDealValue("500.000.001", { required: true }), "value_too_high");
});

test("close dates accept today and future but reject missing, malformed and past values", () => {
  const options = { required: true, todayDateKey: "2026-08-11" };
  assert.equal(validateDealCloseDate("", options), "close_date_required");
  assert.equal(validateDealCloseDate("2026-02-30", options), "close_date_invalid");
  assert.equal(validateDealCloseDate("2026-08-10", options), "close_date_past");
  assert.equal(validateDealCloseDate("2026-08-11", options), null);
  assert.equal(validateDealCloseDate("2026-08-12", options), null);
  assert.equal(
    validateDealCloseDate("2020-01-01", { ...options, allowHistorical: true }),
    null,
  );
});

test("deal UI has empty defaults and server mirrors validation with restricted historical import", async () => {
  const component = await readFile(
    new URL("../src/components/deal-pipeline-workspace.tsx", import.meta.url),
    "utf8",
  );
  const repository = await readFile(
    new URL("../src/lib/db/crm-write-repositories.ts", import.meta.url),
    "utf8",
  );
  const route = await readFile(
    new URL("../src/app/api/crm/deals/route.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(component, /expectedCloseDate:\s*"2026-06-30"/);
  assert.doesNotMatch(component, /value:\s*"250\.000"/);
  assert.match(component, /expectedCloseDate:\s*""/);
  assert.match(component, /value:\s*""/);
  assert.match(component, /validateDealValue/);
  assert.match(component, /validateDealCloseDate/);
  assert.match(repository, /validateFutureDateInput/);
  assert.match(repository, /Deal value is required/);
  assert.match(repository, /Expected close date is required/);
  assert.match(route, /historicalImport === true/);
  assert.match(route, /productPermissions\.includes\("novalure:internal"\)/);
});
