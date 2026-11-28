import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Coverage selection only. This never supplies the separately required trusted
// App attestation, release acceptance, or authority to perform external effects.
const protectedDocs = /^(?:docs\/(?:governance|security|testing|qa|audit|go-live|runbooks|masterplan|architecture|legal)\/|(?:AGENTS|CLAUDE)\.md$)/i;
const sensitiveName = /(?:^|[/._-])(?:policy|governance|security|auth|authorization|tenant|rls|migration|credential|secret|permission|approval|production|release|rollback|recovery|backup|runbook|masterplan|acceptance|evidence|test|qa|audit|handoff|contract|activation)(?:[/._-]|$)/i;
const visualFixtureCss = "src/app/visual-qa/crm/visual-qa.module.css";

export function classifyCiChange(changes, readBlob) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { profile: "HIGH", reason: "NO_PROVEN_CHANGE_SCOPE" };
  }
  for (const change of changes) {
    const path = change?.path;
    if (typeof path !== "string" || !path || /[\\\r\n\0]/u.test(path)
      || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("CI_CHANGE_PATH_INVALID");
    }
    // --no-renames exposes both the removal and addition. Removal, type changes
    // and executable/symlink modes cannot enter the documentation-only path.
    if (!["A", "M"].includes(change.status) || change.mode !== "100644") {
      return { profile: "HIGH", reason: "REMOVAL_RENAME_OR_NONREGULAR_FILE" };
    }
    if (path === visualFixtureCss) {
      const css = readBlob(path);
      if (typeof css !== "string" || css.length > 100_000
        || /[\\\0<>]|url\s*\(|expression\s*\(|(?:^|[;{\s])(?:behavior|-moz-binding)\s*:|@(?!media\b|supports\b|layer\b|keyframes\b|starting-style\b)/iu.test(css)) {
        return { profile: "HIGH", reason: "CSS_SCOPE_NOT_PLAIN_PRESENTATION" };
      }
      continue;
    }
    if (protectedDocs.test(path) || sensitiveName.test(path)) {
      return { profile: "HIGH", reason: "PROTECTED_OR_OPERATIONAL_CHANGE" };
    }
    if (/^(?:README|CHANGELOG|CONTRIBUTING)\.md$/iu.test(path)
      || /^docs\/[A-Za-z0-9_./-]+\.md$/u.test(path)) continue;
    // No ordinary functional module currently has a proven bounded acceptance
    // mapping here. Unknown/shared source, dependencies, CI and SQL remain HIGH.
    return { profile: "HIGH", reason: "NO_BOUNDED_FUNCTIONAL_ACCEPTANCE_MAPPING" };
  }
  return { profile: "LOW", reason: "DOCUMENTATION_OR_ISOLATED_VISUAL_FIXTURE_ONLY" };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

export function classifyGitChange(base, head, cwd = process.cwd()) {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/u.test(sha ?? "") && !/^0+$/u.test(sha))) {
    throw new Error("CI_CHANGE_EXACT_REVISIONS_REQUIRED");
  }
  const entries = git(["diff", "--name-status", "--no-renames", "-z", base, head, "--"], cwd).split("\0");
  entries.pop();
  if (entries.length % 2 !== 0) throw new Error("CI_CHANGE_STATUS_INVALID");
  const changes = [];
  for (let index = 0; index < entries.length; index += 2) {
    const [status, path] = entries.slice(index, index + 2);
    const mode = status === "D" ? null : git(["ls-tree", "--format=%(objectmode)", head, "--", path], cwd).trim();
    changes.push({ status, path, mode });
  }
  return { ...classifyCiChange(changes, (path) => git(["show", `${head}:${path}`], cwd)), changedFileCount: changes.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = classifyGitChange(process.env.CI_SCOPE_BASE, process.env.CI_SCOPE_HEAD);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `profile=${result.profile}\n`);
  console.log(JSON.stringify({ ...result, trustedAppAttestation: "SEPARATE_AND_STILL_REQUIRED" }));
}
