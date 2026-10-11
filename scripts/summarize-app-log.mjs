#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/summarize-app-log.mjs <log-file>");

let content;
try {
  content = await readFile(path);
} catch (error) {
  if (error?.code === "ENOENT") {
    console.log("app_log_present=false");
    process.exit(0);
  }
  throw error;
}

const lines = content.length ? content.toString("utf8").split(/\r?\n/).length : 0;
console.log("app_log_present=true");
console.log(`app_log_bytes=${content.length}`);
console.log(`app_log_lines=${lines}`);
console.log(`app_log_sha256=${createHash("sha256").update(content).digest("hex")}`);
