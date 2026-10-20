# Isolated Evelyn Preview knowledge caller

This CRM QA fixture prepares one standalone Node 24 Vercel Function for the
existing Evelyn project `prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I`, in Preview only. It
imports no Evelyn application code and has no phone, provider, task-write, cron,
or general proxy operation. The primary CRM checkout and Evelyn repository are
not build inputs. Logical knowledge reads may create the receiver's normal audit
or usage records.

`contract.json` is reviewed source, not a request parameter or environment URL.
Its receiver origin stays `null` until the exact newly deployed CRM Preview URL
is known. Builds refuse this incomplete contract. Freeze the receiver origin in
source and review the new source/artifact hashes before deployment.

The contract pins Customer A, its bot, the unique published PDF query, source and
v1 version. Both positive responses must contain the unique marker and `09:00`,
and must exclude the replacement draft's `11:00`. The original 877-byte PDF SHA
is file-byte provenance from the hosted upload proof; the knowledge response
does not return the file and cannot independently rehash it. Excerpts and titles
are never returned or logged by this fixture.

The fixed suite makes exactly eight POST requests: published knowledge, missing
Bearer, native default-audience Bearer, and a freshly minted wrong-audience
Bearer, for each of the webchat and voice endpoints. Denials require the CRM's
JSON `ASSISTANT_ACCESS_DENIED` and HTTP 401/403. A Vercel protection page or
redirect cannot count as a passing denial. There are no suite parameters. A
completed suite returns HTTP 200 with an honest overall `PASS` or `FAIL` and
safe per-case statuses, counts and source/version hashes. This preserves proof
when the parent deliberately revokes a binding or voice grant through existing
trusted administrative routes. Trigger/runtime denial and deadline failures
remain distinct HTTP errors; no failed case is silently counted as passing.

The runtime accepts only `POST /api/package4-machine-proof`, with no query or
body, on its own provider `VERCEL_URL`. It requires Vercel Preview, the exact
Evelyn project, and a fresh random challenge in `x-package4-qa-challenge`.
Before any token retrieval or exchange, all 15 inherited Preview key names
pinned in the source contract must exist with the explicit empty-string value.
A missing or nonempty key fails closed before OIDC or CRM calls. Responses
report only expected/observed blank-key counts and `allBlank`; they expose no
key names or environment values. These pins come from native metadata only;
no inherited secret values are read by the preparation tooling.
`PACKAGE4_QA_CALLER_CHALLENGE` must be at least 32 random bytes encoded as
base64url, and `PACKAGE4_QA_CALLER_EXPIRES_AT` must be a Unix timestamp at most
one hour ahead. Generate and load these values privately; never print them or
pass them in command-line arguments. The short-lived challenge is specific to
this QA deployment; it is not a globally durable single-use lock. The parent
must retire it after the bounded proof. Retain Vercel Deployment Protection.

`getVercelOidcToken()` obtains the native default token for the official
`x-vercel-trusted-oidc-idp-token` protection header. Separate
`getVercelOidcToken({ audience, jti, skipCache: true })` exchanges mint actual
Vercel-signed business Bearers with a new UUID per custom-token request. SDK JWKS
verification pins project, owner, subject, issuer, environment and audience.
The native default audience is `https://vercel.com/novalure`; its issuer is
`https://oidc.vercel.com/novalure`. These are verified separately.
Workload claims do not assert a caller branch or deployment ID: the native
deployment receipt and artifact manifest provide that separate provenance.
No token, challenge, incoming header, cookie, response header, excerpt or raw
SDK error is exported or logged.

Run the local unit/security tests from the CRM worktree:

```sh
node --test scripts/qa-fixtures/evelyn-preview-knowledge-caller/caller.test.mjs
```

After the final source contract is frozen, prepare a new, empty stage:

```sh
node scripts/qa-fixtures/evelyn-preview-knowledge-caller/build.mjs --stage /absolute/new/stage
```

The build consumes the existing lockfile-pinned `@vercel/oidc@3.8.8` installation
and bundles dependencies into a single function. Its manifest records source,
dependency-input and artifact SHA-256 values and package-lock integrity. The
output routes only the one function; all other routes return 404. No environment
values or local authentication state enter the artifact. The fixture has a
30-second outer deadline, aborts CRM requests, rejects redirects, and limits
each response to 16 KiB.

Before any deployment, the parent must inventory the exact existing Evelyn
project, confirm Preview/OIDC/Deployment Protection, and blank-shadow every
inherited Preview environment key for this deployment except fresh reviewed
caller configuration and platform-managed OIDC/system context. Do not mutate
project/global environment settings or include any old secret values. Deploy
only this reviewed prebuilt stage as Preview to that existing project, with no
production flag or domain promotion. Verify the production deployment and
project environment metadata remain unchanged afterward. This directory does
not run deployment commands.
