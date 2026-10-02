# Cloud development guide

Autonomy and Access Framework `2.0.0` permanently authorizes the technical work needed to develop and finish Evelyn and Novalure CRM on the owner's authorized project resources. Use an API or CLI when it provides a safer, auditable path; an authenticated browser may be used when it is the supported interface. Never bypass MFA, bot protection, execution-policy denials or other security controls.

## Independently authorized

- Create and update repository files, architecture, dependencies, tests, builds, CI, branches, worktrees, commits, pushes, PRs and reviews; merge when required checks, reviews and branch rules are satisfied.
- Create, configure, inspect and remove Development/Preview environments, synthetic data and clearly attributable disposable test resources.
- Configure project-scoped integrations, webhooks, monitoring, alerts, backups and recovery checks using least privilege.
- Create technical service identities and app registrations limited to these projects. Separate migration/development privileges from Runtime privileges, document purpose and scope, and remove temporary rights after use.
- Use free services and configure already-paid services. Within a documented approved budget, apply its stated caps. Do not enable unbounded usage.

## Human and exceptional boundaries

Franz enters card data and gives the final confirmation for a new paid subscription, purchase or contract. If no approved budget exists, prepare the purpose, price and cost cap without completing the purchase. Franz also completes a technically unavoidable personal login, MFA or account release after the agent prepares the exact target and smallest required action.

Do not infer authorization for irreversible deletion of real business data, a destructive migration without a proven restore path, or weakening/removal of a security boundary. Prepare the exact exception and required decision. Real payments, contracts, customer communications, personnel decisions and other business effects retain their application-level approvals even when the underlying feature may be developed and tested autonomously.

Production operations follow `technical-production-runbook.md`. A successful login, available credential or broad framework authorization is not evidence that its preconditions passed.
