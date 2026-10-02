<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Novalure cross-repository control plane

Before every task:

1. Read `docs/masterplan/novalure-ai-workforce-masterplan-v1.md`, then the applicable CRM architecture, security, QA and operations documents. The local file is a byte-identical mirror; the authoritative source is `novalure/evelyn:docs/masterplan/novalure-ai-workforce-masterplan-v1.md`. Do not maintain an independent CRM policy variant.
2. Run `npm run check:masterplan` and stop on a version or digest mismatch.
3. Determine which authorized apps, APIs, CLIs, plugins, browser sessions and shell access are actually available. Never claim unavailable access.
4. Continue independently within the durable authorization. Escalate only an actual exception, a required personal login/MFA/account release, or a missing decision that changes scope.

Apply Autonomy and Access Framework `2.0.0` from the masterplan and the repository procedures in `docs/go-live/cloud-development-guide.md`, `docs/security/secrets-policy.md` and `docs/go-live/technical-production-runbook.md`:

- Independently complete necessary technical work for Evelyn and Novalure CRM, including implementation, dependencies, tests, fixes, branches/worktrees, commits, pushes, PRs, reviews, merges, Development/Preview resources, synthetic test resources, integrations, least-privilege project access, monitoring, backups, recovery verification and runbooks.
- Routine technical decisions in that scope need no repeated confirmation. Use existing authorized access, keep privileged development or migration identities separate from Runtime identities, and remove temporary access after use.
- Regular technical Production writes are pre-authorized only when every machine-checkable precondition in the Production runbook is proven for the exact target. This task does not itself execute a Production migration, application connection, deployment, promotion or Canary.
- Irreversible deletion of real business data, destructive migration without a proven recovery path, removal of a security boundary, new paid subscription/purchase/contract, card entry, and technically unavoidable personal login/MFA/account release remain exceptions for Franz.
- Technical authority does not authorize real payments, contracts, customer communication, personnel decisions or other business effects. Those application-level approval gates remain in force.
- Never expose secrets or complete connection strings to model context, chat, screenshots, logs, repositories or reports. Use only authorized host-side systems; stop if model disclosure would be required. Do not reuse disclosed credentials; arrange rotation/revocation and cleanup.
- Documentation or broader authorization alone does not close G08, G27, QA-isolation, Production-readiness or security gates. Never claim unexecuted bootstrap, secret storage, password establishment, Runtime TLS/login, privilege tests or cleanup evidence. Do not overwrite the existing `prod-neon-runtime-db` secret without first verifying its state and the reviewed rotation path.
- On a blocker, report the exact cause, completed work and smallest required next step.
