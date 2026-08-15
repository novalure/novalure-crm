import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function relativeLuminance(hex) {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    ));

  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

test("Inter is bundled for the CRM while the established public theme remains available", async () => {
  const [fonts, globals, layout] = await Promise.all([
    read("src/app/fonts.ts"),
    read("src/app/globals.css"),
    read("src/app/layout.tsx"),
  ]);

  assert.match(fonts, /src: "\.\/fonts\/figtree-latin\.woff2"/);
  assert.match(fonts, /display: "swap"/);
  assert.match(fonts, /weight: "400 800"/);
  assert.match(fonts, /variable: "--font-figtree"/);
  assert.match(layout, /className=\{`\$\{figtree\.variable\} h-full`\}/);
  assert.match(layout, /themeColor: "#d9ecff"/);
  assert.match(globals, /@import "@fontsource-variable\/inter"/);
  assert.match(globals, /--font-sans: var\(--font-figtree\), system-ui, sans-serif/);
  assert.match(globals, /font-family: var\(--font-figtree\), system-ui, sans-serif/);
  assert.match(await read("src/styles/crm-theme.css"), /font-family: "Inter Variable", Inter/);
});

test("current Novalure website tokens drive the authenticated CRM theme", async () => {
  const [crmTheme, globals, tokens] = await Promise.all([
    read("src/styles/crm-theme.css"),
    read("src/app/globals.css"),
    read("src/styles/novalure-tokens.css"),
  ]);

  const requiredTokens = {
    "--nl-ink": "#07080b",
    "--nl-graphite": "#111318",
    "--nl-steel": "#1b2029",
    "--nl-mist": "#f4f6fa",
    "--nl-surface": "#ffffff",
    "--nl-muted": "#667085",
    "--nl-tertiary": "#667085",
    "--nl-gold": "#ffd43b",
    "--nl-gold-strong": "#e4b900",
    "--nl-focus-outline": "#8a6800",
    "--nl-green": "#42d39b",
    "--nl-border": "#dde3ec",
    "--nl-success-text": "#176344",
    "--nl-warning-text": "#76531d",
    "--nl-danger-text": "#8a3026",
  };

  for (const [name, value] of Object.entries(requiredTokens)) {
    assert.ok(tokens.includes(`${name}: ${value};`), `${name} must equal ${value}`);
  }

  assert.match(globals, /@import "\.\.\/styles\/novalure-tokens\.css"/);
  assert.match(globals, /@import "\.\.\/styles\/crm-theme\.css"/);
  assert.match(globals, /--background: var\(--nl-bg\)/);
  assert.doesNotMatch(globals, /--background: #d9ecff/);
  assert.match(crmTheme, /\.crm-app \[data-crm-sidebar\]/);
  assert.match(crmTheme, /var\(--nl-gold\)/);
  assert.match(crmTheme, /var\(--nl-graphite\)/);
});

test("required text and status token pairs meet WCAG AA contrast", () => {
  const pairs = [
    ["#211800", "#ffd43b"],
    ["#ffffff", "#111318"],
    ["#07080b", "#ffffff"],
    ["#667085", "#ffffff"],
    ["#667085", "#f4f6fa"],
    ["#176344", "#edfff6"],
    ["#76531d", "#fbf1df"],
    ["#8a3026", "#fff1ef"],
    ["#6b5200", "#fff8d6"],
  ];

  for (const [foreground, background] of pairs) {
    assert.ok(
      contrastRatio(foreground, background) >= 4.5,
      `${foreground} on ${background} must meet WCAG AA`,
    );
  }
});

test("CRM controls preserve sizing utilities while the public site keeps its established palette", async () => {
  const [crmTheme, globals, mobileMenu, publicLanding, publicSite, publicLegacy] = await Promise.all([
    read("src/styles/crm-theme.css"),
    read("src/app/globals.css"),
    read("src/components/public-crm-mobile-menu.tsx"),
    read("src/components/public-crm-landing.module.css"),
    read("src/components/public-site-shell.module.css"),
    read("src/styles/public-legacy.css"),
  ]);

  const formRule = crmTheme.match(
    /\n\.crm-app input:not\(\[type="button"\]\)[\s\S]*?\{([\s\S]*?)\n\}/,
  )?.[1] ?? "";

  assert.doesNotMatch(formRule, /\bwidth:\s*100%/);
  assert.doesNotMatch(formRule, /\bmin-width:\s*0/);
  assert.match(crmTheme, /:where\(\.crm-app\) :where\([\s\S]*?\{\s*min-width: 0;\s*\}/);
  assert.match(crmTheme, /input::placeholder,[\s\S]*?color: var\(--nl-tertiary\) !important;[\s\S]*?opacity: 1;/);
  assert.match(publicLanding, /--nl-bg: #faf9f7;/);
  assert.match(publicLanding, /--nl-tertiary: #8a837a;/);
  assert.match(publicLanding, /--nl-blue: #2d68f0;/);
  assert.match(publicSite, /--nl-bg: #faf9f7;/);
  assert.match(publicSite, /--nl-tertiary: #8a837a;/);
  assert.match(publicSite, /--nl-blue: #2d68f0;/);
  assert.match(publicLanding, /@media \(max-width: 880px\)/);
  assert.match(mobileMenu, /window\.innerWidth > 880/);
  assert.match(globals, /@import "\.\.\/styles\/public-legacy\.css"/);
  assert.match(publicLegacy, /\.novalure-public-legacy/);
});

test("CRM shell primitives override the generic utility palette", async () => {
  const crmTheme = await read("src/styles/crm-theme.css");

  assert.match(
    crmTheme,
    /\.crm-app \[class~="bg-white"\]:where\(:not\(\[style\*="background-color"\]\)\)/,
  );
  assert.match(
    crmTheme,
    /\.crm-app \[class~="bg-stone-50"\]:where\(:not\(\[style\*="background-color"\]\)\)/,
  );
  assert.match(
    crmTheme,
    /\.crm-app \[class~="border-stone-200"\]:where\(:not\(\[style\*="border-color"\]\)\)/,
  );
  assert.match(
    crmTheme,
    /\.crm-app \[class~="rounded-md"\]:where\(:not\(\[style\*="border-radius"\]\)\)/,
  );
  assert.match(
    crmTheme,
    /\.crm-app :where\(:is\(article, section, aside, details\)\[class~="rounded-lg"\]\[class~="border"\]\[class~="bg-white"\]\)/,
  );
  assert.match(
    crmTheme,
    /\.crm-app :where\([\s\S]*?button\[class~="hover:bg-stone-100"\][\s\S]*?\):hover/,
  );
  assert.match(
    crmTheme,
    /\.crm-app :where\(button:not\(:disabled\), a\[class\*="rounded"\]\):hover/,
  );
  assert.doesNotMatch(
    crmTheme,
    /(?<!:where\():not\(\[style\*=/,
  );
  assert.match(crmTheme, /\.crm-app \[data-crm-sidebar\] \{/);
  assert.match(crmTheme, /\.crm-app \[data-crm-header\] \{/);
  assert.match(crmTheme, /\[data-crm-projects\] summary \{\s*color: #ffffff !important;/);
  assert.match(
    crmTheme,
    /\.crm-app \[role="dialog"\]:where\(:not\(\[data-crm-mobile-drawer\]\)\)/,
  );
});

test("focus outline meets the WCAG non-text contrast threshold on light and dark CRM surfaces", () => {
  const focusPairs = [
    ["#8a6800", "#ffffff"],
    ["#8a6800", "#f4f6fa"],
    ["#8a6800", "#07080b"],
    ["#8a6800", "#111318"],
  ];

  for (const [foreground, background] of focusPairs) {
    assert.ok(
      contrastRatio(foreground, background) >= 3,
      `${foreground} on ${background} must meet WCAG non-text contrast`,
    );
  }
});

test("native UI primitives preserve native props and refs", async () => {
  const [button, field, surface] = await Promise.all([
    read("src/components/ui/button.tsx"),
    read("src/components/ui/field.tsx"),
    read("src/components/ui/surface.tsx"),
  ]);

  assert.match(button, /ComponentPropsWithRef<"button">/);
  assert.match(button, /ref=\{ref\}/);
  assert.match(button, /type=\{type\}/);
  assert.match(button, /"aria-label": string/);
  assert.match(field, /ComponentPropsWithRef<"input">/);
  assert.match(field, /ComponentPropsWithRef<"select">/);
  assert.match(field, /ComponentPropsWithRef<"textarea">/);
  assert.match(field, /htmlFor=\{htmlFor\}/);
  assert.match(field, /type="checkbox"/);
  assert.match(surface, /ComponentPropsWithRef<"div">/);
});

test("foundation controls, focus, semantic status, and live states are accessible", async () => {
  const [css, states, status] = await Promise.all([
    read("src/components/ui/foundations.module.css"),
    read("src/components/ui/states.tsx"),
    read("src/components/ui/status.tsx"),
  ]);

  assert.match(css, /--nl-control-height-compact/);
  assert.match(css, /min-block-size: var\(--nl-control-height-compact\)/);
  assert.match(css, /min-inline-size: var\(--nl-control-height-compact\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(status, /aria-hidden="true" className=\{styles\.statusMarker\}/);
  assert.match(states, /aria-busy="true"/);
  assert.match(states, /role = "alert"/);
  assert.match(states, /ariaLive = "assertive"/);
});

test("visual QA renders mock CRM data only on the exact protected preview branch", async () => {
  const [content, guard, nextConfig, page, styles] = await Promise.all([
    read("src/app/visual-qa/crm/content/page.tsx"),
    read("src/app/visual-qa/crm/preview-guard.ts"),
    read("next.config.ts"),
    read("src/app/visual-qa/crm/page.tsx"),
    read("src/app/visual-qa/crm/visual-qa.module.css"),
  ]);

  assert.match(guard, /process\.env\.VERCEL_ENV === "preview"/);
  assert.match(guard, /process\.env\.VERCEL_GIT_COMMIT_REF === visualQaBranch/);
  assert.match(guard, /codex\/go-live-remediation-2026-08-11/);
  assert.match(page, /notFound\(\)/);
  assert.doesNotMatch(page, /CrmWorkspace/);
  assert.doesNotMatch(page, /getMockCoreCrmData/);
  assert.match(page, /sandbox="allow-same-origin"/);
  assert.match(page, /src="\/visual-qa\/crm\/content"/);
  assert.match(content, /notFound\(\)/);
  assert.match(content, /getMockCoreCrmData\(workspace\.id\)/);
  assert.doesNotMatch(content, /getCoreCrmData\(/);
  assert.match(content, /className=\{styles\.content\} inert/);
  assert.match(page, /follow: false/);
  assert.match(page, /index: false/);
  assert.match(content, /follow: false/);
  assert.match(content, /index: false/);
  assert.match(nextConfig, /source: "\/visual-qa\/crm\/content"/);
  assert.match(nextConfig, /"script-src 'none'"/);
  assert.match(nextConfig, /"connect-src 'none'"/);
  assert.match(nextConfig, /"form-action 'none'"/);
  assert.match(nextConfig, /"frame-ancestors 'self'"/);
  assert.match(nextConfig, /X-Frame-Options", value: "SAMEORIGIN"/);
  assert.match(styles, /width: 390px/);
  assert.match(styles, /height: min\(844px, calc\(100vh - 4rem\)\)/);
  assert.match(styles, /pointer-events: none/);
});
