#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  executeA11yPreviewFixtureLifecycle,
  parseA11yPreviewFixtureLifecycleInput,
} from "./lib/a11y-preview-fixture-lifecycle.mjs";

async function readBoundedStdin(maximumBytes = 128 * 1024) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > maximumBytes) throw new Error("A11Y_FIXTURE_INPUT_TOO_LARGE");
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks, byteLength);
  try {
    return source.toString("utf8");
  } finally {
    source.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  if (argv.length !== 2 || argv[0] !== "--execute" || argv[1] !== "--input-stdin") {
    throw new Error("A11Y_FIXTURE_ARGUMENT_INVALID");
  }
  const input = parseA11yPreviewFixtureLifecycleInput(await readBoundedStdin());
  const summary = await executeA11yPreviewFixtureLifecycle({ environment, input });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

export function safeLifecycleErrorCode(error) {
  const candidate = typeof error?.code === "string"
    ? error.code
    : error instanceof Error
      ? error.message
      : "";
  return /^[A-Z][A-Z0-9_]{2,96}$/u.test(candidate) ? candidate : "UNEXPECTED_FAILURE";
}

const directEntrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (directEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`[qa-a11y-fixture-lifecycle] status=FAIL code=${safeLifecycleErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
