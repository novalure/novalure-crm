# Direct property entry: scope, decimals and safe retries

Base: `11c4384c0c5a360e448f441c822edc1057d9fe17` (leading CRM assistant revision).

This change sends the selected workspace through the existing scoped endpoint helper and verifies the confirmed property's workspace/project before clearing the form. Decimal inputs now match the supported area, room and currency precision. Optional year remains blank or an integer from 1 to 9999.

The pending operation freezes its request body, workspace, project and UUID metadata until a definitive response. A synchronous guard prevents two submissions before React updates. Network errors, server failures and malformed or wrong-scope success responses keep the same operation, lock editing and offer an explicit retry. An unload warning protects the pending in-memory operation. A confirmed save followed by a refresh failure is reported as saved and cannot replay the retired command.

Integration dependency: server commit `0a63bb46afe84619464077f7e97a543df4958e71` provides the matching `property.create` command receipt/replay contract; preserve `{data: listing, persisted: true}` and fresh project/role validation. Its predecessor `e6fe1e7` validates create inputs. Deploy these coordinated changes together, not the client retry change alone.

## Checks

- `CRM_QA_INPUT_BASELINE=1 node --import tsx scripts/property-direct-create-ui-tests.mjs`: the immutable original component reproduces both rejected valid decimals and the omitted workspace parameter. The source worktree is not changed for this run.
- `node --import tsx scripts/property-direct-create-ui-tests.mjs`: eight browser scenarios pass using the real component and synthetic HTTP responses. They cover decimal submission, invalid numeric values, exact retry after network failure, unload cancellation, wrong-scope and malformed response rejection, terminal validation correction, double submission, post-save refresh failure and no retargeting to a different workspace.
- `npm run typecheck`: passed.
- Focused ESLint with `--max-warnings=0`: passed.
- `git diff --check`: passed.

These are local browser checks, not production acceptance or a database/role test. Browser requests remain on the owned loopback server. No provider calls, invitations, live changes or paid tests were made. Durable drafts continue to use the existing guided workflow; direct-entry inputs and pending command body are not written to browser storage.
