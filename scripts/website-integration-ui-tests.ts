import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { websiteChatEmbedCode } from "../src/lib/integrations/website-integration-copy";

test("embed code accepts generated base64url site keys and existing Studio hexadecimal keys", () => {
  const keys = [
    // Current gateway generation uses 24 random bytes, not hexadecimal UUIDs.
    ...Array.from({ length: 12 }, () => `nov_pk_${randomBytes(24).toString("base64url")}`),
    `nov_pk_${Buffer.alloc(24, 255).toString("base64url")}`,
    "nov_pk_AbCdEfGhIjKlMnOpQrStUvWxYz012-_A",
    "nov_pk_7d7a59c0dd26044004ae566f1b0a27adc",
  ];
  for (const key of keys) {
    const code = websiteChatEmbedCode(key);
    assert.ok(code, `A persisted gateway key must produce embed code: ${key}`);
    assert.ok(code.includes(`data-site-key="${key}"`));
    assert.match(code, /^<script async src="https:\/\/www\.novalure-crm\.app\/chat\/widget\.js" data-site-key="nov_pk_[A-Za-z0-9_-]{24,80}"><\/script>$/u);
  }
});

test("embed code rejects HTML attribute injection and values outside the gateway key boundary", () => {
  for (const invalid of ["", "nov_pk_short", `nov_pk_${"a".repeat(81)}`, `nov_pk_${"a".repeat(32)}\" onload=\"alert(1)`,
    `nov_pk_${"a".repeat(32)}</script><script>alert(1)</script>`, `nov_pk_${"a".repeat(32)}\n`, "sk_live_provider_secret"]) {
    assert.equal(websiteChatEmbedCode(invalid), "");
  }
});
