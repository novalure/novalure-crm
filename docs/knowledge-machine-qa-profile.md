# Separate Knowledge QA workload profile

The opt-in QA profile exercises a real Evelyn Preview workload and stored native
CRM assistant bindings against an isolated CRM Preview. It does not prove a
positive call through the existing Production-only authenticator. That verifier,
its identity, canonical migration SQL and existing Production authentication
functions remain unchanged.

The server enables this path only with `CRM_KNOWLEDGE_QA_MACHINE_ENABLED=1` and a
valid `CRM_KNOWLEDGE_QA_WORKSPACE_ID` from the trusted QA target. Before JWT or SQL,
it requires provider `VERCEL=1`, `VERCEL_ENV=preview`, Preview target, CRM project
`prj_R32Okl6AHijTohvuKmryuTLjWMsk`, branch
`codex/evelyn-crm-package4-integration`, and an HTTPS request to the exact unique
hostname from provider `VERCEL_URL`. A selected QA profile never falls back to
Production authentication. Missing enablement retains the existing path.

Only the existing POST Knowledge `webchat` and `voice` routes are supported. Body,
cookie, Origin and URL-parameter restrictions remain. Claims come from Vercel
JWKS verification with RS256, JWT type, mandatory time/JTI fields, bounded TTL,
and exact issuer, owner, sender project, Preview subject, environment and audience:

- Issuer: `https://oidc.vercel.com/novalure`
- Owner: `team_sjD78IkSicXJK6TAOR1JC7Wv`
- Evelyn project: `prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I`
- Subject: `owner:novalure:project:evelyn:environment:preview`
- Audience: `urn:novalure:crm:knowledge-qa:prj_R32Okl6AHijTohvuKmryuTLjWMsk:<QA-workspace-UUID>`

This verifies the Evelyn Preview project identity. Standard Vercel claims do not
prove an individual caller branch or deployment. The separately audited minimal
caller artifact must therefore have its exact deployment/source receipt; no such
claim is fabricated from the JWT. Deployment Protection is a separate gate and
does not replace Bearer authentication.

QA-native provisioning belongs to a guarded owner-side augmentation, never a
customer route. Its new principal is `EVELYN_CRM_KNOWLEDGE_QA_IDENTITY`, auth type
`VERCEL_OIDC_QA`, environment `preview`, role `Evelyn.QA`, with a native customer
workspace agent and `project_sales_member` role. It has only the existing minimum
project-read scope. No Production row is repurposed, static credential substituted,
or actor elevated to Owner/operator. The native principal expires after one hour.
After the hosted proof, disable only these new QA bindings/principal and the
branch's QA enablement; preserve the proof and its exact source/expiry receipt.

The QA-only SQL preserves the prior principal constraint alternatives and adds
the exact QA alternative plus one narrow QA reader. No canonical migration 107
is added. The unchanged Production reader cannot authenticate the new auth type.
The receipt must preserve the canonical 60-row ledger, 13 migration hashes, 94
FORCE-RLS relations and existing Production function definitions/effective ACLs.
The extra public SQL objects and native rows are captured by the full QA restore
process. Temporary exact-owner insertion policies must disappear before commit.

The handler loads the native principal, locks its saved same-tenant bot/channel
binding, revalidates the principal, then uses the existing published retrieval
port. Module, feature, contract, quota, project, area, channel, revocation, expiry,
kill-switch and current actor checks remain. Its audit identity truthfully carries
`Evelyn.QA` / `preview`; retrieval's normal usage/audit accounting remains active.

Local verifier/SQL tests are separate from the later genuine hosted proof. The
hosted proof requires a separately built Preview caller in the existing Evelyn
project with inherited application credentials neutralized, actual custom-audience
workload OIDC, fixed receiver origin/channel/query and published source/version
pins. Missing/default/wrong-audience cases must reach the application and return
`ASSISTANT_ACCESS_DENIED`; a platform protection denial is not that evidence.
