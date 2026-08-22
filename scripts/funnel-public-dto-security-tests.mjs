import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { toPublicFunnelDto } from "../src/lib/funnel-public-dto.ts";
import {
  buildPublicSubmissionScope,
  createPublicSubmissionProof,
  publicSubmissionActions,
} from "../src/lib/security/public-submission-abuse.ts";

const funnelId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "33333333-3333-4333-8333-333333333333";

function createSensitiveBlueprint() {
  return {
    audience: "buyer",
    createdFrom: "crm-data",
    crmHandover: {
      createAppointment: true,
      createLeadInboxEntry: true,
      createTask: true,
      destination: "pipeline",
      followUp: "INTERNAL_FOLLOW_UP_SECRET",
      notificationRecipients: "INTERNAL_RECIPIENT_SECRET@example.test",
      pipelineStage: "INTERNAL_PIPELINE_SECRET",
      qualityRule: "INTERNAL_QUALITY_SECRET",
      statusTemplate: "INTERNAL_STATUS_SECRET",
    },
    entryChannel: "website",
    goal: "INTERNAL_GOAL_SECRET",
    id: funnelId,
    mediaLibrary: [{
      createdAt: "2026-08-22T00:00:00.000Z",
      folder: "INTERNAL_MEDIA_FOLDER_SECRET",
      id: "asset-1",
      name: "Internal asset",
      type: "video",
      url: "https://private.example.test/INTERNAL_MEDIA_LIBRARY_SECRET",
    }],
    name: "Public funnel",
    pages: [{
      id: "page-1",
      kind: "landing",
      name: "INTERNAL_PAGE_NAME_SECRET",
      sections: [{
        id: "section-1",
        name: "INTERNAL_SECTION_NAME_SECRET",
        rows: [{
          columns: [{
            elements: [
              {
                analyticsEvent: "INTERNAL_ANALYTICS_EVENT_SECRET",
                fields: [
                  {
                    crmField: "internal_email_alias",
                    id: "field-email",
                    label: "Email",
                    required: true,
                    type: "email",
                  },
                  {
                    crmField: "privacy_internal_alias",
                    helpText: "Privacy consent",
                    id: "field-privacy",
                    label: "Privacy",
                    required: true,
                    type: "consent",
                  },
                  {
                    crmField: "utm_source",
                    hiddenValueSource: "utm",
                    id: "field-utm",
                    label: "Source",
                    required: false,
                    type: "hidden",
                  },
                ],
                id: "form-1",
                name: "Contact",
                richText: { privateEditorState: "INTERNAL_RICH_TEXT_SECRET" },
                styles: { background: "INTERNAL_ELEMENT_STYLE_SECRET" },
                type: "form",
              },
              {
                condition: {
                  id: "condition-group-1",
                  mode: "and",
                  rules: [{
                    field: "internal_email_alias",
                    id: "condition-1",
                    operator: "exists",
                  }],
                },
                content: "Hello {{internal_email_alias}} {{INTERNAL_UNKNOWN_TOKEN_SECRET}}",
                id: "text-1",
                name: "Greeting",
                type: "text",
              },
              {
                id: "video-1",
                name: "Video",
                type: "video",
                url: "https://private.example.test/INTERNAL_VIDEO_URL_SECRET",
              },
              {
                alt: "Public image",
                id: "image-1",
                name: "Image",
                type: "image",
                url: "https://cdn.example.test/public-image.jpg",
              },
            ],
            id: "column-1",
            width: { desktop: 12 },
          }],
          id: "row-1",
        }],
        styles: { background: "INTERNAL_SECTION_STYLE_SECRET" },
      }],
      slug: "internal-page-slug-secret",
    }],
    projectId,
    schemaVersion: 1,
    status: "aktiv",
    theme: {
      colors: {
        accent: "#047857",
        background: "#ffffff",
        muted: "INTERNAL_MUTED_COLOR_SECRET",
        text: "#0f172a",
      },
      customCss: "INTERNAL_CUSTOM_CSS_SECRET",
      faviconUrl: "https://private.example.test/INTERNAL_FAVICON_SECRET",
      fontFamily: "system",
      id: "INTERNAL_THEME_ID_SECRET",
      logoText: "Public logo",
      name: "INTERNAL_THEME_NAME_SECRET",
      radii: { block: 12, button: 8 },
      spacing: { desktop: 20, mobile: 12 },
    },
    tracking: {
      consentMode: "active",
      gaMeasurementId: "INTERNAL_GA_SECRET",
      gtmId: "INTERNAL_GTM_SECRET",
      matomoSiteId: "INTERNAL_MATOMO_SECRET",
      metaCapiToken: "INTERNAL_META_CAPI_SECRET",
      metaPixelId: "1234567890",
      publishToken: "INTERNAL_PUBLISH_TOKEN_SECRET",
      webhookUrl: "https://hooks.example.test/INTERNAL_WEBHOOK_SECRET",
    },
    variants: [{
      id: "variant-1",
      name: "INTERNAL_VARIANT_SECRET",
      trafficPercent: 100,
    }],
    workspaceId,
  };
}

test("public funnel DTO is a deep explicit allowlist and preserves only renderer semantics", () => {
  const blueprint = createSensitiveBlueprint();
  const dto = toPublicFunnelDto(blueprint);
  const serialized = JSON.stringify(dto);

  assert.deepEqual(Object.keys(dto).sort(), ["id", "name", "pages", "theme", "tracking"]);
  assert.deepEqual(Object.keys(dto.tracking).sort(), ["clientAnalyticsEnabled", "metaPixelEnabled"]);
  assert.deepEqual(Object.keys(dto.theme).sort(), ["colors", "logoText", "radii", "spacing"]);
  assert.deepEqual(Object.keys(dto.theme.colors).sort(), ["accent", "background", "text"]);
  assert.equal(dto.id, funnelId);
  assert.equal(dto.tracking.clientAnalyticsEnabled, true);
  assert.equal(dto.tracking.metaPixelEnabled, true);

  const elements = dto.pages[0].sections[0].rows[0].columns[0].elements;
  const form = elements[0];
  const textElement = elements[1];
  const video = elements[2];
  const image = elements[3];
  assert.equal(form.fields[0].id, "field-email");
  assert.equal(Object.hasOwn(form.fields[0], "crmField"), false);
  assert.deepEqual(form.fields[1].consentCategories, {
    analytics: false,
    marketing: false,
    privacy: true,
  });
  assert.equal(form.fields[2].publicQueryParameter, "utm_source");
  assert.equal(textElement.content, "Hello {{field-email}} ");
  assert.equal(textElement.condition.rules[0].field, "field-email");
  assert.deepEqual(video, {
    hasMedia: true,
    id: "video-1",
    name: "Video",
    type: "video",
  });
  assert.equal(image.url, "https://cdn.example.test/public-image.jpg");

  for (const forbidden of [
    workspaceId,
    projectId,
    "INTERNAL_META_CAPI_SECRET",
    "INTERNAL_WEBHOOK_SECRET",
    "INTERNAL_RECIPIENT_SECRET",
    "INTERNAL_PIPELINE_SECRET",
    "INTERNAL_PUBLISH_TOKEN_SECRET",
    "INTERNAL_CUSTOM_CSS_SECRET",
    "INTERNAL_RICH_TEXT_SECRET",
    "INTERNAL_ANALYTICS_EVENT_SECRET",
    "INTERNAL_VIDEO_URL_SECRET",
    "INTERNAL_MEDIA_LIBRARY_SECRET",
    "INTERNAL_UNKNOWN_TOKEN_SECRET",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "u"));
  }

  blueprint.pages[0].sections[0].rows[0].columns[0].elements[0].fields[0].label = "Mutated";
  blueprint.theme.colors.accent = "#000000";
  assert.equal(form.fields[0].label, "Email");
  assert.equal(dto.theme.colors.accent, "#047857");
});

test("public page serializes only the DTO and never forwards its publish credential", async () => {
  const [page, renderer, commandCenter] = await Promise.all([
    readFile(new URL("../src/app/preview/[funnelId]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/funnel-renderer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/funnel-command-center.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /const publicFunnel = toPublicFunnelDto\(blueprint\)/u);
  assert.match(page, /<FunnelRenderer\s+blueprint=\{publicFunnel\}/u);
  assert.doesNotMatch(page, /<FunnelRenderer\s+blueprint=\{blueprint\}/u);
  assert.doesNotMatch(page, /catch\s*(?:\([^)]*\))?\s*\{[\s\S]*?notFound\(\)/u);
  assert.match(page, /stored = await getStoredFunnel\(funnelId\);[\s\S]*if \(!stored \|\| !canUsePublicLiveFunnel/u);
  assert.doesNotMatch(page, /liveTokenQuery|encodeURIComponent\(query\.token\)|token=\$\{/u);
  assert.match(page, /mode === "test"[\s\S]*novalure-funnel-preview-toolbar/u);
  assert.match(commandCenter, /blueprint=\{toPublicFunnelDto\(selectedBlueprint\)\}/u);

  for (const forbiddenName of [
    "crmHandover",
    "metaCapiToken",
    "notificationRecipients",
    "pipelineStage",
    "projectId",
    "webhookUrl",
    "workspaceId",
  ]) {
    assert.equal(renderer.includes(forbiddenName), false, `renderer must not depend on ${forbiddenName}`);
  }
});

test("submission proof contains only the four public anti-abuse values", () => {
  const proof = createPublicSubmissionProof({
    action: publicSubmissionActions.funnel,
    scope: buildPublicSubmissionScope({ resourceId: funnelId, resourceType: "funnel", workspaceId }),
    secret: "public-dto-regression-secret-with-at-least-32-bytes",
  });

  assert.deepEqual(Object.keys(proof).sort(), ["expiresAt", "idempotencyKey", "issuedAt", "signature"]);
  assert.equal(JSON.stringify(proof).includes(workspaceId), false);
  assert.equal(JSON.stringify(proof).includes("publishToken"), false);
});

test("live submission response is minimal while authenticated test mode keeps diagnostics", async () => {
  const route = await readFile(
    new URL("../src/app/api/funnels/[funnelId]/submissions/route.ts", import.meta.url),
    "utf8",
  );
  const liveStart = route.indexOf('if (input.mode === "live")');
  const testResponseStart = route.indexOf("return {", route.indexOf("return {", liveStart) + 1);
  const liveBranch = route.slice(liveStart, testResponseStart);

  assert.ok(liveStart > 0);
  assert.match(liveBranch, /mode: "live"[\s\S]*ok: true[\s\S]*persisted: true/u);
  assert.doesNotMatch(liveBranch, /destination|pipelineStage|persistence:|submissionId|trackingPreview/u);
  assert.match(route.slice(testResponseStart), /leadPreview:[\s\S]*trackingPreview:/u);
});
