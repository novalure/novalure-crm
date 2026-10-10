import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildWebsiteSalesSignature,
  parseWebsiteSalesLeadPayload,
  resolveWebsiteSalesClientIp,
  verifyWebsiteSalesSignature,
  websiteSalesContractVersion,
  websiteSalesFormId,
} from "@/lib/website-sales-ingestion";

const secret = "website-sales-ingestion-test-secret-at-least-32-bytes";

function validPayload() {
  return {
    attribution: {
      landingPage: "https://novalurestudio.ie/",
      utmCampaign: "autumn",
      utmSource: "google",
    },
    company: "Novalure Studio E2E Test Ltd",
    consent: true,
    currentWebsiteUrl: "https://example.test",
    email: "website-sales-test@example.test",
    idempotencyKey: "website-sales-test-idempotency-key-0001",
    message: "Request a website consultation for a safe synthetic test.",
    name: "Website Sales Test",
    packageInterest: "BUSINESS",
    syntheticTest: true,
    version: websiteSalesContractVersion,
  };
}

test("Website Sales contract validates only the bounded, consented v1 payload", () => {
  const payload = parseWebsiteSalesLeadPayload(validPayload());
  assert.equal(payload?.packageInterest, "BUSINESS");
  assert.equal(payload?.syntheticTest, true);
  assert.equal(payload?.attribution?.utmSource, "google");

  assert.equal(parseWebsiteSalesLeadPayload({ ...validPayload(), consent: false }), null);
  assert.equal(parseWebsiteSalesLeadPayload({ ...validPayload(), packageInterest: "€1,990" }), null);
  assert.equal(parseWebsiteSalesLeadPayload({ ...validPayload(), currentWebsiteUrl: "javascript:alert(1)" }), null);
});

test("Website Sales signature is timestamp-bound and rejects tampered payloads", () => {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const body = JSON.stringify(validPayload());
  const signature = buildWebsiteSalesSignature({ body, secret, timestamp });

  assert.equal(verifyWebsiteSalesSignature({ body, secret, signature, timestamp }), true);
  assert.equal(verifyWebsiteSalesSignature({ body: `${body} `, secret, signature, timestamp }), false);
  assert.equal(verifyWebsiteSalesSignature({ body, secret: "another-secret-that-is-long-enough-for-testing", signature, timestamp }), false);
});

test("Website Sales accepts only an IP address supplied by the authenticated website backend", () => {
  assert.equal(resolveWebsiteSalesClientIp("203.0.113.10"), "203.0.113.10");
  assert.equal(resolveWebsiteSalesClientIp("2001:db8::3"), "2001:db8::3");
  assert.equal(resolveWebsiteSalesClientIp("not-an-ip"), null);
});

test("CRM endpoint uses the dedicated form identity and persistent public-submission protections", async () => {
  const [route, migration] = await Promise.all([
    readFile(new URL("../src/app/api/public/website-sales/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../migrations/087_website_sales_ingestion.sql", import.meta.url), "utf8"),
  ]);

  assert.match(route, /verifyWebsiteSalesSignature/);
  assert.match(route, /claimPublicSubmissionIdempotency/);
  assert.match(route, /consumePublicSubmissionRateLimits/);
  assert.match(route, /persistWebsiteFormSubmission/);
  assert.match(route, /utm_source/);
  assert.match(route, /landing_page/);
  assert.match(migration, new RegExp(websiteSalesFormId));
  assert.match(migration, /WEBSITE_SALES/);
  assert.match(migration, /NOVALURE_STUDIO_FORM/);
});
