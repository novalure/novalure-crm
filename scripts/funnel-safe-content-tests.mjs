import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toSafeFunnelText } from "../src/lib/funnel-safe-content.ts";

const root = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("stored paragraph, break, and list markup becomes readable plain text", () => {
  const stored = "<p>Welcome<br>Line two &amp; more</p><ul><li>First</li><li>Second</li></ul>";

  assert.equal(toSafeFunnelText(stored), "Welcome\nLine two & more\n• First\n• Second");
});

test("executable containers, URLs, and event attributes are discarded with their markup", () => {
  const stored = [
    "<script>alert('script')</script>",
    "<style>body{display:none}</style>",
    "<svg onload=alert('svg')><text>svg payload</text></svg>",
    "<math><mtext>math payload</mtext></math>",
    "<iframe srcdoc='<script>alert(1)</script>'></iframe>",
    "<img src=x onerror=alert('image')>",
    "<p onmouseover=alert('event')>Safe paragraph</p>",
    "<a href='javascript:alert(1)' onclick='alert(2)'>Safe link label</a>",
  ].join("");
  const text = toSafeFunnelText(stored);

  assert.equal(text, "Safe paragraph\nSafe link label");
  assert.doesNotMatch(text, /script|style|svg|math|iframe|onerror|onmouseover|onclick|javascript:/i);
});

test("encoded token answers stay text and React escapes the decoded angle brackets", () => {
  const tokenAnswer = "&lt;img src=x onerror=alert(1)&gt; &amp; &#x3c;script&#x3e;alert(2)&#x3c;/script&#x3e;";
  const text = toSafeFunnelText(tokenAnswer);
  const rendered = renderToStaticMarkup(createElement("span", null, text));

  assert.equal(text, "<img src=x onerror=alert(1)> & <script>alert(2)</script>");
  assert.doesNotMatch(rendered, /<img\b|<script\b/i);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(rendered, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test("a raw token answer cannot create an element inside stored rich text", () => {
  const resolvedStoredContent = "<p>Hello <img src=x onerror=alert(document.domain)></p>";
  const text = toSafeFunnelText(resolvedStoredContent);
  const rendered = renderToStaticMarkup(createElement("span", null, text));

  assert.equal(text, "Hello");
  assert.equal(rendered, "<span>Hello</span>");
});

test("plain javascript-like text is inert because no link or markup is produced", () => {
  const text = toSafeFunnelText("javascript:alert(1)");
  const rendered = renderToStaticMarkup(createElement("code", null, text));

  assert.equal(rendered, "<code>javascript:alert(1)</code>");
  assert.doesNotMatch(rendered, /href=|src=/i);
});

test("conversion and server rendering are deterministic across repeated calls", () => {
  const stored = "<P>One&nbsp;two</P>\r\n<LI>Three &#x1F680;</LI><!-- ignored -->";
  const expected = "One two\n• Three 🚀";

  for (let index = 0; index < 20; index += 1) {
    const text = toSafeFunnelText(stored);
    assert.equal(text, expected);
    assert.equal(renderToStaticMarkup(createElement("span", null, text)), "<span>One two\n• Three 🚀</span>");
  }
});

test("renderer and designer contain no trusted-HTML escape hatch", async () => {
  const [renderer, designer, boundary] = await Promise.all([
    source("src/components/funnel-renderer.tsx"),
    source("src/components/funnel-blueprint-designer.tsx"),
    source("src/lib/funnel-safe-content.ts"),
  ]);

  assert.doesNotMatch(renderer, /dangerouslySetInnerHTML|\.innerHTML\b/);
  assert.doesNotMatch(designer, /dangerouslySetInnerHTML|\.innerHTML\b/);
  assert.match(renderer, /toSafeFunnelText/);
  assert.match(designer, /toSafeFunnelText/);
  assert.match(renderer, /Stored HTML is shown as plain text for safety/);
  assert.match(designer, /HTML is shown only as safe plain text/);
  assert.doesNotMatch(boundary, /DOMParser|document\.|window\.|dangerouslySetInnerHTML|\.innerHTML\b/);
});
