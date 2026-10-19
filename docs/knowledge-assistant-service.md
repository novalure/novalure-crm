# Shared assistant knowledge context

Webchat and voice use the existing Knowledge Center repository/index. Only the
currently published version in explicitly assigned areas is retrieved. Each
request refreshes membership, project access, module entitlement and channel
grants. Draft edits never replace published answers. No retrieval cache is used.

The existing trusted entitlement JSON must explicitly contain
`features.webchatAccess: true` for webchat or `features.voiceAccess: true` for
voice/telephone. Missing flags deny that channel. A disabled workspace `bots`
module also denies assistant access. These commercial gates never replace
tenant membership, project permission or exact channel grants. Empty assignment
updates can revoke grants while the channel feature is disabled. Neither the
customer API nor these migrations provision contracts or subscriptions.

`POST /api/integrations/knowledge/voice` and
`POST /api/integrations/knowledge/webchat` accept JSON
`{"query":"Öffnungszeiten","maxResults":3}`. They require the existing verified
Evelyn Vercel OIDC bearer identity and the active native CRM service principal.
Cookies, Origin headers, URL parameters and extra JSON fields are rejected.
The installed verifier retains its existing pinned Evelyn workload/workspace;
it does not acquire access to other customer tenants through this endpoint.
The deployment/control plane must create an active row in
`knowledge_assistant_service_bindings` linking that principal to a same-tenant
bot and the endpoint's exact saved channel (`voice` or `webchat`). Runtime roles
cannot write this binding. No principal, credential or binding is provisioned by
migration 103. Existing principal expiry, revocation and kill switches remain in
force. Separate area grants remain required. Disable/revoke the binding to stop
access; principal/binding locks serialize this with an in-flight retrieval.

`telephony` in the internal integration contract means only the saved `voice`
channel. The historical `telephone` channel does not grant voice access.

`POST /api/public/integrations/chat/knowledge` extends the native External
Integration Gateway. It requires its allowed Origin, `X-Novalure-Site-Key`,
`X-Novalure-Session-Token`, and JSON `sessionId`, `query`, optional `maxResults`.
Browser calls include `?site_key=...` in the same OPTIONS/POST URL so the CORS
preflight can resolve the public integration; a supplied key header must match.
The active saved integration's `configuration.knowledgeAssistantId` must name a
same-tenant bot with the same project as the integration and active session.
The server fixes the channel to `webchat` and uses the gateway's trusted client
IP rate limiter. Neither body nor browser selects a tenant, project or assistant.

All adapters return `knowledge-context-v1` with `answerStatus`, `excerpts` and
`fallback`. Excerpts carry source/version references and a data trust label;
they are evidence, never executable instructions. Results are capped at five
(voice three), 600 characters per excerpt and 1,800 characters total. Queries
are at most 2,000 characters; JSON bodies are at most 8 KiB. The monthly contract
quota applies. SQL/lock waits are capped at 1.5 seconds; results completed after
the 2-second retrieval budget are discarded. Nested server calls inherit their
outer transaction timeout. Missing/disabled knowledge yields a German handoff
without claims. Current prices and inventory status require authorized live CRM
facts and are excluded from static context.

No Vapi client, phone number, payment, provider action or live connection is
created. A later native provider binding must authenticate through this gateway;
provider/model identifiers do not convey tenant authority.
