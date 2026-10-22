import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  crmEntryRequestHeaderName, getTrustedCrmCountry, guestCrmPreferenceCookieName,
  isLanguagePreference, resolveAutomaticCrmLanguage, resolveCrmLanguage,
} from "../src/lib/crm-language";
import { proxy } from "../src/proxy";
import { LanguagePreferenceSelect } from "../src/components/language-preference-select";

test("simulated CRM geo uses exactly AT DE CH LU LI, with English for missing or invalid country", () => {
  for (const country of ["AT", "DE", "CH", "LU", "LI", "at", " li "]) {
    assert.equal(resolveAutomaticCrmLanguage(country), "de", country);
  }
  for (const country of ["FR", "IE", "US", "ES", "PT", "GB", "ZZ", "LUX", "LIE", "", "?", "de-DE", null, undefined, 42]) {
    assert.equal(resolveAutomaticCrmLanguage(country), "en", String(country));
  }
  assert.equal(resolveCrmLanguage("en", "AT"), "en");
  assert.equal(resolveCrmLanguage("de", "IE"), "de");
  assert.equal(resolveCrmLanguage("auto", "AT"), "de");
  assert.equal(resolveCrmLanguage("auto", "IE"), "en");
  assert.equal(resolveCrmLanguage(undefined, undefined), "en");
  for (const preference of ["auto", "de", "en"]) assert.equal(isLanguagePreference(preference), true);
  for (const preference of ["DE", "es", "", null, undefined]) assert.equal(isLanguagePreference(preference), false);
});

test("country comes only from the Vercel header in a Vercel runtime", () => {
  const headers = new Headers({ "x-vercel-ip-country": "AT", "cf-ipcountry": "DE", "x-country-code": "CH", "accept-language": "en-US" });
  assert.equal(getTrustedCrmCountry(headers, true), "AT");
  assert.equal(getTrustedCrmCountry(headers, false), null);
  headers.delete("x-vercel-ip-country");
  assert.equal(getTrustedCrmCountry(headers, true), null);
});

test("login ignores browser language and legacy shared cookie; explicit guest choice/reset remain distinct", async () => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = "1";
  try {
    const request = (url: string, country: string, cookie = "") => new NextRequest(url, {
      headers: { "x-vercel-ip-country": country, "accept-language": country === "AT" ? "en-US" : "de-DE", cookie },
    });
    const appLanguage = (response: Response) => response.headers.get("x-middleware-request-x-novalure-language");
    assert.equal(appLanguage(await proxy(request("https://crm.example/login", "AT", "novalure.system-language=en"))), "de");
    assert.equal(appLanguage(await proxy(request("https://crm.example/login?lang=de", "FR"))), "en");
    const explicit = await proxy(request("https://crm.example/login?languagePreference=en&lang=en", "AT"));
    assert.equal(appLanguage(explicit), "en");
    assert.match(explicit.headers.get("set-cookie") ?? "", /novalure\.crm-language-preference=en/);
    assert.equal(appLanguage(await proxy(request("https://crm.example/login", "AT", `${guestCrmPreferenceCookieName}=en`))), "en");
    const automatic = await proxy(request("https://crm.example/login?languagePreference=auto", "AT", `${guestCrmPreferenceCookieName}=en`));
    assert.equal(appLanguage(automatic), "de");
    assert.match(automatic.headers.get("set-cookie") ?? "", /novalure\.crm-language-preference=auto/);
    const prefetchCases: Array<Record<string, string>> = [{ "next-router-prefetch": "1" }, { purpose: "prefetch" }, { "sec-purpose": "prefetch;prerender" }];
    for (const prefetchHeaders of prefetchCases) {
      const prefetch = new NextRequest("https://crm.example/login?languagePreference=en&lang=en", {
        headers: { "x-vercel-ip-country": "AT", ...prefetchHeaders },
      });
      assert.equal((await proxy(prefetch)).headers.get("set-cookie"), null, "speculative navigation must not persist a manual choice");
    }
    const publicPage = await proxy(request("https://crm.example/?lang=es", "AT"));
    assert.equal(publicPage.headers.get("x-middleware-request-x-novalure-public-language"), "es");
    assert.equal(publicPage.headers.get(`x-middleware-request-${crmEntryRequestHeaderName}`), "1");
    for (const path of ["/login/forgot-password", "/login/reset-password"]) {
      assert.equal(appLanguage(await proxy(request(`https://crm.example${path}?lang=en`, "AT"))), "de");
      assert.equal(appLanguage(await proxy(request(`https://crm.example${path}?lang=de&languagePreference=en`, "AT"))), "en");
      const source = readFileSync(new URL(`../src/app${path}/page.tsx`, import.meta.url), "utf8");
      assert.equal(source.match(/resolveLanguage\(requestHeaders\.get\(languageRequestHeaderName\), "en"\)/g)?.length, 2, "metadata and page share the resolved request language");
      assert.match(source, /lang: language, languagePreference: language/);
      assert.match(source, /data-crm-login-language lang=\{language\}/);
    }
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});

test("one language control exposes native language names, automatic mode and truthful pending/failure state in DE and EN", () => {
  for (const language of ["de", "en"] as const) {
    const render = (saveState: "idle" | "saving" | "error" | "unavailable") => renderToStaticMarkup(createElement(LanguagePreferenceSelect, {
      language, preference: "auto", saveState, onChange() {}, showDescription: true,
    }));
    const html = render("idle");
    assert.match(html, /<label[^>]*for="[^"]+"/);
    assert.match(html, /<option value="auto" selected="">/);
    assert.match(html, /<option value="de">Deutsch<\/option>/);
    assert.match(html, /<option value="en">English<\/option>/);
    assert.match(html, language === "de" ? /Automatisch \(Standort\)/ : /Automatic \(location\)/);
    assert.match(render("saving"), /disabled=""/);
    assert.match(render("error"), /role="alert"/);
    assert.doesNotMatch(render("error"), /Language saved\.|Sprache gespeichert\./);
    assert.match(render("unavailable"), language === "de" ? /nicht verfügbar/ : /unavailable/);
  }
});

type RouteState = {
  session: Record<string, unknown> | null;
  csrfAllowed: boolean;
  failSave: boolean;
  saves: unknown[][];
};

function loadLanguageRoute(state: RouteState) {
  const source = readFileSync(new URL("../src/app/api/settings/language/route.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const cjsModule = { exports: {} as { POST(request: Request): Promise<Response> } };
  const require = createRequire(import.meta.url);
  vm.runInNewContext(outputText, {
    module: cjsModule, exports: cjsModule.exports,
    require(specifier: string) {
      if (specifier === "next/server") return require(specifier);
      if (specifier === "@/lib/auth/session") return { getRequestSession: async () => state.session };
      if (specifier === "@/lib/auth/response-security") return { protectAuthResponse(response: Response) { response.headers.set("Cache-Control", "private, no-store"); return response; } };
      if (specifier === "@/lib/security/csrf") return { enforceCsrfForSession: async () => state.csrfAllowed ? { ok: true } : { ok: false, response: Response.json({ error: "csrf_rejected" }, { status: 403 }) } };
      if (specifier === "@/lib/crm-language") return { isLanguagePreference };
      if (specifier === "@/lib/db/language-preference-repository") return { saveAccountLanguagePreference: async (...args: unknown[]) => { state.saves.push(args); if (state.failSave) throw new Error("SYNTHETIC_PRIVATE_DATABASE_DETAIL"); return args[1]; } };
      throw new Error(`Unexpected dependency ${specifier}`);
    },
  }, { filename: "language-route.ts" });
  return cjsModule.exports.POST;
}

test("personal save route requires auth, CSRF, exact current account and a valid mode; failed saves stay failed", async () => {
  const session = { userId: "synthetic-user-a", authIdentityId: "synthetic-identity-a", role: "assistant", productRole: "viewer" };
  const state: RouteState = { session: null, csrfAllowed: true, failSave: false, saves: [] };
  const post = loadLanguageRoute(state);
  const request = (body: unknown) => new Request("https://crm.example/api/settings/language", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = { preference: "en", expectedUserId: session.userId };
  assert.equal((await post(request(payload))).status, 401);
  state.session = session; state.csrfAllowed = false;
  assert.equal((await post(request(payload))).status, 403);
  state.csrfAllowed = true;
  assert.equal((await post(request({ ...payload, preference: "es" }))).status, 400);
  assert.equal((await post(request(null))).status, 400);
  assert.equal((await post(request({ ...payload, expectedUserId: "synthetic-user-b" }))).status, 409);
  assert.equal(state.saves.length, 0);
  state.session = { ...session, serviceIdentity: {} };
  assert.equal((await post(request(payload))).status, 403);
  state.session = session; state.failSave = true;
  const failed = await post(request(payload));
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await failed.json(), { error: "language_save_unavailable", persisted: false });
  state.failSave = false;
  for (const preference of ["de", "en", "auto"]) {
    const response = await post(request({ ...payload, preference }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(await response.json(), { preference, persisted: true });
  }
});
