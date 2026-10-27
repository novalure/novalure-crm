# Studio shared methods and private signal adapter — local candidate

Status: prepared locally, default OFF; no deployment, provider changes, source publication, runtime binding or customer/model call is evidenced here. Base is `61d1671949297dae0d6e05583bcc0e86f2e1291e`, including the independently reviewed late-authority correction. This does not complete Package 3 live acceptance.

## Existing knowledge route

Studio uses `/api/public/integrations/chat/knowledge`, not `/chat/answers`. The normal body and all existing Origin/site-key, visitor-session, current integration, public actor, project, bot, RLS, source and channel-grant checks remain in place. `X-Novalure-Shared-Behavior: v1` opts into additive `behavior: { version, instruction, fingerprint } | null`. The target is the server constant `webchat`; no visitor field chooses a role, tenant, project, target, actor or method.

The fingerprint is SHA-256 of the JSON tuple `["shared-behavior-webchat-v1", version, instruction]`, containing only the fixed code catalog. A release that targets CEO only produces the existing version-zero base fallback for webchat; this is not a six-method webchat publication. Extending release targets requires the existing evaluated publisher lifecycle, separately reviewed and activated later.

The same route accepts `X-Novalure-Knowledge-Check: v1` with exactly `sessionId`, up to five unique `sourceVersions: [{sourceId, versionId}]`, and `behaviorFingerprint`. It refreshes the existing integration/session/actor/bot/project authority, entitlement when source references exist, each approved source/version and exact webchat grant under RLS, and the current methods fingerprint. It returns only `knowledge-check-v1/current`. It performs no full-text retrieval, source-text return, query-quota increment, or model evaluation. The existing public request rate limit still applies. The browser contract and CORS allow-header list are unchanged: these two headers are for the Studio server.

## Existing native signal route

Only `POST /api/integrations/evelyn/runtime/signal` selects the fixed Studio verifier. No new route, dispatcher, machine principal, context permission, tool permission or knowledge identity is added. Native authentication requires RS256/JWKS at the fixed Novalure issuer, exact Studio project ID/name, owner ID/name, Production subject/environment, the dedicated audience `urn:novalure:crm:shared-runtime:studio-webchat`, UUIDv4 JTI, valid issued/not-before/expiry times and at most 12 hours token lifetime. Custom environments, Origin, Cookie and URL query fields are denied. JTI shape is not a one-time replay ledger; the event ID provides the existing private signal idempotency.

The saved existing Studio integration fixes workspace/project/bot and supplies the current public broker. The server-only 117 per-bot map must match this complete verified tuple, with a dedicated private actor and a distinct 32-byte capability. The native JWT and capability never enter a browser, prompt, knowledge context or observation. Current broker/member, expiring enabled 117 binding, private actor, exact bot project and the existing integration resolver are rechecked through the existing runtime fence. The public actor continues to query public knowledge as itself; the private actor is used only to record a categorical signal.

Body: exactly UUIDv4 `eventId`, constant `issue: unclear_next_step`, and `outcome: pass | fail`. No transcript, source ID, summary, customer identifier, arbitrary issue, arbitrary model instruction or quality judgment is accepted. A known integration/project withdrawal returns a fixed authority-change status. A capability/binding denial grants nothing. Transport/COMMIT uncertainty returns `SIGNAL_UNCONFIRMED`, never a false absence claim, and the caller does not retry.

## Activation prerequisites, still outstanding

Both own Git branches have only their own auto-deploy exclusion. CRM defaults require `NOVALURE_SHARED_STUDIO_RUNTIME_ENABLED=1` plus the existing native methods/signals flags in Production; all remain untouched here. The existing server map requires a separately provisioned private per-assistant actor/capability and expiring disabled-first binding. Do not reuse the CEO capability/actor, change bot status, give internal-area grants to this signal actor, alter existing public grants, or broaden release targets as part of source deployment. Validate exact current integration/project/bot metadata again before any later activation. Root owns all live steps after personal acceptance and applicable exact-source reviews/CI.

## Local evidence

`scripts/shared-behavior-studio-tests.ts` uses disposable local PostgreSQL and synthetic content only. Actual handlers test fixed method metadata, no second knowledge charge, source-grant/method/session revocation, RS256 native claims, private signal RLS, event idempotency, expiry, integration revocation and context denial. Four tests PASS, including the parent test. The inherited `native-assistant-late-authority-tests.ts` also passes: 13 combined tests total. These are local consumption/auth tests, not a live publication or customer-traffic claim. The shared-behavior CI adds this suite; existing CI and independent review remain separate gates.
