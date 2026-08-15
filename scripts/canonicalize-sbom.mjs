#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/canonicalize-sbom.mjs <cyclonedx-json>");

const sbom = JSON.parse(await readFile(path, "utf8"));
if (!Array.isArray(sbom.components)) throw new Error("CycloneDX components array is missing");

const components = sbom.components.map((component) => {
  const name = [component.group, component.name].filter(Boolean).join("/");
  return [component.type ?? "", name, component.version ?? "", component.purl ?? ""].join("\t");
});

for (const component of [...new Set(components)].sort()) console.log(component);
