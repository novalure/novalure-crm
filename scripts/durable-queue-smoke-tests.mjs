import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyDeliveryError,
  retryDelaySeconds,
  sanitizeJobError,
} from "../src/lib/jobs/durable-queue.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("durable retry uses capped exponential backoff with bounded jitter", () => {
  assert.equal(retryDelaySeconds(1, () => 0), 30);
  assert.equal(retryDelaySeconds(2, () => 0), 60);
  assert.equal(retryDelaySeconds(3, () => 0), 120);
  assert.equal(retryDelaySeconds(20, () => 0), 3_600);
  assert.equal(retryDelaySeconds(1, () => 1), 37);
});

test("job errors are classified and redacted before persistence", () => {
  assert.equal(classifyDeliveryError({ status: 429 }), "provider_rate_limit");
  assert.equal(classifyDeliveryError({ status: 503 }), "transient");
  assert.equal(classifyDeliveryError({ error: "request timed out" }), "provider_timeout");
  assert.equal(classifyDeliveryError({ error: "webhook URL not configured" }), "configuration");

  const sanitized = sanitizeJobError("token=secret-value https://provider.example/path?api_key=secret\nnext");
  assert.doesNotMatch(sanitized, /secret-value|provider\.example|api_key=secret/);
  assert.doesNotMatch(sanitized, /[\r\n]/);
});

test("notification queues claim atomically and fence acknowledgements by lease owner", async () => {
  const files = await Promise.all([
    read("src/lib/db/meeting-repositories.ts"),
    read("src/lib/db/google-notification-repositories.ts"),
    read("src/lib/db/teams-notification-repositories.ts"),
  ]);

  for (const source of files) {
    assert.match(source, /for update skip locked/i);
    assert.match(source, /lease_expires_at\s*=\s*now\(\)\s*\+\s*interval '45 seconds'/i);
    assert.match(source, /status in \('queued', 'retry'\)/i);
    assert.match(source, /locked_by\s*=\s*\$\d/i);
    assert.match(source, /status = 'sending' and locked_by = \$/i);
    assert.match(source, /attempt_count\s*>=\s*max_attempts/i);
  }
});

test("migration adds due, lease, dead-letter and idempotency state without editing legacy migrations", async () => {
  const migration = await read("migrations/050_durable_job_leasing.sql");
  for (const table of [
    "meeting_notification_jobs",
    "teams_notification_jobs",
    "google_notification_jobs",
    "property_export_jobs",
  ]) {
    assert.match(migration, new RegExp(`alter table ${table}`));
  }

  for (const column of [
    "available_at",
    "lease_expires_at",
    "locked_by",
    "attempt_count",
    "max_attempts",
    "last_error_category",
    "last_error_message",
    "dead_lettered_at",
    "idempotency_key",
  ]) {
    assert.match(migration, new RegExp(column));
  }
});
