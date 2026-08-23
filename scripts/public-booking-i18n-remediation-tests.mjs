import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function readProjectFile(path) {
  return readFileSync(join(rootDir, path), "utf8");
}

function loadPublicLanguageExports() {
  const path = "src/lib/public-language.ts";
  const { outputText } = ts.transpileModule(readProjectFile(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: path,
  });
  const cjsModule = { exports: {} };
  vm.runInNewContext(
    outputText,
    {
      exports: cjsModule.exports,
      module: cjsModule,
      require(specifier) {
        assert.equal(specifier, "@/lib/launch-scope");
        return { evaluateLaunchScope: () => ({ allowed: false }) };
      },
      URLSearchParams,
    },
    { filename: path },
  );
  return cjsModule.exports;
}

test("public language links replace lang without losing query parameters or fragments", () => {
  const { withPublicLanguage } = loadPublicLanguageExports();

  assert.equal(withPublicLanguage("/privacy", "en"), "/privacy?lang=en");
  assert.equal(withPublicLanguage("/privacy?source=footer", "de"), "/privacy?source=footer&lang=de");
  assert.equal(withPublicLanguage("/privacy?lang=de#retention", "en"), "/privacy?lang=en#retention");
  assert.equal(withPublicLanguage("/#audit", "en"), "/?lang=en#audit");
});

test("booking page uses the canonical page language for metadata, markup and availability labels", () => {
  const bookingPage = readProjectFile("src/app/book/public-booking-page.tsx");
  const meetingRepository = readProjectFile("src/lib/db/meeting-repositories.ts");

  assert.match(bookingPage, /resolvePublicPageLanguage\(requestHeaders, query\)/);
  assert.doesNotMatch(bookingPage, /resolvePublicLanguage\(/);
  assert.match(bookingPage, /locale: getLocale\(language\)/);
  assert.match(bookingPage, /data-public-language=\{language\}/);
  assert.match(bookingPage, /lang=\{language\}/);
  assert.match(meetingRepository, /new Intl\.DateTimeFormat\(locale, \{/);
  assert.doesNotMatch(
    meetingRepository.slice(
      meetingRepository.indexOf("async function getMeetingAvailabilityForPage"),
      meetingRepository.indexOf("export async function getPublicMeetingAvailability"),
    ),
    /new Intl\.DateTimeFormat\("de-AT"/,
  );
});

test("booking content is localized safely and missing resources are non-indexable 404s", () => {
  const bookingPage = readProjectFile("src/app/book/public-booking-page.tsx");
  const canonicalPage = readProjectFile("src/app/book/[slug]/[meetingSlug]/page.tsx");
  const legacyPage = readProjectFile("src/app/book/[slug]/page.tsx");

  assert.match(bookingPage, /getLocalizedConfirmationTitle/);
  assert.match(bookingPage, /calendarCommandCenterCopy\[language\]\.meetingTemplates/);
  assert.match(bookingPage, /aria-label=\{language === "de" \? "Unternehmen" : "Company"\}/);
  assert.match(bookingPage, /robots: \{ follow: false, index: false \}/);
  assert.match(bookingPage, /if \(!savedPage\?\.id \|\| !savedPage\.workspaceId\) notFound\(\)/);
  assert.match(bookingPage, /if \(!publicBookingActionLaunchOff && !availability\) notFound\(\)/);
  assert.match(canonicalPage, /generatePublicBookingMetadata/);
  assert.match(legacyPage, /robots: \{ follow: false, index: false \}/);
  assert.match(legacyPage, /notFound\(\)/);
  assert.doesNotMatch(legacyPage, /getLegacyPublicMeetingPageRoute\([^;]+\.catch\(/);
  assert.doesNotMatch(legacyPage, /Meeting-Link nicht eindeutig|Meeting nicht gefunden/);
});

test("public shells expose their rendered language and a global consent preference entry", () => {
  const shell = readProjectFile("src/components/public-site-shell.tsx");
  const sync = readProjectFile("src/components/language-html-sync.tsx");

  assert.match(shell, /data-public-language=\{language\}/);
  assert.match(shell, /getCrmLandingPageCopy\(language\)\.cookieConsent/);
  assert.match(shell, /<CookieConsentButton/);
  assert.match(shell, /cookieHref=\{cookieHref\}/);
  assert.match(shell, /privacyHref=\{privacyHref\}/);
  assert.match(shell, /withPublicLanguage\("\/cookies", language\)/);
  assert.match(shell, /withPublicLanguage\("\/privacy", language\)/);
  assert.match(shell, /const hasStandaloneCookieConsent = currentPath === "\/login"/);
  assert.match(shell, /!hasStandaloneCookieConsent \? \(/);
  assert.match(sync, /function readRenderedPageLanguage\(\)/);
  assert.ok(
    sync.indexOf("const renderedLanguage = readRenderedPageLanguage()") <
      sync.indexOf("const queryLanguage = new URLSearchParams"),
  );
  assert.match(sync, /new MutationObserver/);
});
