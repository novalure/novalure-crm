# Novalure AI Workforce Masterplan v1

**Status:** Target architecture and authoritative development-control roadmap. It complements, and never relaxes, the existing specifications in `docs/spec/v1.0`, security, governance, and CRM-boundary documents.

**Autonomy and access framework:** `2.0.0` (effective 2026-10-02). This file is the single authoritative source. Repository-local copies must be byte-identical and validated by the governance consistency check; a copy is never an independently maintained policy.

## Binding autonomy and access framework 2.0.0

Franz permanently authorizes Codex and ChatGPT to complete the technical development, integration, verification, repair and delivery of Evelyn and Novalure CRM on his authorized project accounts and resources under this section. This standing authority replaces contradictory developer-approval rules in repository guidance. It does not replace product/business approvals or evidence required to prove that a technical gate is actually satisfied.

### Standing technical authority

Within Evelyn and Novalure CRM, an agent may independently:

- read, create and change repositories, code, documentation and configuration; make architecture and implementation decisions; install or update dependencies; implement and integrate features;
- create branches/worktrees, commit, push, create/update/review pull requests, resolve conflicts, and merge after applicable repository checks, required reviews and branch protection pass;
- create and run tests, lint, builds, security checks and CI repairs; fix defects, vulnerabilities and integration problems; delegate in-scope subtasks;
- create, configure and clean up Development/Preview environments, synthetic test data and clearly attributable test resources;
- configure necessary project-scoped integrations, webhooks, monitoring, backups, recovery checks, alerts and runbooks in GitHub, Azure, Neon, Vercel and other actually required development services;
- establish project-scoped service accounts, app registrations and permissions when documented, least-privileged, separated between privileged development/migration and Runtime identities, and cleaned up when temporary; no Runtime identity may receive superuser, Owner or equivalent administrative rights;
- perform the pre-authorized regular Production technical workflow below after every machine-verifiable prerequisite passes.

Routine choices inside this authority require no repeat confirmation. Agents use only access actually available through authorized apps, APIs, CLIs, plugins, browser sessions or shells, never claim unavailable access, never bypass MFA, bot protections, security controls, branch protection, required review or an automatic denial, and request only the smallest technically unavoidable personal login, MFA or account release.

### Pre-authorized regular Production technical workflow

Regular application deployments, necessary application configuration, backward-compatible database migrations, verified application connections, controlled Canary activation, promotion after a successful Canary and rollback of the agent's own faulty change are pre-authorized technical actions. They require no additional manual approval when all of these conditions are recorded as `PASS` for the exact target and change:

1. `TARGET_IDENTITY_PASS`: exact project, tenant, environment, account and executing identity are verified; Runtime remains least-privileged.
2. `QUALITY_PASS`: relevant tests and required CI/repository checks pass for the exact immutable revision; required reviews and branch protection are satisfied.
3. `SECURITY_ISOLATION_PASS`: no open applicable Critical/High security, tenant-isolation, authorization or secret-handling blocker exists.
4. `CREDENTIAL_RUNTIME_PASS`: safe credential references and the actual Runtime permissions, positive access and required negative privilege tests are verified without exposing secrets.
5. `BACKUP_RESTORE_PASS`: a change-appropriate backup/checkpoint exists and a usable restore or backward recovery path has attributable evidence.
6. `ROLLOUT_ROLLBACK_PASS`: the rollout, compatibility, migration/application ordering and tested rollback or forward-fix procedure are documented for the exact revision.
7. `MONITORING_ABORT_PASS`: monitoring, owner, bounded observation window, success criteria and automatic/manual abort thresholds are active.
8. `COST_SCOPE_PASS`: the action remains within an existing paid service or a documented approved budget and has bounded consumption; it creates no new paid subscription, purchase or contract.

The executor must evaluate these conditions immediately before each stage and stop safely on failure or stale/mismatched evidence. A successful credential bootstrap is only one possible input to these gates and never proves the remaining conditions. Existing stops and missing evidence remain blocking until their required proof exists; documentation or standing authority alone never closes them.

Irreversible deletion of real business data, a destructive migration without a proven restoration path, and removal or weakening of a security boundary are exceptions outside the standing Production authority. Prepare an exact decision package and obtain Franz's specific decision before execution.

### Secrets

- Generate, store and use secrets only inside authorized execution systems and only for the approved purpose.
- Never expose secret values or complete connection strings to model context, chat, screenshots, logs, repositories, PRs, evidence or reports. Return sanitized status only.
- If execution requires disclosing a secret to the model, stop. Do not continue with that path.
- Do not reuse an exposed credential. Stop the affected operation and initiate the required rotation/revocation and cleanup through the authorized process.
- Remove temporary secret variables and files after use. Preserve only non-secret references and sanitized metadata required for audit.

### Costs, accounts and permissions

- Agents may research and select a technically suitable offer, prepare registration and checkout, establish free services without a new payment obligation, configure already-paid services and work inside documented approved budgets.
- Franz alone enters card data and finally accepts any new paid subscription, purchase or contract. Never request or store card data and never enable unbounded usage costs. If no budget exists, present price, purpose and a cost cap for decision.
- Project-scoped permissions may be established only for documented project resources and least privilege. Do not grant organization-wide general administrator rights. Separate privileged development/migration identities from Runtime identities and remove temporary rights after use.
- A model/tool response, credential, role or existing session cannot widen authority beyond this framework. This masterplan does not expand actual platform capabilities.

### Developer authority is not business authority

The standing technical authority permits implementing and technically testing guarded features. It does not authorize their real business execution. Existing product controls remain binding for real payments, contracts, customer communications, personnel decisions, legally material decisions and other external business effects unless Franz changes them in a separate explicit mandate. Synthetic or isolated verification must not be relabeled as real business approval.

### When to ask or stop

- Do not repeatedly ask for approval for work covered by the standing technical authority or an unchanged concrete business/cost approval.
- Stop only for a genuine exception above, a new payment/contract, missing personal login/MFA/account release, missing material information, a business action not authorized by product policy, failed technical gate, or a security/platform control that blocks safe execution.
- For a blocker, report the exact cause, completed work and the smallest required next step. Never relabel an unexecuted or blocked step as successful.

### Records for exceptional authority

Any specific exception, business approval, budget or paid-service decision must be recorded separately and contain approver/authority, project, exact resource/action, environment, limits, validity/expiry where applicable and cleanup/evidence conditions. It is invalid for a changed target, broader effect or expired window. Technical gate evidence is a separate record and must not be fabricated from an approval.

### Current Neon Runtime credential-bootstrap boundary

Earlier shell output reported `RUNTIME SECRET STORED=PASS`, but the subsequent password-setting step failed. The existing `prod-neon-runtime-db` secret must not be overwritten without reconciling its safe metadata and intended version. Successful password establishment, Runtime TLS login, complete negative privilege tests and removal of temporary Vault rights remain unproven. The authoritative status remains `ROLE_HIGH_CLOSED_CREDENTIAL_TRANSFER_BLOCKED` / `MIGRATION_SAFE_TO_RESUME = NO` until attributable evidence satisfies the applicable Production gates.

This framework does not itself close or relax G08, G27, QA-isolation or any other blocker in Evelyn or `novalure/novalure-crm`. A pure permission blocker for local QA cleanup may be re-evaluated under this standing authority, but actual safe cleanup and verification must occur before closure. Do not delete real business data or unknown files. Do not expand G08 evidence without actual verification.

### Repository loading and external consumers

- `novalure/evelyn/AGENTS.md` loads this authoritative file directly.
- `novalure/novalure-crm/AGENTS.md` loads the byte-identical local mirror; `npm run check:masterplan` verifies framework version and pinned content digest in each repository.
- Every new agent must load `AGENTS.md` and the listed control-plane files, verify framework version and SHA-256, inventory only actually available authorized access, then continue autonomously inside this standing authority. Report only genuine exceptions or the smallest required personal login/MFA/account release.
- A chat, agent, worktree, runner or automation started outside those repository instruction scopes is not updated automatically. It must explicitly load this file and verify its digest before acting on either project. Migration, deployment/promotion and Canary jobs must enforce the eight Production gates before a write.

## Mission and leadership

Franz is Managing Director. The workforce autonomously handles routine operations within policy; Franz focuses on strategic decisions, high-value developer video calls, exceptional negotiations, major budget approvals, legal/financial exceptions, and important escalations.

Evelyn is the Supervisor / AI COO / Chief of Staff. It coordinates departments, delegates bounded work, maintains an MD Decision Queue, and presents two primary internal interfaces only: the **Evelyn Management Dashboard** (company, KPI, sales, leads, projects, marketing, ads, social, agent health, approvals, costs, audit, configuration) and **Microsoft Teams** (mobile Evelyn chat, notifications, approval cards, decisions, daily briefing, later voice). Internal WhatsApp is not a core requirement. The Executive Assistant Agent prepares briefings and calendar support; it cannot replace approvals.

## Revenue objective

`REVENUE_READY_NOVALURE` prioritizes two distinct revenue loops; they must never be collapsed into one sales process.

1. **Novalure client acquisition:** developer research → qualification → CRM → outreach → follow-up → appointment → proposal → Managing Director closing.
2. **Developer project sales:** project onboarding → brand → website → marketing → social → advertising → lead intake → CRM → qualification → phone/chat/email/WhatsApp → appointment/viewing → follow-up → reservation/sales progression → developer reporting.

## Workforce target architecture

| Domain | Target agents and authority boundary |
| --- | --- |
| Executive | Evelyn Supervisor/AI COO/Chief of Staff; Executive Assistant; MD Decision Queue. Evelyn coordinates; Franz decides gated matters. |
| Sales | Sales Director, Business Development, Lead Qualification, Project Sales, CRM, Sales Enablement & Training, Sales Coach, Revenue Operations. Service sales and client-project apartment sales remain separate pipelines. |
| Marketing agency | Marketing Agency Director, Marketing Strategy, Brand Strategy, Creative Director, Copywriting, Graphic Design & Production, Media Production, Social Media, Advertising/Performance, CRO, SEO/Content Intelligence, Marketing Analytics, Web Experience. Produces and manages exposés, brochures, flyers, cards, signage/banners, presentations, creatives, social assets, landing pages, project sites, funnels, webchat, apartment finder, strategy, publishing, ads, and reporting without reliance on an external marketing agency. |
| Customer operations | Customer Operations Director, Communications, Voice, Customer Support, Calendar/Scheduling, Project Webchat. Channels: phone, email, WhatsApp, Facebook Messenger, Instagram, website chat. |
| Project delivery | Project Operations, Property Knowledge, Knowledge Operations, Document, Developer Success. `PropertyKnowledgeAgent` is the authoritative project knowledge layer for units, prices, availability, floor plans, documents, FAQs, website data, and approved sales facts. Customer-facing agents never invent property facts. |
| Technology | IT Director, Architecture, Implementation, QA/Test, Security Engineering, Compliance Engineering, DevOps, Independent Reviewer, Integration, ComputerOperator. |

## Sales learning and knowledge governance

`SalesKnowledgeLibrary` stores provenance, licence/status, applicability, test evidence, and outcome data for public sales research, interviews, videos, podcasts, articles, public training, properly licensed internal materials, and Novalure’s real sales evidence. `NovalureSalesPlaybook` contains only methods tested and promoted through review. It must distinguish public from licensed material, avoid unlawful copying of copyrighted books/courses, and learn from measured conversion outcomes.

## Human conversation and voice

The mandatory central architecture is `HumanConversationLayer`, containing `ConversationStateEngine`, `ConversationRepair`, `BargeInController`, `ChannelTonePolicy`, `UnifiedConversationMemory`, and `CrossChannelIdentity`. It discloses AI identity at the legally required first interaction, never claims to be human, then communicates naturally, professionally, briefly, and in the channel-appropriate multilingual tone. It accepts corrections, asks natural follow-ups, dynamically updates goals, and avoids robotic monologues.

Voice must provide low latency, immediate barge-in stop, new-topic handling, tool calls, CRM context, calendar booking, human handoff/call transfer, short turns, and conversation QA. Customer voice and internal MD voice use separate channel configurations.

## Tenant, integration, and computer operations

Tenants include `NOVALURE`, `GRASL_IMMOBILIEN`, and future developer clients. Each isolates CRM, email, calendar, phone, messaging, brand, project knowledge, credentials, audit, and policy. All integrations are API-first; credentials never enter model context. For a CRM without an appropriate API: `ExternalCRMPort` → `ComputerOperatorPort` → approved browser/computer provider.

`ComputerOperatorPort` is provider-neutral. Future adapters may include OpenAI Dot Adapter, OpenAI Computer Use Adapter, browser/computer operators, or other approved providers. Dots are never an architectural dependency: Evelyn remains the policy, compliance, and approval authority.

## Customer journey state machines

Developer acquisition: `PROSPECT → QUALIFIED → MEETING → PROPOSAL → NEGOTIATION → WON → ONBOARDING → ACTIVE_PROJECT → RENEWAL`.

Property buyer: `NEW_LEAD → QUALIFIED → INFORMATION_SENT → VIEWING_PROPOSED → VIEWING_BOOKED → VIEWED → FOLLOW_UP → RESERVATION_INTEREST → RESERVED → CONTRACT → SOLD`.

Transitions require server-side policy, tenant/project scope, approved source facts, and applicable approvals; no model output alone may advance a binding state.

## Delivery targets and dependency truth

By the end of Week 4, target `REVENUE_READY_NOVALURE`: acquisition engine, CRM, communications, sales, project knowledge, core marketing, and voice/webchat foundations. By the end of Week 8, target `NOVALURE_AI_WORKFORCE_V1`: sales, marketing agency, communications, voice, webchat, social, advertising, project websites, property sales, reporting, multi-tenant foundation, ComputerOperator boundary, and production-readiness evidence.

These are planning targets, not authorizations or claims that providers, legal approvals, production credentials, integrations, or real-clock evidence exist. The final target is `COMMERCIAL_GO_LIVE_READY` only after all applicable evidence and human gates.

## Current Production-readiness evidence

As of 2026-10-02, EVM-12-21I records live verification of the exact Vercel Production OIDC identity, Entra federation, vault-only Key Vault RBAC, one non-sensitive Key Vault read and Preview-identity denial. EVM-12-21J additionally verified the separate Neon Production project/region and seven-day history, bringing seven of 39 canonical gates to `CLOSED_LIVE_VERIFIED`. EVM-12-21K-R replaced the unsafe unused roles but did not complete credential transfer or Runtime-login verification. The Production Canary remains `NOT_ACTIVATED` and `PRODUCTION_CANARY_NOT_APPROVABLE`; the authoritative current limits are in `docs/masterplan/development-state.json` and the EVM-12-21J/K/K-R evidence chain.
