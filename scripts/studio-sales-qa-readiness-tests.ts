import assert from "node:assert/strict";
import test from "node:test";
import { readStudioCalendarPolicy } from "../src/lib/integrations/studio-microsoft-calendar";
import { isStudioIsolatedLocalTest, studioQaRecipients,
  studioQaTargetConfiguration } from "../src/lib/studio-sales-qa-readiness";

const qaUrl = "postgresql://studio_qa:synthetic@studio-qa-pooler.example.invalid/studio_qa";
const policy = {
  approvalId: "QA-approval-123", organizerId: "organizer@example.invalid", calendarId: "qa-calendar",
  timeZone: "Europe/Dublin", durationMinutes: 30, intervalMinutes: 30,
  minNoticeMinutes: 60, bufferMinutes: 10, horizonDays: 14,
  hours: { "1": [{ start: 600, end: 960 }] },
};
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: "prj_qa_crm", STUDIO_BOOKING_QA_CRM_PROJECT_ID: "prj_qa_crm",
  DATABASE_URL: qaUrl, NOVALURE_QA_DATABASE_URL: qaUrl,
  NOVALURE_QA_DATABASE_HOST: "studio-qa-pooler.example.invalid",
  NOVALURE_PRODUCTION_DATABASE_HOST: "studio-prod-pooler.example.invalid",
  NOVALURE_QA_PROJECT_ID: "qa-project", NOVALURE_QA_BRANCH_ID: "qa-branch",
  NOVALURE_QA_DATABASE_NAME: "studio_qa", NOVALURE_QA_DATABASE_ROLE: "studio_qa",
  STUDIO_BOOKING_REAL_MODE: "1", STUDIO_BOOKING_POLICY_JSON: JSON.stringify(policy),
  STUDIO_BOOKING_CONFIG_APPROVAL_ID: policy.approvalId,
  STUDIO_BOOKING_QA_RECIPIENTS_JSON: '["qa@example.invalid"]',
  MICROSOFT_TENANT_ID: "synthetic-tenant", MICROSOFT_CLIENT_ID: "synthetic-client",
  MICROSOFT_CLIENT_SECRET: "synthetic-secret", MICROSOFT_CALENDAR_USER_ID: policy.organizerId,
};

test("Preview booking policy requires target binding, approved recipients and Microsoft names", () => {
  assert.deepEqual(studioQaRecipients(env), ["qa@example.invalid"]);
  assert.ok(studioQaTargetConfiguration(env));
  assert.deepEqual(readStudioCalendarPolicy(env)?.qaRecipients, ["qa@example.invalid"]);
  assert.equal(readStudioCalendarPolicy({ ...env, STUDIO_BOOKING_QA_RECIPIENTS_JSON: "[]" }), null);
  assert.equal(readStudioCalendarPolicy({ ...env, NOVALURE_QA_BRANCH_ID: "" }), null);
  assert.equal(readStudioCalendarPolicy({ ...env, VERCEL_PROJECT_ID: "prj_wrong" }), null);
  assert.equal(readStudioCalendarPolicy({ ...env, DATABASE_URL: "postgresql://other:synthetic@studio-prod-pooler.example.invalid/prod" }), null);
  assert.equal(readStudioCalendarPolicy({ ...env, MICROSOFT_CLIENT_SECRET: "" }), null);
  assert.equal(readStudioCalendarPolicy({ ...env, VERCEL_ENV: "production" }), null);
  assert.equal(isStudioIsolatedLocalTest({ NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1",
    VERCEL: "1", VERCEL_ENV: "preview" }), false);
  assert.equal(isStudioIsolatedLocalTest({ NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1" }), true);
});
