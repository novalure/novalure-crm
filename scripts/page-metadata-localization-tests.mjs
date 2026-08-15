#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("public metadata uses the same query and persisted-language resolver as page content", async () => {
  const helper = await read("src/lib/page-metadata.ts");
  assert.match(helper, /requestedLanguage: query\.lang/);
  assert.match(helper, /persistedLanguage: requestHeaders\.get\(languageRequestHeaderName\)/);
  assert.match(helper, /acceptLanguage: requestHeaders\.get\("accept-language"\)/);
  assert.match(helper, /title: `\$\{input\.title\} \| Novalure CRM`/);
  assert.match(helper, /canonical: canonicalUrl\.toString\(\)/);
});

test("all legal and public status pages generate localized server metadata", async () => {
  const paths = ["privacy", "cookies", "terms", "imprint", "data-deletion", "meta", "unsubscribe"];
  for (const path of paths) {
    const source = await read(`src/app/${path}/page.tsx`);
    assert.match(source, /export async function generateMetadata/);
    assert.match(source, /resolvePublicPageLanguage\(requestHeaders, query\)/);
    assert.doesNotMatch(source, /export const metadata: Metadata/);
  }
});

test("404 metadata is localized and remains non-indexable", async () => {
  const notFound = await read("src/app/not-found.tsx");
  assert.match(notFound, /export async function generateMetadata/);
  assert.match(notFound, /Seite nicht gefunden \| Novalure CRM/);
  assert.match(notFound, /Page not found \| Novalure CRM/);
  assert.match(notFound, /robots: \{ follow: false, index: false \}/);
});

test("legacy data-deletion alias forwards generated metadata", async () => {
  const alias = await read("src/app/datadeletion/page.tsx");
  assert.match(alias, /export \{ generateMetadata \}/);
  assert.doesNotMatch(alias, /export \{ metadata \}/);
});
