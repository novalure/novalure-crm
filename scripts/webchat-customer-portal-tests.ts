import assert from "node:assert/strict";
import test from "node:test";
import { webchatConversationSummary } from "../src/lib/webchat-customer-portal";
import { formatWebchatMoney } from "../src/lib/webchat-product/presentation";

test("portal keeps saved extractive summaries distinct from a message preview", () => {
  const messages = [{ id: "m1", role: "visitor", content: "Original visitor question", createdAt: "2026-11-03T12:00:00Z" }];
  assert.deepEqual(webchatConversationSummary({ kind: "extractive", text: "Saved question excerpt" }, messages), { summary: "Saved question excerpt", summaryKind: "extractive" });
  assert.deepEqual(webchatConversationSummary({ kind: "generated", text: "Untrusted generated claim" }, messages), { summary: "Original visitor question", summaryKind: "preview" });
  assert.equal(messages[0].content, "Original visitor question");
});

test("portal preview is bounded and does not promote assistant content to visitor facts", () => {
  const messages = [
    { id: "m1", role: "visitor", content: "Earlier", createdAt: "2026-11-03T12:00:00Z" },
    { id: "m2", role: "assistant", content: "Assistant statement", createdAt: "2026-11-03T12:00:01Z" },
    ...["One", "Two", "Three"].map((content, i) => ({ id: String(i), role: "visitor", content, createdAt: "2026-11-03T12:00:02Z" })),
  ];
  assert.deepEqual(webchatConversationSummary(null, messages), { summary: "One · Two · Three", summaryKind: "preview" });
  assert.equal(webchatConversationSummary({ kind: "extractive", text: "x".repeat(2000) }, []).summary.length, 1200);
  assert.deepEqual(webchatConversationSummary(null, []), { summary: "", summaryKind: "preview" });
});

test("configured minor amounts keep exact currency precision including large values", () => {
  assert.equal(formatWebchatMoney("123", "EUR", "en-IE"), "€1.23");
  assert.equal(formatWebchatMoney("123", "JPY", "en-US"), "¥123");
  assert.match(formatWebchatMoney("123", "KWD", "en-US"), /0\.123/u);
  assert.match(formatWebchatMoney("900719925474099123", "EUR", "en-US"), /9,007,199,254,740,991\.23/u);
});
