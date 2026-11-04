import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const probeFlag = "--inspect-staged-mail-worker";
const workerPath = "src/lib/crm-mailbox-attachment-worker.cjs";
const helperPath = "src/lib/crm-mailbox-pdf-preflight.cjs";
const exec = promisify(execFile);
const thisScript = fileURLToPath(import.meta.url);

// A separate process releases any native PDF libraries before the test removes
// its private staging directory on Windows. Worker imports resolve there only.
if (process.argv[2] === probeFlag) {
  const input = await readFile("sample.pdf");
  const worker = new Worker(path.resolve(workerPath), {
    workerData: { bytes: input, mimeType: "application/pdf" },
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    execArgv: [],
  });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error("Worker ended before returning the test PDF: " + code)));
    });
    assert.equal(result.ok, true, "the traced worker must accept a passive single-page file");
    assert.deepEqual(Buffer.from(result.bytes), input);
  } finally {
    await worker.terminate();
  }
} else {
  const root = process.cwd();
  const temporaryRoot = await realpath(os.tmpdir());
  const { PDFDocument } = await import("pdf-lib");
  const document = await PDFDocument.create();
  document.addPage().drawText("Synthetic local PDF");
  const sample = await document.save();

  for (const route of ["attachments", "replies"]) {
    test("built " + route + " handler can inspect a PDF using only its traced files", async () => {
      const routeDir = path.join(root, ".next/server/app/api/crm/mailbox", route);
      const trace = JSON.parse(await readFile(path.join(routeDir, "route.js.nft.json"), "utf8"));
      const selected = new Set();
      for (const entry of trace.files) {
        const relative = path.relative(root, path.resolve(routeDir, entry)).split(path.sep).join("/");
        if (relative === workerPath || relative === helperPath || relative.startsWith("node_modules/")) {
          selected.add(relative);
        }
      }
      assert.ok(selected.has(workerPath), "built " + route + ": missing worker");
      assert.ok(selected.has(helperPath), "built " + route + ": missing PDF preflight helper");

      const stage = await mkdtemp(path.join(temporaryRoot, "novalure-mail-trace-"));
      try {
        const files = [...selected];
        for (let offset = 0; offset < files.length; offset += 32) {
          await Promise.all(files.slice(offset, offset + 32).map(async file => {
            const target = path.join(stage, file);
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(path.join(root, file), target);
          }));
        }
        await writeFile(path.join(stage, "sample.pdf"), sample);
        const env = Object.fromEntries(Object.entries(process.env)
          .filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP|PATH|HOME|USERPROFILE)$/i.test(key)));
        await exec(process.execPath, [thisScript, probeFlag], { cwd: stage, env, timeout: 20000, windowsHide: true });
      } finally {
        assert.equal(path.dirname(await realpath(stage)), temporaryRoot);
        assert.ok(path.basename(stage).startsWith("novalure-mail-trace-"));
        await rm(stage, { recursive: true, force: true, maxRetries: 3 });
      }
    });
  }
}
