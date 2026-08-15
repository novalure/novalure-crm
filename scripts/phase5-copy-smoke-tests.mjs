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

test("login inputs stay empty and use neutral placeholders", () => {
  const i18n = readText("src/lib/i18n.ts");
  const loginPage = readText("src/app/login/page.tsx");

  assert.doesNotMatch(i18n, /placeholderEmail: "franz@novalure\.local"/);
  assert.doesNotMatch(i18n, /placeholderEmail: "franz@novalure\.eu"/);
  assert.match(i18n, /placeholderEmail: "name@company\.com"/);
  assert.match(i18n, /placeholderEmail: "name@firma\.com"/);
  assert.doesNotMatch(loginPage, /defaultValue=\{email/);
  assert.doesNotMatch(loginPage, /value=\{email/);
});

test("login redirects keep personal data out of query strings", () => {
  const loginRoute = readText("src/app/api/auth/login/route.ts");
  const loginPage = readText("src/app/login/page.tsx");
  const resetConfirmRoute = readText("src/app/api/auth/password-reset/confirm/route.ts");
  const urlHygiene = readText("src/components/login-url-hygiene.tsx");

  assert.doesNotMatch(loginRoute, /searchParams\.set\("email"/);
  assert.doesNotMatch(resetConfirmRoute, /searchParams\.set\("email"/);
  assert.doesNotMatch(loginPage, /getQueryValue\(query\.email/);
  assert.doesNotMatch(loginPage, /for \(const key of \["email"/);
  assert.match(loginPage, /<LoginUrlHygiene clearError=\{Boolean\(errorText\)\} \/>/);
  assert.match(urlHygiene, /url\.searchParams\.delete\("email"\)/);
  assert.match(urlHygiene, /url\.searchParams\.delete\("error"\)/);
});

test("lead timeline distinguishes an empty selection from an empty timeline", () => {
  const i18n = readText("src/lib/i18n.ts");
  const leadInbox = readText("src/components/lead-inbox.tsx");

  assert.match(i18n, /noTimeline: "No timeline entries yet\."/);
  assert.match(i18n, /noTimeline: "Noch keine Verlaufseinträge\."/);
  assert.match(
    leadInbox,
    /selected\.activities\.length === 0 && selected\.conversations\.length === 0[\s\S]*?\{text\.noTimeline\}/,
  );
  assert.match(leadInbox, /\) : \(\s*<div[\s\S]*?\{text\.noLead\}/);
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

  assert.match(germanLanding, /login: "Team-Login"/);
  assert.match(germanLanding, /primaryCta: "Pipeline-Audit anfragen"/);
  assert.match(germanLanding, /secondaryCta: "CRM-Vorschau ansehen"/);
  assert.match(germanLanding, /Anonymisierte Beispielansicht/);
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

test("public landing uses anonymized CRM proof and real privacy content instead of placeholders", () => {
  const i18n = readText("src/lib/i18n.ts");
  const landing = readText("src/components/public-crm-landing.tsx");
  const landingV2Copy = readText("src/lib/public-crm-landing-v2.ts");

  assert.doesNotMatch(i18n, /Freigegebenes Kundenlogo/);
  assert.doesNotMatch(i18n, /Approved client logo/);
  assert.doesNotMatch(i18n, /Customer proof placeholders/);
  assert.match(i18n, /Vertrauen ohne öffentliche Kundendaten/);
  assert.match(i18n, /Trust without exposing client data/);
  assert.match(i18n, /Anonymisierter Beispielbefund/);
  assert.match(i18n, /Anonymized example finding/);
  assert.match(i18n, /hello@novalure\.eu/);
  assert.match(landing, /copy\.preview\.columns\.map/);
  assert.match(landing, /copy\.privacy\.items\.map/);
  assert.match(landing, /publicLegalLinks\.map/);
  assert.match(landingV2Copy, /Anonymisierte Beispielansicht · keine echten Kundendaten/);
  assert.match(landingV2Copy, /Schematische Darstellung – keine echten Kundendaten/);
  assert.match(landingV2Copy, /Anonymised example view · no real customer data/);
  assert.match(landingV2Copy, /Schematic illustration – no real customer data/);
  assert.doesNotMatch(landing, /href="#"/);
  assert.doesNotMatch(landing, /proofPlaceholders/);
});

test("public website subpages retain the established landing page design system", () => {
  const shell = readText("src/components/public-site-shell.tsx");
  const shellStyles = readText("src/components/public-site-shell.module.css");
  const legalPage = readText("src/components/legal-page.tsx");

  assert.match(shell, /className=\{styles\.wordmark\}>Novalure<span>\.<\/span>/);
  assert.match(shell, /novalure-public-legacy/);
  assert.match(shell, /publicLegalLinks\.map/);
  assert.match(shellStyles, /--nl-bg: #faf9f7/);
  assert.match(shellStyles, /--nl-blue: #2d68f0/);
  assert.match(shellStyles, /background: rgb\(250 249 247 \/ 92%\)/);
  assert.doesNotMatch(shellStyles, /--nl-gold: #ffd43b/);
  assert.match(legalPage, /<PublicSiteShell currentPath=\{path\} language=\{language\}>/);

  for (const route of [
    "src/app/login/page.tsx",
    "src/app/login/forgot-password/page.tsx",
    "src/app/login/reset-password/page.tsx",
    "src/app/unsubscribe/page.tsx",
    "src/app/not-found.tsx",
  ]) {
    assert.match(readText(route), /<PublicSiteShell/);
  }

  assert.match(readText("src/app/not-found.tsx"), /resolvePublicPageLanguage\(requestHeaders, \{\}\)/);
  assert.match(readText("src/lib/page-metadata.ts"), /persistedLanguage: requestHeaders\.get\(languageRequestHeaderName\)/);
  assert.match(readText("src/app/unsubscribe/page.tsx"), /getUnsubscribeLanguageHref/);
});
