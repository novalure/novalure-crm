import assert from "node:assert/strict";
import test from "node:test";
import { contactBackfillCheckpoint, emptyMailboxCheckpoint, type MailboxSyncCheckpoint } from "../src/lib/crm-mailbox-sync";

test("contact opt-in waits for queued changes and the provider's last delta page before inbox rescan", () => {
  const ready: MailboxSyncCheckpoint = { ...emptyMailboxCheckpoint(), phase: "ready", deltaCheckpoint: "opaque-delta" };
  assert.equal(contactBackfillCheckpoint(ready, false, null), null);
  assert.equal(contactBackfillCheckpoint({ ...ready, phase: "history" }, true, null), null);
  assert.equal(contactBackfillCheckpoint({ ...ready, queued: [{ id: "pending-removal", removed: true }] }, true, null), null);
  assert.equal(contactBackfillCheckpoint({ ...ready, afterQueue: { ...ready } }, true, null), null);
  const backfill = contactBackfillCheckpoint(ready, true, null);
  assert.deepEqual(backfill, { checkpoint: emptyMailboxCheckpoint(), resume: ready, pending: false });
  const newBaseline: MailboxSyncCheckpoint = { ...ready, deltaCheckpoint: "new-baseline-delta" };
  assert.deepEqual(contactBackfillCheckpoint(newBaseline, false, backfill!.resume), { checkpoint: ready, resume: null, pending: false }, "the old cursor is replayed after the baseline to catch intervening changes");
  assert.deepEqual(contactBackfillCheckpoint(newBaseline, true, backfill!.resume), { checkpoint: ready, resume: null, pending: true }, "another opt-in during the scan is preserved");
});
