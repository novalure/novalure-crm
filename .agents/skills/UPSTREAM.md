# mattpocock/skills source record

Read via the connected GitHub service on 2026-10-24.

- Repository: https://github.com/mattpocock/skills
- Pinned source commit: `5beb35b040e3de97e54fa9e386d7e42d15c295c2`
- Commit date: 2026-10-19; resolved from `main` before reading files.
- License: MIT; preserve the complete adjacent `LICENSE`, including `Copyright (c) 2026 Matt Pocock`.
- These local snapshots are research evidence only, outside project skill discovery. They are not an instruction to install original skills or their dependencies.

| Adaptation | Original path at pinned commit | SHA-256 of original bytes |
| --- | --- | --- |
| novalure-spec | [skills/engineering/to-spec/SKILL.md](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/to-spec/SKILL.md) | 43ad9cf318e5e7d3d1fa360253a37021796dc87a0c2e595ad262661a10f85088 |
| novalure-diagnose | [skills/engineering/diagnosing-bugs/SKILL.md](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/diagnosing-bugs/SKILL.md) | 849198df88cdb65fd0d97236604c1fca7ff2f22d2f705f9724a800d0266b118d |
| novalure-review | [skills/engineering/code-review/SKILL.md](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/code-review/SKILL.md) | 09eb147f793e4647949edd32dbad278f0554dfb56e0d46b699cd4c2c55bf0357 |
| novalure-handoff | [skills/productivity/handoff/SKILL.md](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/productivity/handoff/SKILL.md) | 4cbb043950dad2ffd3662ff1a5a0b51ae676004b5cae10e3787e8ee7a4ee69d3 |
| LICENSE | [LICENSE](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/LICENSE) | 0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5 |

Exact local snapshot byte counts and Git blob identities were checked against the pinned repository tree. They match: 3043, 8664, 6670, 940, and 1068 bytes respectively.

## Adaptation decisions required by this task

- Spec: keep synthesis of existing requirements, repository vocabulary, decisions and externally observable tests. Replace automatic issue publication and `ready-for-agent` label with project-local per-task documents. Remove setup-skill dependency, mandatory long user-story list and mandatory additional seam-approval checkpoint. Scale detail and ask only for genuinely missing decisions within existing authority.
- Diagnose: preserve exact user symptom, a relevant failing/working feedback signal, competing falsifiable hypotheses when useful, one-variable probes, relevant regression and cleanup. Scale investigation to the bug; do not make all phases, 3–5 hypotheses, hundreds of reruns, new tests, mutation checks or production instrumentation blanket requirements. Clearly label missing reproduction or integration evidence. Never infer success from an unrelated green command.
- Review: keep separate standards and requirements assessments. Pin actual comparison base and reviewed commit, plus staged/unstaged/untracked contents when requested; the original three-dot `HEAD` diff alone omits work changes. Existing exact-SHA independent review governance remains authoritative; two-axis analysis does not replace it. State checks actually run, gaps and evidence, and only actionable findings. Do not introduce the original full smell catalog as new mandatory policy.
- Handoff: retain compact artifact links and sensitive-data redaction. Replace OS temporary storage with durable project-local files separated by task; include repository, branch, commit/worktree state, completed work, checks and evidence, publication/deployment state, open points and concrete next step. A handoff captures the commit observed at recording; do not imply a document can embed its own future commit hash.
- Install no original setup or other bundled skills, scripts, dependencies or global skills. Preserve current repository instructions, approvals, scope limits and independent review process. Do not include customer personal data or credentials.

## Installed project adaptations

Only the four mapped adaptations are installed in `.agents/skills/novalure-*/SKILL.md`.
The original setup skill, scripts, optional dependencies and other templates are not installed.
The source-specific `disable-model-invocation` and `argument-hint` keys are not copied;
the local frontmatter uses the required Codex fields `name` and `description` only.
Current structure reference: https://developers.openai.com/codex/skills/ (read 2026-10-24).
The adjacent LICENSE is the complete original MIT text, without modification.
