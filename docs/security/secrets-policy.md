# Secrets policy

This policy implements Autonomy and Access Framework `2.0.0` for Novalure CRM. Authorization to act is never authorization to disclose credentials.

## Mandatory handling

- Never place passwords, tokens, private keys, full connection strings, recovery codes or equivalent credential material in chat, model context, screenshots, logs, Git, PR text, reports or committed artifacts.
- Prefer workload identity, OIDC, managed identity and provider secret managers. Generate, transfer and consume credentials inside the authorized execution environment without making their values model-visible.
- Inspect secret metadata and sanitized status only. Restrict command and API output before it can reveal values.
- Keep privileged development/migration identities separate from Runtime identities. Runtime identities must never receive owner, superuser, organization-admin, `BYPASSRLS` or equivalent broad rights.
- Scope service accounts, app registrations, project permissions and network exceptions to the exact project and purpose. Record ownership and purpose; expire and remove temporary grants, variables and files after use, then verify removal without reading their values.
- If a step can only proceed by exposing a secret to the model, stop that path and prepare a secure host-side or human-entered alternative.
- Treat a disclosed credential as compromised: stop using it, revoke or rotate through the authorized process, clean up exposed artifacts and retain only sanitized incident evidence.

## Neon Runtime boundary

`RUNTIME SECRET STORED=PASS` is not proof that the password was established or that Runtime login, TLS, negative privilege tests and temporary Vault-right removal succeeded. Do not overwrite `prod-neon-runtime-db` without first verifying the existing secret metadata and a reviewed rotation/recovery path. Keep the blocker open until the missing evidence is actually produced.
