import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { assertPinnedContract } from "./caller.mjs";
import contract from "./contract.json" with { type: "json" };

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(fixtureRoot, "../../..");
const require = createRequire(import.meta.url);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

export async function bundleCaller() {
  const lockBytes = await readFile(path.join(repoRoot, "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  const oidc = JSON.parse(await readFile(
    path.resolve(path.dirname(require.resolve("@vercel/oidc")), "../package.json"), "utf8"));
  if (lock.packages["node_modules/@vercel/oidc"].version !== "3.8.8" || oidc.version !== "3.8.8" ||
      !lock.packages["node_modules/@vercel/oidc"].integrity) throw new Error("Pinned OIDC installation required");
  const compiled = await build({ entryPoints: [path.join(fixtureRoot, "handler.mjs")],
    bundle: true, platform: "node", target: "node24", format: "cjs", write: false,
    metafile: true, logLevel: "silent", legalComments: "inline", treeShaking: true,
    outfile: path.join(fixtureRoot, "index.cjs") });
  for (const output of Object.values(compiled.metafile.outputs)) {
    if (output.imports.some((item) => item.external && !builtins.has(item.path))) {
      throw new Error("Unexpected unbundled runtime dependency");
    }
  }
  const code = Buffer.from(`${compiled.outputFiles[0].text}\nmodule.exports = module.exports.default;\n`);
  const moduleRoot = await realpath(path.join(repoRoot, "node_modules"));
  const inputs = [];
  for (const name of Object.keys(compiled.metafile.inputs).sort()) {
    const absolute = await realpath(path.resolve(name));
    const label = absolute.startsWith(`${moduleRoot}${path.sep}`)
      ? `node_modules/${path.relative(moduleRoot, absolute).split(path.sep).join("/")}`
      : path.relative(repoRoot, absolute).split(path.sep).join("/");
    if (label.startsWith("../") || path.isAbsolute(label)) throw new Error("Unexpected build input outside repository/dependencies");
    inputs.push({ path: label, sha256: sha256(await readFile(absolute)) });
  }
  return { code, inputs, lockfile: { path: "package-lock.json", sha256: sha256(lockBytes) },
    sdk: { package: "@vercel/oidc", version: oidc.version,
      lockIntegrity: lock.packages["node_modules/@vercel/oidc"].integrity } };
}

/** Local-only build. The stage must be new, so inherited files cannot enter the upload. */
export async function buildCaller(stage) {
  assertPinnedContract(contract);
  const bundled = await bundleCaller();
  const stageRoot = path.resolve(stage);
  await mkdir(stageRoot, { mode: 0o700 });
  const output = path.join(stageRoot, ".vercel/output");
  const functionRoot = path.join(output, "functions/api/package4-machine-proof.func");
  await mkdir(functionRoot, { recursive: true, mode: 0o700 });
  const files = [
    { path: ".vercel/project.json", bytes: Buffer.from(JSON.stringify({
      projectId: contract.callerProjectId, orgId: contract.ownerId, projectName: "evelyn",
    }, null, 2)) },
    { path: ".vercel/output/config.json", bytes: Buffer.from(JSON.stringify({ version: 3, routes: [
      { src: "^/api/package4-machine-proof$", dest: "/api/package4-machine-proof" },
      { src: "^/.*$", status: 404 },
    ] }, null, 2)) },
    { path: ".vercel/output/functions/api/package4-machine-proof.func/.vc-config.json", bytes: Buffer.from(JSON.stringify({
      runtime: "nodejs24.x", handler: "index.cjs", launcherType: "Nodejs", maxDuration: 45,
    }, null, 2)) },
    { path: ".vercel/output/functions/api/package4-machine-proof.func/index.cjs", bytes: bundled.code },
  ];
  for (const file of files) await writeFile(path.join(stageRoot, file.path), file.bytes, { mode: 0o600, flag: "wx" });
  const sources = [];
  for (const name of ["caller.mjs", "handler.mjs", "contract.json", "build.mjs", "caller.test.mjs", "README.md"]) {
    sources.push({ path: `scripts/qa-fixtures/evelyn-preview-knowledge-caller/${name}`,
      sha256: sha256(await readFile(path.join(fixtureRoot, name))) });
  }
  const manifest = {
    format: "package4-evelyn-preview-caller-artifact-v1", target: "preview", deployable: true,
    callerProjectId: contract.callerProjectId, ownerId: contract.ownerId,
    receiverOrigin: contract.receiverOrigin, receiverProjectId: contract.receiverProjectId,
    logicalContentAccess: "read-only", runtime: "nodejs24.x", deadlineMs: 30_000, fixedMaximumRequests: 8,
    environmentIsolation: { expectedBlankKeyCount: 15, explicitEmptyRequiredBeforeOidc: true },
    oidcEvidence: "Signed workload claims identify project, owner, subject, environment and audience. No branch or deployment claim is assumed.",
    originalPdfProvenance: contract.originalPdfProvenance,
    expectedSourceId: contract.expectedSourceId, expectedVersionId: contract.expectedVersionId,
    sources, lockfile: bundled.lockfile, sdk: bundled.sdk, dependencyInputs: bundled.inputs.filter((item) => item.path.startsWith("node_modules/")),
    artifacts: files.map((file) => ({ path: file.path, bytes: file.bytes.byteLength, sha256: sha256(file.bytes) })),
    excluded: ["Environment values", "Authentication state", "Tokens", "Evelyn repository/application", "Unrelated CRM files"],
    requiredBeforeDeployment: ["Native inventory and blank per-deployment shadow of every inherited Evelyn Preview environment key, except reviewed fresh caller configuration and platform-managed OIDC/system context.",
      "Independent frozen-source and artifact review.", "Parent-authorized prebuilt Preview deployment to the exact existing Evelyn project; retain Deployment Protection.",
      "Native receipt binding the unique caller deployment to this artifact manifest; this metadata is separate from OIDC claims."],
  };
  await writeFile(path.join(stageRoot, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { stage: stageRoot, manifest: path.join(stageRoot, "artifact-manifest.json"), files: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { stage: { type: "string" } }, allowPositionals: false });
    if (!values.stage) throw new Error("A fresh --stage directory is required");
    process.stdout.write(`${JSON.stringify(await buildCaller(values.stage))}\n`);
  } catch {
    process.stderr.write("QA caller build refused; verify the pinned contract, dependencies and fresh stage path.\n");
    process.exitCode = 1;
  }
}
