import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/cookie-consent-button.tsx", import.meta.url), "utf8");
function consentRuntime({ cookie = "", stored = null, denied = false } = {}) {
  const events = [];
  const document = { cookie };
  const { outputText } = ts.transpileModule(source + "\nexport const storageTest = { readStoredConsent, persistConsent };", {
    fileName: "cookie-consent-button.tsx",
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const cjsModule = { exports: {} };
  const sandbox = {
    module: cjsModule, exports: cjsModule.exports, document,
    window: { location: { protocol: "https:" }, dispatchEvent(event) { events.push(event); } },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    require(specifier) {
      if (["react", "react/jsx-runtime", "next/link"].includes(specifier)) return {};
      throw new Error(`Unexpected consent dependency: ${specifier}`);
    },
  };
  Object.defineProperty(sandbox, "localStorage", {
    get() {
      if (denied) throw new Error("Synthetic browser-storage denial");
      return { getItem() { return stored; }, setItem(_key, value) { stored = value; } };
    },
  });
  vm.runInNewContext(outputText, sandbox, { filename: "cookie-consent-button.tsx" });
  return { ...cjsModule.exports.storageTest, document, events };
}
const necessary = { analytics: false, choice: "necessary", marketing: false, necessary: true, updatedAt: "2026-10-21T12:00:00.000Z", version: 1 };

test("denied browser storage preserves valid cookie choices and leaves missing consent undecided", () => {
  const withCookie = consentRuntime({ denied: true, cookie: `novalure_cookie_consent=${encodeURIComponent(JSON.stringify(necessary))}` });
  const consent = withCookie.readStoredConsent();
  assert.equal(consent.choice, "necessary");
  assert.equal(consent.analytics, false);
  assert.equal(consent.marketing, false);
  assert.equal(consentRuntime({ denied: true }).readStoredConsent(), null);
  assert.equal(consentRuntime({ denied: true, cookie: "novalure_cookie_consent=%invalid" }).readStoredConsent(), null);
});

test("denied browser storage still persists the user's exact choice through existing cookie and event paths", () => {
  const runtime = consentRuntime({ denied: true });
  assert.doesNotThrow(() => runtime.persistConsent(necessary));
  assert.match(runtime.document.cookie, /SameSite=Lax; Secure/);
  const encoded = runtime.document.cookie.split(";")[0].slice("novalure_cookie_consent=".length);
  assert.deepEqual(JSON.parse(decodeURIComponent(encoded)), necessary);
  assert.equal(runtime.events.length, 1);
  assert.equal(runtime.events[0].type, "novalure-cookie-consent");
  assert.equal(runtime.events[0].detail, necessary);
});
