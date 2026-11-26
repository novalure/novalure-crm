import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantTransaction } from "../src/lib/crm-command";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { createPropertyGeography } from "../src/lib/property-country";
import { buildWebExposeSnapshot, publishWebExpose, type WebExposePublishInput } from "../src/lib/db/web-expose-repository";
import { webExposeLegalReadiness } from "../src/lib/web-expose-readiness";

test("private preview exposes missing legal fields without creating a public version", async () => {
  const workspaceId = randomUUID(), propertyId = randomUUID();
  const session = { authenticated: true, userId: randomUUID(), workspaceId, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" } as AppSession;
  const sql: string[] = [];
  let mediaCount = 0;
  const tx = {
    query: async (query: string) => { sql.push(query); return query.includes("from property_media m join") ? Array.from({ length: mediaCount }, (_, index) => ({ id: `media-${index}`, assetId: `asset-${index}`, title: `Synthetic ${index}`, kind: "image" })) : []; },
    queryOne: async (query: string, params: unknown[]) => {
      sql.push(query);
      if (query.includes("onboardingExample")) return { synthetic: false };
      if (query.includes("project_id as \"projectId\"")) {
        if (params[1] !== workspaceId) return null;
        return { projectId: null, unitId: null, title: "Synthetic property", address: "Private 123", city: "Fritzens", region: "Tirol", objectType: "Wohnung", area: "90", rooms: "3", yearBuilt: 2000, priceCents: null, priceVisibility: "price_on_request", canonicalPayload: { geography: createPropertyGeography("AT", "Tirol") }, publicDetails: {}, contactName: "", contactEmail: "", contactPhone: "" };
      }
      if (query.includes("usage_type as")) return { usageType: "residential", yearBuilt: 2000, rentPrice: null, marketingType: "sale", webVisibility: "price_on_request" };
      return null;
    },
  } as unknown as TenantTransaction;
  const input: WebExposePublishInput = { propertyId, language: "de", privacyUrl: "", legalUrl: "", controller: "", description: "Synthetic description", showAddress: false, showContact: false, reviewed: true };
  const result = await buildWebExposeSnapshot(tx, session, input, { privatePreview: true });
  assert.equal(result.snapshot.title, "Synthetic property");
  assert.deepEqual(result.checks.filter(check => check.id.startsWith("EXPOSE-") && check.status === "missing").map(check => check.id), ["EXPOSE-CONTROLLER", "EXPOSE-PRIVACY", "EXPOSE-LEGAL"]);
  assert.equal(result.snapshot.privacyUrl, "");
  assert.equal(result.snapshot.legalUrl, "");
  assert.equal(sql.some(query => /insert\s+into\s+web_expose_(versions|links)/i.test(query)), false);
  await assert.rejects(() => publishWebExpose(tx, session, { ...input, expectedSourceFingerprint: result.sourceFingerprint }), /Anbieter/);
  assert.equal(sql.some(query => /insert\s+into\s+web_expose_(versions|links)/i.test(query)), false);
  const completed = await buildWebExposeSnapshot(tx, session, { ...input, controller: "Agency", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal" }, { privatePreview: true });
  assert.notEqual(completed.sourceFingerprint, result.sourceFingerprint, "changes to legal details require a fresh preview before publication");
  mediaCount = 117;
  const fullGallery = await buildWebExposeSnapshot(tx, session, input, { privatePreview: true });
  assert.equal(fullGallery.snapshot.media.length, 117);
  assert.ok(!fullGallery.checks.some(check => check.id === "EXPOSE-MEDIA-LIMIT"));
  mediaCount = 167;
  const allConverted = await buildWebExposeSnapshot(tx, session, input, { privatePreview: true });
  assert.equal(allConverted.snapshot.media.length, 167);
  assert.ok(!allConverted.checks.some(check => check.id === "EXPOSE-MEDIA-LIMIT"));
  mediaCount = 250;
  const atLimit = await buildWebExposeSnapshot(tx, session, input, { privatePreview: true });
  mediaCount = 251;
  const overLimit = await buildWebExposeSnapshot(tx, session, input, { privatePreview: true });
  assert.equal(overLimit.snapshot.media.length, 250);
  assert.ok(overLimit.checks.some(check => check.id === "EXPOSE-MEDIA-LIMIT" && check.status === "missing"));
  assert.notEqual(overLimit.sourceFingerprint, atLimit.sourceFingerprint, "a newly exceeded limit requires a new preview");
  const excluded = await buildWebExposeSnapshot(tx, session, { ...input, includeLegacyMedia: false }, { privatePreview: true });
  assert.equal(excluded.snapshot.media.length, 0);
  assert.ok(!excluded.checks.some(check => check.id === "EXPOSE-MEDIA-LIMIT"));
  await assert.rejects(() => buildWebExposeSnapshot(tx, { ...session, workspaceId: randomUUID() }, input, { privatePreview: true }), /Immobilie nicht gefunden/);
});

test("readiness rejects unsafe links and accepts credential-free HTTPS links", () => {
  for (const value of ["", "http://example.invalid", "javascript:alert(1)", "https://user:pass@example.invalid/"]) {
    const result = webExposeLegalReadiness({ controller: "Agency", privacyUrl: value, legalUrl: value });
    assert.equal(result.privacyUrl, "");
    assert.equal(result.legalUrl, "");
    assert.equal(result.checks.filter(check => check.status === "missing").length, 2);
  }
  assert.ok(webExposeLegalReadiness({ controller: "Agency", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal" }).checks.every(check => check.status === "ready"));
});
