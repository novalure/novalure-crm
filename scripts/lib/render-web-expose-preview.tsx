// Run in ordinary React mode; the database suite itself uses react-server.
import { readFile, writeFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { WebExposeWebsite } from "../../src/components/web-expose-website";
import type { WebExposePublic } from "../../src/lib/web-expose";

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("Synthetic input and output paths required");
  const fixture = JSON.parse(await readFile(input, "utf8")) as { data: WebExposePublic; token: string };
  await writeFile(output, renderToStaticMarkup(createElement(WebExposeWebsite, { ...fixture, preview: true })));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
