import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { classifyCiChange, classifyGitChange } from "./classify-ci-change.mjs";

const regular = (path, status = "M") => ({ path, status, mode: "100644" });
const profile = (paths, css = ".fixture { color: red; }") => classifyCiChange(paths.map((path) => regular(path)), () => css).profile;

test("only non-operational Markdown and isolated plain visual-fixture CSS receive LOW", () => {
  assert.equal(profile(["README.md", "docs/user-guide.md"]), "LOW");
  assert.equal(profile(["src/app/visual-qa/crm/visual-qa.module.css"]), "LOW");
  assert.equal(profile(["src/styles/crm-theme.css"]), "HIGH");
  for (const css of ["@import 'https://example.invalid/a.css';", ".a { background: url(/private); }", ".a { color: \\72 ed; }", "@tailwind utilities;"]) {
    assert.equal(profile(["src/app/visual-qa/crm/visual-qa.module.css"], css), "HIGH");
  }
});

test("protected, unknown and mixed functional changes retain the complete matrix", () => {
  for (const path of [
    "AGENTS.md", "CLAUDE.md", ".github/workflows/livegang-e2e.yml", "scripts/classify-ci-change.mjs",
    "scripts/classify-ci-change-tests.mjs", "package.json", "package-lock.json", "next.config.ts",
    "config/crm-department-access-policy.json", "migrations/200_test.sql", "src/app/api/auth/login/route.ts",
    "src/lib/db/crm.ts", "src/components/calendar-command-center.tsx", "unknown.txt", "docs/governance/review.md",
    "docs/testing/risk-based-test-policy.md", "docs/qa/check.md", "docs/production-readiness.md", "docs/release-notes.md",
  ]) assert.equal(profile(["docs/user-guide.md", path]), "HIGH", path);
  assert.equal(classifyCiChange([], () => "").profile, "HIGH");
});

test("removals, renames and nonregular Git modes cannot be classified as documentation-only", () => {
  for (const status of ["D", "R100", "C100", "T", "U"]) {
    assert.equal(classifyCiChange([regular("docs/user-guide.md", status)]).profile, "HIGH");
  }
  for (const mode of ["120000", "100755", "160000", null]) {
    assert.equal(classifyCiChange([{ ...regular("docs/user-guide.md"), mode }]).profile, "HIGH");
  }
  for (const path of ["../README.md", "/README.md", "docs//a.md", "docs/./a.md", "docs\\a.md", "docs/a\nb.md"]) {
    assert.throws(() => profile([path]), /CI_CHANGE_PATH_INVALID/u);
  }
});

test("Git scope reads immutable blobs and a renamed Markdown file remains HIGH", () => {
  const root = mkdtempSync(join(tmpdir(), "crm-ci-scope-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = () => { git("add", "--all"); git("-c", "user.name=CI scope tests", "-c", "user.email=ci@example.invalid", "commit", "-m", "synthetic scope fixture"); return git("rev-parse", "HEAD"); };
  try {
    git("init");
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "docs/user-guide.md"), "# Initial guide\n");
    const source = readFileSync(new URL("./classify-ci-change.mjs", import.meta.url), "utf8");
    writeFileSync(join(root, "scripts/classify-ci-change.mjs"), source);
    const base = commit();
    writeFileSync(join(root, "docs/user-guide.md"), "# Updated guide\n");
    const docsHead = commit();
    assert.equal(classifyGitChange(base, docsHead, root).profile, "LOW");
    renameSync(join(root, "docs/user-guide.md"), join(root, "docs/new-guide.md"));
    const renameHead = commit();
    assert.equal(classifyGitChange(docsHead, renameHead, root).profile, "HIGH");
    writeFileSync(join(root, "scripts/classify-ci-change.mjs"), "// A candidate cannot classify itself LOW.\n");
    const changedClassifier = commit();
    // Materialize the immutable base exactly as the workflow does. Candidate
    // classifier contents are never executed to decide its own coverage.
    const trustedPath = join(root, "trusted-base-classifier.mjs");
    writeFileSync(trustedPath, git("show", `${renameHead}:scripts/classify-ci-change.mjs`));
    const output = JSON.parse(execFileSync(process.execPath, [trustedPath], {
      cwd: root, encoding: "utf8", stdio: "pipe",
      env: { ...process.env, CI_SCOPE_BASE: renameHead, CI_SCOPE_HEAD: changedClassifier, GITHUB_OUTPUT: "" },
    }));
    assert.equal(output.profile, "HIGH");
    assert.equal(output.trustedAppAttestation, "SEPARATE_AND_STILL_REQUIRED");
    assert.throws(() => classifyGitChange("0".repeat(40), changedClassifier, root), /EXACT_REVISIONS_REQUIRED/u);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow retains required job names, trusted-base adoption and manual QA coverage", () => {
  const workflow = readFileSync(new URL("../.github/workflows/livegang-e2e.yml", import.meta.url), "utf8");
  assert.match(workflow, /name: Lockfile, lint, typecheck, tests and build/u);
  assert.match(workflow, /name: Production dependency audit and SBOM/u);
  assert.match(workflow, /name: Manual trusted-candidate QA regression and tenant diagnostics/u);
  assert.match(workflow, /CI_SCOPE_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/u);
  assert.match(workflow, /git show "\$CI_SCOPE_BASE:scripts\/classify-ci-change\.mjs" > "\$RUNNER_TEMP\/trusted-crm-ci-classifier\.mjs"/u);
  assert.doesNotMatch(workflow, /run: node scripts\/classify-ci-change\.mjs/u);
  assert.match(workflow, /if \[\[ "\$CI_SCOPE_EVENT" == workflow_dispatch \]\]; then\n\s+echo "profile=HIGH"/u);
  assert.match(workflow, /Classifier absent from trusted base: retain complete coverage/u);
  const quality = workflow.split("  production-sca:")[0];
  for (const name of ["Unit and component smoke tests", "Sales schema upgrade, rollback and native restore", "Production build", "Integrated Design C and Knowledge customer acceptance on isolated PostgreSQL"]) {
    assert.ok(quality.includes(`      - name: ${name}\n        if: steps.scope.outputs.profile != 'LOW'\n`), name);
  }
  const production = workflow.split("  production-sca:")[1].split("  qa-e2e:")[0];
  assert.match(production, /run: npm run security:production/u);
  assert.doesNotMatch(production, /steps\.scope|needs\.quality/u);
  const manual = workflow.split("  qa-e2e:")[1];
  assert.match(manual, /if: github\.event_name == 'workflow_dispatch'/u);
  assert.match(manual, /environment: \$\{\{ inputs\.qa_profile == 'isolated-candidate'/u);
  assert.match(manual, /needs:\n\s+- quality\n\s+- production-sca/u);
  assert.doesNotMatch(manual, /steps\.scope/u);
});
