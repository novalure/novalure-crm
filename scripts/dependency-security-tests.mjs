import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("security pins keep Blob2.8 while removing the vulnerable sanitizer, HTTP and nested OIDC dependency trees", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")), lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  assert.equal(manifest.dependencies["@vercel/blob"], "2.8.0"); assert.equal(manifest.dependencies["@vercel/oidc"], "4.0.6");
  assert.equal(manifest.overrides.dompurify, "3.4.17"); assert.equal(manifest.overrides.undici, "6.29.1");
  const packages = Object.entries(lock.packages);
  assert.ok(packages.some(([key, value]) => key.endsWith("node_modules/@vercel/oidc") && value.version === "4.0.6"));
  for (const [key, value] of packages) {
    if (key.endsWith("node_modules/@vercel/oidc")) assert.equal(value.version, "4.0.6", `unpatched nested OIDC: ${key}`);
    if (key.endsWith("node_modules/@vercel/cli-config")) assert.equal(value.version, "0.3.6");
    if (key.endsWith("node_modules/dompurify")) assert.equal(value.version, "3.4.17");
    if (key.endsWith("node_modules/undici")) assert.equal(value.version, "6.29.1");
  }
});
test("actual OIDC4 SDK honors request context, rotating files, failure closed and environment fallback without networking", { timeout: 15000 }, async () => {
  const qaRoot = path.resolve(".npm-cache", "qa"); await mkdir(qaRoot, { recursive: true });
  const directory = await mkdtemp(path.join(qaRoot, "oidc-security-"));
  const source = `
    import assert from 'node:assert/strict';
    import {writeFile,unlink} from 'node:fs/promises';
    import {getVercelOidcToken,verifyVercelOidcToken} from '@vercel/oidc';
    let fetches=0;globalThis.fetch=async()=>{fetches++;throw new Error('Unexpected network access');};
    const token=(id)=>[Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:id,exp:4102444800})).toString('base64url'),'synthetic-signature'].join('.');
    const target=process.argv[1],fallback=token('synthetic-environment'),first=token('synthetic-first-file'),second=token('synthetic-rotated-file'),context=token('synthetic-request-context');
    process.env.VERCEL_OIDC_TOKEN=fallback;process.env.VERCEL_OIDC_TOKEN_FILE=target;
    await writeFile(target,first);assert.equal(await getVercelOidcToken(),first);
    await writeFile(target,second);assert.equal(await getVercelOidcToken(),second);
    globalThis[Symbol.for('@vercel/request-context')]={get:()=>({headers:{'x-vercel-oidc-token':context}})};
    assert.equal(await getVercelOidcToken(),context);delete globalThis[Symbol.for('@vercel/request-context')];
    await writeFile(target,'');await assert.rejects(getVercelOidcToken());
    await unlink(target);await assert.rejects(getVercelOidcToken());
    delete process.env.VERCEL_OIDC_TOKEN_FILE;assert.equal(await getVercelOidcToken(),fallback);
    assert.equal(typeof verifyVercelOidcToken,'function');assert.equal(fetches,0);
  `;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, path.join(directory, "synthetic-rotated-token")], { cwd: process.cwd(), windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, NODE_ENV: "production", VERCEL: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject); child.once("exit", code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
  } finally {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(qaRoot + path.sep) || !path.basename(resolved).startsWith("oidc-security-")) throw new Error("Unsafe synthetic directory cleanup");
    await rm(resolved, { recursive: true, force: true });
  }
});
