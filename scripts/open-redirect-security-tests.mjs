#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseFormRedirectAllowlist,
  resolveSafeFormRedirect,
  resolveSafeLocalRedirect,
} from "../src/lib/security/redirects.ts";

const trustedOrigin = "https://crm.novalure.example";
const localFallback = "/safe-fallback";

function resolveLocal(value) {
  return resolveSafeLocalRedirect(value, {
    fallback: localFallback,
    trustedOrigin,
  });
}

test("local redirect preserves only a same-origin pathname, query and hash", () => {
  assert.equal(resolveLocal("/crm/deals?project=qa#pipeline"), "/crm/deals?project=qa#pipeline");
  assert.equal(
    resolveLocal("https://crm.novalure.example/calendar?view=week#today"),
    "/calendar?view=week#today",
  );
  assert.equal(resolveLocal("https://crm.novalure.example:443/tasks"), "/tasks");
});

test("local redirect rejects separator parser bypasses, including repeated encoding", () => {
  const maliciousTargets = [
    "/%5Cevil.example",
    "/%255Cevil.example",
    "/%25255Cevil.example",
    "/%2F%2Fevil.example",
    "/%252F%252Fevil.example",
    "//evil.example",
    "https://crm.novalure.example//evil.example",
    "/safe/..//evil.example",
    "\\evil.example",
    "\\\\evil.example",
    "/\\evil.example",
  ];

  for (const target of maliciousTargets) {
    assert.equal(resolveLocal(target), localFallback, target);
  }
});

test("local redirect rejects schemes, foreign origins and ports, userinfo and CRLF", () => {
  const maliciousTargets = [
    "javascript:alert(1)",
    "data:text/html,redirect",
    "https://evil.example/path",
    "https://crm.novalure.example.evil.example/path",
    "https://crm.novalure.example:444/path",
    "https://user@crm.novalure.example/path",
    "/safe\r\nLocation:https://evil.example",
    "/safe%0d%0aLocation:https://evil.example",
    "/safe%250d%250aLocation:https://evil.example",
  ];

  for (const target of maliciousTargets) {
    assert.equal(resolveLocal(target), localFallback, target);
  }
});

test("local redirect applies route-specific internal path blocks", () => {
  const options = {
    blockedPathPrefixes: ["/api", "/login"],
    fallback: "/",
    trustedOrigin,
  };

  assert.equal(resolveSafeLocalRedirect("/api/session", options), "/");
  assert.equal(resolveSafeLocalRedirect("/login/reset-password", options), "/");
  assert.equal(resolveSafeLocalRedirect("/logins", options), "/logins");
});

test("form redirect allowlist normalizes exact HTTPS hosts and optional path prefixes", () => {
  const allowlist = parseFormRedirectAllowlist(
    "FORMS.EXAMPLE/thank-you, https://portal.example/complete",
  );

  assert.deepEqual(allowlist, [
    { hostname: "forms.example", pathPrefix: "/thank-you" },
    { hostname: "portal.example", pathPrefix: "/complete" },
  ]);
  assert.equal(
    resolveSafeFormRedirect({
      allowlist,
      configuredTarget: "https://forms.example/thank-you/confirmed?lead=1#done",
      fallback: "/forms/contact",
      trustedOrigin,
    }),
    "https://forms.example/thank-you/confirmed?lead=1#done",
  );
});

test("form redirect fails closed without an allowlist or for non-exact host matches", () => {
  const fallback = "/forms/contact";
  const blockedTargets = [
    "http://forms.example/thank-you",
    "https://forms.example:444/thank-you",
    "https://user@forms.example/thank-you",
    "https://forms.example.evil.example/thank-you",
    "https://forms.example/thank-you-elsewhere",
    "https://novаlure.example/thank-you", // The `а` is Cyrillic and normalizes to Punycode.
  ];

  for (const configuredTarget of blockedTargets) {
    assert.equal(
      resolveSafeFormRedirect({
        allowlist: "forms.example/thank-you, novalure.example",
        configuredTarget,
        fallback,
        returnTo: "/attacker-selected-but-local",
        trustedOrigin,
      }),
      fallback,
      configuredTarget,
    );
  }

  assert.equal(
    resolveSafeFormRedirect({
      allowlist: "",
      configuredTarget: "https://forms.example/thank-you",
      fallback,
      trustedOrigin,
    }),
    fallback,
  );
});

test("form redirect keeps safe local targets when no external target is configured", () => {
  assert.equal(
    resolveSafeFormRedirect({
      allowlist: "",
      configuredTarget: "",
      fallback: "/forms/contact",
      returnTo: "/forms/contact?campaign=qa#form",
      trustedOrigin,
    }),
    "/forms/contact?campaign=qa#form",
  );
  assert.equal(
    resolveSafeFormRedirect({
      allowlist: "",
      configuredTarget: "/forms/success?source=crm#saved",
      fallback: "/forms/contact",
      trustedOrigin,
    }),
    "/forms/success?source=crm#saved",
  );
});

test("all redirect call sites import the central validator and contain no local parser", async () => {
  const files = [
    "../src/app/login/page.tsx",
    "../src/app/api/auth/login/route.ts",
    "../src/app/api/meetings/oauth/[provider]/start/route.ts",
    "../src/app/api/meetings/oauth/[provider]/callback/route.ts",
    "../src/app/api/forms/submissions/route.ts",
  ];

  for (const relativePath of files) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /@\/lib\/security\/redirects/);
    assert.doesNotMatch(source, /function (?:getSafeReturnTo|safeReturnTo|getSafeConfiguredReturnPath|getSafeRelativeReturnPath)/);
  }
});
