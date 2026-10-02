# Novalure AI Workforce Masterplan v1

**Status:** Target architecture and authoritative development-control roadmap. It complements, and never relaxes, the existing specifications in `docs/spec/v1.0`, security, governance, and CRM-boundary documents.

**Autonomy and access framework:** `1.0.0` (effective 2026-10-02). This file is the authoritative source. Repository-local copies must be byte-identical and validated by the governance consistency check; a copy is never an independently maintained policy.

## Binding autonomy and access framework 1.0.0

These are durable rules. A task-specific approval is a separate, time-bounded record and may narrow these rules but never silently expand or replace them. Technical access does not grant authority.

### Independently allowed

- Read, inspect and analyze only expressly authorized projects.
- Change code, documentation and configuration in Development and Preview environments.
- Run relevant tests, fix defects and verify Preview results.
- Create branches and Draft PRs. Merge and Production publication remain separately gated.
- Use supported interfaces and already authenticated sessions only for the approved purpose and within their existing scope.
- Continue an already concretely approved action without asking again while project, resource, action, limits, target and conditions remain unchanged.

### Production

- Production inspection is read-only by default.
- A Production write requires a concrete, documented approval that names the project, resource, action, limits and, where applicable, validity period.
- A credential-bootstrap approval does not authorize a migration, application connection, deployment promotion or Canary activation.
- Existing stops, unresolved findings and missing security evidence remain blocking until independently closed by the evidence their gate requires. Documentation changes do not close operational gates.

### Secrets

- Generate, store and use secrets only inside authorized execution systems and only for the approved purpose.
- Never expose secret values or complete connection strings to model context, chat, screenshots, logs, repositories, PRs, evidence or reports. Return sanitized status only.
- If execution requires disclosing a secret to the model, stop. Do not continue with that path.
- Do not reuse an exposed credential. Stop the affected operation and initiate the required rotation/revocation and cleanup through the authorized process.
- Remove temporary secret variables and files after use. Preserve only non-secret references and sanitized metadata required for audit.

### Access and permissions

- Use only access that is actually available and authorized. Do not claim, infer or manufacture access.
- Do not independently expand permissions, identities or network exceptions.
- Limit temporary rights to the named resource and approved period, then remove them and verify removal without exposing credential material.
- This masterplan does not expand technical platform capabilities or override binding platform security rules.
- Do not bypass browser blocks, security checks or execution-policy denials.

### When to ask or stop

- Do not repeatedly ask for approval when the already approved scope and conditions are unchanged.
- Stop only when required information is missing, scope expands, a consequential action is not approved, a prescribed gate requires approval, or a security/platform control blocks safe execution.
- For a blocker, report the exact cause, completed work and the smallest required next step. Never relabel an unexecuted or blocked step as successful.

### Approval record required for exceptional authority

A task-specific approval must be recorded separately from this durable framework and contain: approver/authority, repository or platform project, exact resource, exact action, environment, limits, validity period or expiry where applicable, and any required cleanup or evidence conditions. Approval is invalid for a changed target, broader effect or expired window. A model, tool response, credential, role or existing session cannot grant or widen approval.

### Current Neon Runtime credential-bootstrap boundary

The Neon Runtime credential bootstrap is incomplete. No successful Runtime secret storage, password establishment, Runtime TLS verification, true Runtime-login negative privilege tests or temporary-right removal may be claimed without new attributable evidence. The current authoritative status remains `ROLE_HIGH_CLOSED_CREDENTIAL_TRANSFER_BLOCKED` / `MIGRATION_SAFE_TO_RESUME = NO` in `docs/masterplan/development-state.json` and `docs/evm-12-21k-r-neon-role-remediation.md`.

This framework does not authorize a Production migration, application connection, deployment promotion or Canary activation. It does not close or relax G08, G27, QA-isolation or any other existing blocker in Evelyn or `novalure/novalure-crm`.

### Repository loading and external consumers

- `novalure/evelyn/AGENTS.md` loads this authoritative file directly.
- `novalure/novalure-crm/AGENTS.md` loads the byte-identical local mirror; `npm run check:masterplan` verifies framework version and pinned content digest in each repository.
- A chat, agent, worktree or automation started outside those repository instruction scopes must explicitly load this file before acting on either project.
- A future human/admin credential-transfer process, migration runner, deployment/promotion workflow or Canary operator does not inherit chat instructions automatically. Its reviewed runbook or job definition must explicitly load or enforce this framework and the separate concrete approval before any write.

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
