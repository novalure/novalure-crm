#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const allowedLockedLicenseExpressions = Object.freeze([
  "(MIT AND Zlib)",
  "(MIT OR CC0-1.0)",
  "(MPL-2.0 OR Apache-2.0)",
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 AND LGPL-3.0-or-later",
  "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT OR SEE LICENSE IN FEEL-FREE.md",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
]);

export function evaluateDependencyLicensePolicy(lockfile) {
  const errors = [];
  if (lockfile?.lockfileVersion !== 3 || !lockfile.packages || typeof lockfile.packages !== "object") {
    return Object.freeze({ errors: ["package-lock.json must use lockfileVersion 3 with a packages inventory."], licenses: 0, packages: 0 });
  }
  const allowed = new Set(allowedLockedLicenseExpressions);
  const licenses = new Set();
  let packages = 0;
  for (const [packagePath, entry] of Object.entries(lockfile.packages)) {
    if (!packagePath) continue;
    packages += 1;
    if (!packagePath.startsWith("node_modules/") || entry?.link === true) {
      errors.push(`${packagePath}: linked or non-node_modules package entries require explicit review.`);
      continue;
    }
    const license = typeof entry?.license === "string" ? entry.license.trim() : "";
    if (!license) {
      errors.push(`${packagePath}: missing license metadata.`);
      continue;
    }
    licenses.add(license);
    if (!allowed.has(license)) errors.push(`${packagePath}: unapproved license expression ${license}.`);
  }
  if (packages === 0) errors.push("package-lock.json contains no dependency packages.");
  return Object.freeze({ errors: Object.freeze(errors), licenses: licenses.size, packages });
}

async function main() {
  const lockfilePath = path.resolve("package-lock.json");
  let lockfile;
  try {
    lockfile = JSON.parse(await readFile(lockfilePath, "utf8"));
  } catch {
    throw new Error("package-lock.json could not be read as JSON.");
  }
  const result = evaluateDependencyLicensePolicy(lockfile);
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  console.log(`DEPENDENCY_LICENSE_POLICY_OK packages=${result.packages} licenses=${result.licenses}`);
}

const directEntrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (directEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Dependency license policy failed.");
    process.exitCode = 1;
  });
}
