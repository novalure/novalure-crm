<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Novalure cross-repository control plane

Before every task, read `docs/masterplan/novalure-ai-workforce-masterplan-v1.md`, then the applicable CRM architecture, security, QA and operations documents. The local file is a byte-identical mirror; the authoritative source is `novalure/evelyn:docs/masterplan/novalure-ai-workforce-masterplan-v1.md`. Run `npm run check:masterplan` before preparing a commit or Draft PR. Do not maintain an independent CRM policy variant.

Apply Autonomy and Access Framework `1.0.0` from that masterplan:

- Development and Preview code, documentation, configuration, testing, fixes, branches and Draft PRs are independently allowed within the expressly authorized project scope.
- Production is read-only by default. Any write requires a separate documented approval naming project, resource, action, limits and any validity period. Credential bootstrap never authorizes migration, application connection, deployment promotion or Canary activation.
- Reuse a concrete approval without asking again only while its recorded scope, target and conditions are unchanged. Technical access and authenticated sessions do not expand authority.
- Never expose secrets or complete connection strings to model context, chat, screenshots, logs, repositories or reports. Use only authorized host-side systems; stop if model disclosure would be required. Do not reuse disclosed credentials, and arrange authorized rotation and cleanup.
- Do not expand permissions, identities or network exceptions, or bypass browser/security controls. Temporary rights must be resource- and time-bounded and removed afterward.
- Documentation changes do not close G08, G27, QA-isolation, Production-readiness or security gates. Never claim unexecuted bootstrap, secret-storage, password, Runtime TLS, privilege-test or cleanup evidence.
- On a blocker, report the exact cause, completed work and smallest required next step.
