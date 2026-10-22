import assert from "node:assert/strict";
import test from "node:test";
import { bookingFrameAncestors } from "../src/lib/booking/public-frame-policy";
import { buildBookingEmbedCode } from "../src/lib/booking/embed-runtime";
import { checkBookingInstallation } from "../src/lib/booking/installation-check";

const publicId = "synthetic_booking_publication";
const embedOrigin = "https://crm.example.invalid";
const allowedOrigins = ["https://customer.example.com"];

test("frame ancestors contain only exact persisted HTTPS origins and fail closed", () => {
  assert.equal(bookingFrameAncestors([]), "frame-ancestors 'self'");
  assert.equal(bookingFrameAncestors([allowedOrigins[0], allowedOrigins[0], "https://*.example.invalid", "https://customer.example.com;report-uri", "https://customer.example.com'", "https://customer.example.com%3b", "https://good.invalid; frame-src *", "http://127.0.0.1:3000", "https://user:password@host.invalid", "https://host.invalid/path", "https://host.invalid/", "data:text/html,bad"]), "frame-ancestors 'self' https://customer.example.com");
  assert.equal(bookingFrameAncestors(["http://127.0.0.1:3000"], true), "frame-ancestors 'self' http://127.0.0.1:3000");
});

test("embed code safely quotes supplied values and uses the trusted loader origin", () => {
  const code = buildBookingEmbedCode({ origin: embedOrigin + "/any-path", publicId: 'id"><img src=x onerror=alert(1)>', mode: "inline", language: "en" });
  assert.ok(code.includes(`src="${embedOrigin}/appointments/embed.js"`));
  assert.ok(code.includes("&quot;&gt;&lt;img"));
  assert.ok(!code.includes("<img"));
});

test("install check refuses unapproved and nonpublic URLs before a fetch", async () => {
  let fetched = 0;
  const fetchHtml = async () => { fetched++; return ""; };
  for (const url of ["https://foreign.invalid/widget", "http://127.0.0.1/widget", "https://127.0.0.1/widget", "https://user:password@customer.example.invalid/widget", "file:///etc/passwd"]) {
    await assert.rejects(checkBookingInstallation({ url, publicId, embedOrigin, allowedOrigins }, fetchHtml));
  }
  assert.equal(fetched, 0);
});

test("install check reports static evidence without claiming JavaScript execution", async () => {
  const input = { url: allowedOrigins[0] + "/book", publicId, embedOrigin, allowedOrigins };
  const code = buildBookingEmbedCode({ origin: embedOrigin, publicId, mode: "popup", language: "de" });
  assert.deepEqual(await checkBookingInstallation(input, async () => code), { originAllowed: true, reachable: true, markerFound: true, scriptFound: true, executed: false });
  assert.deepEqual(await checkBookingInstallation(input, async () => code.replace(embedOrigin, "https://impostor.invalid")), { originAllowed: true, reachable: true, markerFound: true, scriptFound: false, executed: false });
  await assert.rejects(checkBookingInstallation(input, async () => "a".repeat(512_001)));
});
