import assert from "node:assert/strict";
import test from "node:test";
import jsQR from "jsqr";
import sharp from "sharp";
import { buildTotpProvisioningUri, verifyTotpCode } from "../src/lib/auth/mfa";
import { createMfaQrCodeDataUrl } from "../src/lib/auth/mfa-qr";

// Public RFC 6238 SHA-1 vector, used exclusively for synthetic tests.
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow -- RFC 6238 public test vector.

async function decodeQr(dataUrl: string | null) {
  assert.ok(dataUrl && dataUrl.startsWith("data:image/png;base64,"), "QR image must be an inline PNG");
  const png = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  assert.ok(decoded, "Independent QR decoder must recognize the generated image");
  return decoded.data;
}

for (const [label, email] of [
  ["ordinary account", "Synthetic.QR+enrollment@example.invalid"],
  ["maximum-length account", `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`],
]) {
  test(`MFA QR independently decodes to the unchanged provisioning URI for ${label}`, async () => {
    const uri = buildTotpProvisioningUri({ email, secret });
    const decoded = await decodeQr(await createMfaQrCodeDataUrl(uri));
    // Boolean assertions keep provisioning secrets out of test failure output.
    assert.ok(decoded === uri, "Decoded QR must preserve the existing provisioning URI exactly");
    const parsed = new URL(decoded);
    assert.equal(parsed.protocol, "otpauth:");
    assert.equal(parsed.hostname, "totp");
    assert.equal(parsed.searchParams.get("issuer"), "Novalure CRM");
    assert.equal(parsed.searchParams.get("algorithm"), "SHA1");
    assert.equal(parsed.searchParams.get("digits"), "6");
    assert.equal(parsed.searchParams.get("period"), "30");
    assert.ok(decodeURIComponent(parsed.pathname) === `/Novalure CRM:${email.toLowerCase()}`, "Account label must survive QR encoding");
    assert.ok(parsed.searchParams.get("secret") === secret, "QR must carry the existing TOTP secret");
    // RFC 6238: SHA-1 at 59 seconds is 94287082, truncated to the configured
    // six digits. Exercise the existing application verifier, not a new one.
    assert.ok(verifyTotpCode(parsed.searchParams.get("secret")!, "287082", 59_000), "Decoded provisioning data must work with the existing six-digit TOTP verifier");
    assert.ok(!verifyTotpCode(parsed.searchParams.get("secret")!, "287083", 59_000), "Existing verifier must still reject an incorrect code");
  });
}

test("invalid provisioning input leaves manual enrollment available without logging secrets", async t => {
  const emitted: unknown[][] = [];
  const networkCalls: unknown[][] = [];
  for (const method of ["debug", "info", "log", "warn", "error"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { emitted.push(args); });
  }
  t.mock.method(globalThis, "fetch", async (...args: unknown[]) => {
    networkCalls.push(args);
    throw new Error("QR generation must not use external services");
  });
  for (const invalid of ["", "not a URI", "https://example.invalid/qr", "otpauth://hotp/example?secret=" + secret, "otpauth://totp/example", "otpauth://totp/" + "a".repeat(4_096)]) {
    assert.ok(await createMfaQrCodeDataUrl(invalid) === null, "Invalid input must fall back to the manual setup key");
  }
  assert.ok(await createMfaQrCodeDataUrl(buildTotpProvisioningUri({ email: "local-qr@example.invalid", secret })) !== null, "Local generation must succeed without fetch");
  assert.equal(networkCalls.length, 0, "QR generation must not call external services");
  assert.equal(emitted.length, 0, "QR generation and fallback must not log provisioning data");
});
