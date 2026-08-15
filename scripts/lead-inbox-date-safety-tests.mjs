import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  compareLeadDeadlines,
  formatLeadDateTime,
  minutesUntilLeadDeadline,
  parseLeadDate,
} = jiti("../src/lib/lead-deadline.ts");

test("lead date helpers reject missing and invalid timestamps without throwing", () => {
  assert.equal(parseLeadDate(""), null);
  assert.equal(parseLeadDate("  "), null);
  assert.equal(parseLeadDate("not-a-date"), null);
  assert.equal(formatLeadDateTime("", "de-DE"), "-");
  assert.equal(formatLeadDateTime("not-a-date", "en-US", "Unavailable"), "Unavailable");
  assert.equal(minutesUntilLeadDeadline("", Date.UTC(2026, 7, 15)), Number.POSITIVE_INFINITY);
});

test("lead date helpers keep valid SLA semantics and sort missing deadlines last", () => {
  const now = Date.UTC(2026, 7, 15, 12, 0, 0);
  const first = "2026-08-15T12:30:00.000Z";
  const second = "2026-08-15T13:00:00.000Z";

  assert.equal(minutesUntilLeadDeadline(first, now), 30);
  assert.equal(compareLeadDeadlines(first, second) < 0, true);
  assert.equal(compareLeadDeadlines("", first) > 0, true);
  assert.equal(compareLeadDeadlines("", "not-a-date"), 0);
  assert.equal(
    formatLeadDateTime(first, "de-DE"),
    new Intl.DateTimeFormat("de-DE", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(first)),
  );
});
