# CRM protected-main integration, 27 November 2026

This Draft route retains both the protected-main history and the actual deployed
production history. It replaces the unprotected-base release route of Draft
[PR 142](https://github.com/novalure/novalure-crm/pull/142); it does not merge,
promote or approve a production release.

The merge commit `7072d0b941174dd46cf9f80fd7dd6e98cea432e3` has these two parents:

- `1af2f8f9bba9db57c15bfadfee25f6bee5693b9d`: protected main, including its
  23 commits absent from the deployed production lineage.
- `59ab1216cd487143f53942c4e5177fa38fbd2a1d`: the frozen PR 142 candidate,
  descended from the actual deployed
  `dea8c63c3b299918c423dbb62b754cc5e5e39ced` production revision.

This is a large historical reconciliation, not merely the narrower CRM access
diff previously reviewed against the production branch. Earlier exact-revision
reviews do not establish a complete review of this combined candidate.

## Conflict decisions

Only four paths had merge conflicts. The original three-stage index identities
and resolved-file hashes were saved before committing in the local immutable
conflict receipt, SHA-256
`9006d34f5a20104c5b5280279304d3e596bb7eecdb7c229dd0e230d7e8e22424`.

- `.gitleaksignore` retains the exact reviewed production-successor exceptions;
  every main exception is already present. No new scan exclusion was added.
- `package.json` preserves production dependencies and scripts, plus main's
  `test:crm-full-backup`. In particular, deployed Next.js 16.4.5 and OIDC 4.0.6
  remain selected instead of reverting to older main versions.
- `package-lock.json` is byte-identical to the production-successor lockfile,
  SHA-256 `1a4c01c248a8cc66b9b7973e9ce792b11c4878bd699322b6ad9c05cf7bf4e474`.
  Dependency maps and engines match the resolved package manifest.
- `vercel.json` retains both sets of configured branch rules and cron paths.
  Existing production schedules and main's disabled automatic deployment setting
  remain; automatic deployment is also disabled for this integration branch.
  These source settings are not evidence of a provider deployment.

Immutable third-party notices and historical patch bytes remain intact. The
exact narrow whitespace attributes from the previously reviewed main release
reference are retained. Other whitespace cleanup changes no non-whitespace
component content, including the existing communication workspace.

## Native browser acceptance repair

PR 142 revision `59ab1216` passed the native Sales browser stage and then failed
Quality step 44 in `qa:package4:e2e`: the old
`[data-crm-profile-card] select` selector no longer exists in the actual grouped
navigation. The integration imports only inspected QA changes from
`e10843864a8a287d3d1f6541b7f98b8a54aa7ad8` and its existing fixture predecessors.
They target the actual profile selector, persisted profile preference, grouped
navigation, branded theme, current isolated schema and deterministic cleanup of
an intercepted fallback response. Tenant, MFA, private-data, modal-focus and
fallback assertions remain. No Outlook product implementation is imported.

The current-browser schema option applies existing migration bytes unchanged
and remains off for predecessor-only database tests. It is not a production
migration or a rehearsal of the complete production ledger.

## Evidence boundaries

Locally executed on the isolated integration worktree: pinned Node 24.14.0 /
npm 11.9.0 toolchain, clean lockfile installation, full lint, TypeScript checks,
production build, autonomous access suite (46/46), full-backup boundary suite
(58/58), and full-history secret scan (zero findings). These are local tests,
not target production gates. Browser acceptance, paired-client verification and
new native CI must be bound to the final candidate revision separately.

The new protected-main Draft needs its own exact-revision repository checks,
independent combined-source review, bounded App review binding, actual target
and predecessor checks, protected copy and restore proof, runtime/custody
registration proof and all eight production gates. No database, provider,
secret, real business action, merge or promotion was performed by this route.
