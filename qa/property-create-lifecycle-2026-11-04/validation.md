# Direct property create lifecycle

Parent: `2a7ac7f2943fad98b8de510cb33914fcb0edf682` (root's scoped/decimal direct-entry UI plus scalar area knownness).

The CRM parent owns the existing in-memory property draft store for the signed-in identity. Direct-entry inputs and frozen create commands survive property-section unmounts and remain isolated by user, workspace and project filter. They never enter local/session storage. Changing identity discards the old store. The parent unload guard remains present while the property section is absent, including while an HTTP request is still in flight.

A shared synchronous mutation lock prevents another mounted form from sending a second create during an outstanding request. Remounting never sends automatically. An uncertain result restores locked inputs and an explicit retry with the identical endpoint, body, idempotency key and correlation ID. Terminal 4xx responses release the intent for correction; malformed/nonpersisted/wrong-scope success and 5xx/network failure retain it. Confirmation clears only the expected command key and submitted draft reference, so late responses cannot erase a different scope or newer inputs. The scope recovery instruction is displayed directly rather than overwritten by the generic uncertainty message.

Checks on the local loopback server, real React components in Chrome with React StrictMode, synthetic HTTP only:

- `node --import tsx scripts/property-direct-create-ui-tests.mjs`: 16 browser scenarios passed with no browser errors. Preserves the original nine checks and adds unsaved section remount, delayed request unmount/remount with one command, exact explicit replay after a lost response and remount, success while unmounted, independent workspace drafts/commands, late previous-user response, and project/user input isolation. Parent/store lifecycle uses the same hook as `CrmWorkspace`.
- `node --import tsx --test scripts/property-create-lifecycle-tests.ts scripts/property-cost-draft-tests.ts`: 8 passed, including stale command/draft acknowledgement and stale lock release guards plus existing cost draft regressions.
- `npm run typecheck`: passed.
- Focused ESLint on changed source/tests with zero warnings: passed.
- `git diff --check`: passed.

Evidence: `browser-results.json`. This is local UI/store qualification, not live acceptance, a database/role test or a full security audit. Existing server validation/idempotency dependencies documented in `qa/property-direct-create-2026-11-04/validation.md` still apply. The aggregate unit price remains unconfirmed at zero; asking-price knownness does not certify it.
