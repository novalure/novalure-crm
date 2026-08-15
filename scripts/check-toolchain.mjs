#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const expectedNodeVersion = (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim();
const npmUserAgent = process.env.npm_config_user_agent ?? "";
const npmMatch = npmUserAgent.match(/(?:^|\s)npm\/([^\s]+)/);
const npmVersion = npmMatch?.[1] ?? null;

if (process.versions.node !== expectedNodeVersion) {
  throw new Error(`Node.js ${expectedNodeVersion} is required; received ${process.versions.node}.`);
}

if (npmVersion !== null && npmVersion !== "11.9.0") {
  throw new Error(`npm 11.9.0 is required; received ${npmUserAgent || "unknown"}.`);
}

if (packageJson.packageManager !== "npm@11.9.0") {
  throw new Error("packageManager must remain pinned to npm@11.9.0 for reproducible CI installs.");
}

console.log(`Toolchain verified: Node ${process.versions.node}; ${npmUserAgent || "npm version unavailable"}.`);
