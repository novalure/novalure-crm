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

test("Figtree is loaded centrally and wired through the root layout", async () => {
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
  assert.match(layout, /themeColor: "#faf9f7"/);
  assert.match(globals, /--font-sans: var\(--font-figtree\), system-ui, sans-serif/);
  assert.match(globals, /font-family: var\(--font-figtree\), system-ui, sans-serif/);
});

test("Novalure website tokens are centralized without mutating the legacy palette", async () => {
  const [globals, tokens] = await Promise.all([
    read("src/app/globals.css"),
    read("src/styles/novalure-tokens.css"),
  ]);

  const requiredTokens = {
    "--nl-bg": "#faf9f7",
    "--nl-surface": "#ffffff",
    "--nl-ink": "#33302b",
    "--nl-muted": "#6f6a63",
    "--nl-blue": "#2d68f0",
    "--nl-blue-dark": "#1e4fc2",
    "--nl-border": "#e3ded5",
    "--nl-success-text": "#176344",
    "--nl-warning-text": "#76531d",
    "--nl-danger-text": "#8a3026",
  };

  for (const [name, value] of Object.entries(requiredTokens)) {
    assert.ok(tokens.includes(`${name}: ${value};`), `${name} must equal ${value}`);
  }

  assert.match(globals, /@import "\.\.\/styles\/novalure-tokens\.css"/);
  assert.match(globals, /--background: #d9ecff/);
});

test("required text and status token pairs meet WCAG AA contrast", () => {
  const pairs = [
    ["#ffffff", "#2d68f0"],
    ["#33302b", "#ffffff"],
    ["#6f6a63", "#ffffff"],
    ["#176344", "#edfff6"],
    ["#76531d", "#fbf1df"],
    ["#8a3026", "#fff1ef"],
    ["#1e4fc2", "#e9f0fe"],
  ];

  for (const [foreground, background] of pairs) {
    assert.ok(
      contrastRatio(foreground, background) >= 4.5,
      `${foreground} on ${background} must meet WCAG AA`,
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
