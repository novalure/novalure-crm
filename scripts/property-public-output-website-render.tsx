import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile, writeFile } from "node:fs/promises";
import { WebExposeWebsite } from "../src/components/web-expose-website";
import type { WebExposePublic } from "../src/lib/web-expose";

Object.assign(globalThis, { React });
async function main() {
  const files = JSON.parse(await readFile(process.argv[2], "utf8")) as { input: string; output: string }[];
  for (const file of files) {
    const data = JSON.parse(await readFile(file.input, "utf8")) as WebExposePublic;
    await writeFile(file.output, renderToStaticMarkup(<WebExposeWebsite data={data} preview />));
  }
}
void main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
