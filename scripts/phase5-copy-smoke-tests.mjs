import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

test("user-facing copy no longer exposes local-session prototype wording", () => {
  const i18n = readText("src/lib/i18n.ts");
  const forbidden = [
    "Local actions",
    "Task created in this session",
    "Sequence draft saved locally",
    "for this session",
    "Local preview",
    "Local meeting settings loaded",
    "Saved locally",
    "Lokale Aktionen",
    "in dieser Sitzung",
    "lokal in diesem Workspace",
    "Lokale Vorschau",
    "Lokale Meeting-Einstellungen",
    "Lokal gespeichert",
    "Verbleibende lokale",
    "lokaler Bearbeitung",
  ];

  for (const phrase of forbidden) {
    assert.ok(!i18n.includes(phrase), `Unexpected prototype wording: ${phrase}`);
  }
});

test("replacement copy uses production-safe draft and inline wording", () => {
  const i18n = readText("src/lib/i18n.ts");

  assert.match(i18n, /Recent actions/);
  assert.match(i18n, /Task created"/);
  assert.match(i18n, /Sequence draft saved in this workspace/);
  assert.match(i18n, /Draft preview/);
  assert.match(i18n, /Meeting draft loaded/);
  assert.match(i18n, /Inline-Bearbeitung/);
  assert.match(i18n, /Aktuelle Aktionen/);
  assert.match(i18n, /Aufgabe wurde angelegt/);
  assert.match(i18n, /Sequenzentwurf wurde in diesem Workspace gespeichert/);
  assert.match(i18n, /Entwurfsvorschau/);
  assert.match(i18n, /Meeting-Entwurf geladen/);
});

test("login placeholders use a real product domain instead of a local demo address", () => {
  const i18n = readText("src/lib/i18n.ts");

  assert.doesNotMatch(i18n, /placeholderEmail: "franz@novalure\.local"/);
  assert.match(i18n, /placeholderEmail: "franz@novalure\.eu"/);
});

test("public landing keeps German copy localized and gives customers a clear login path", () => {
  const i18n = readText("src/lib/i18n.ts");
  const landing = readText("src/components/public-crm-landing.tsx");
  const redirect = readText("src/components/public-hash-route-login-redirect.tsx");
  const publicLandingStart = i18n.indexOf("export const crmPublicLandingPageCopy");
  const publicLanding = i18n.slice(publicLandingStart, i18n.indexOf("export const dashboardCopy", publicLandingStart));
  const germanLanding = publicLanding.slice(publicLanding.indexOf("  de: {"));

  for (const phrase of [
    "Operating Layer",
    "From first click",
    "Lead Infrastructure",
    "System-Layer",
    "Lead-Operation",
    "CRM-ready",
    "Next Action",
    "CRM-Preview",
    "Self-Serve",
  ]) {
    assert.ok(!germanLanding.includes(phrase), `Unexpected public DE landing phrase: ${phrase}`);
  }

  assert.match(germanLanding, /login: "Anmelden"/);
  assert.match(germanLanding, /secondaryCta: "Zum Login"/);
  assert.match(landing, /<PublicHashRouteLoginRedirect language=\{language\} \/>/);
  assert.match(redirect, /"leadinbox"/);
  assert.match(redirect, /window\.location\.replace\(`\/login\?\$\{params\.toString\(\)\}`\)/);
});

test("public cookie banner exposes GDPR choices and privacy link", () => {
  const i18n = readText("src/lib/i18n.ts");
  const cookieButton = readText("src/components/cookie-consent-button.tsx");
  const landing = readText("src/components/public-crm-landing.tsx");

  assert.match(i18n, /acceptAll: "Alle akzeptieren"/);
  assert.match(i18n, /rejectOptional: "Nur essenzielle"/);
  assert.match(i18n, /customize: "Auswählen"/);
  assert.match(i18n, /privacyLink: "Datenschutzerklärung"/);
  assert.match(cookieButton, /type CookieConsentChoice = "necessary" \| "all" \| "custom"/);
  assert.match(cookieButton, /choose\("custom"\)/);
  assert.match(cookieButton, /privacyHref/);
  assert.match(landing, /privacyHref=\{privacyHref\}/);
});

test("public landing includes trust, hosting and approval placeholders", () => {
  const i18n = readText("src/lib/i18n.ts");
  const landing = readText("src/components/public-crm-landing.tsx");

  assert.match(i18n, /label: "Hosting und Datenbank"/);
  assert.match(i18n, /Vercel, Neon Postgres/);
  assert.match(i18n, /Freigegebenes Kundenlogo/);
  assert.match(i18n, /hello@novalure\.eu/);
  assert.match(landing, /copy\.trust\.details\.map/);
  assert.match(landing, /copy\.trust\.proofPlaceholders\.map/);
});
