# Verified Microsoft mailbox scope boundary

The new Microsoft verified-identity mailbox flow requests read-only mail plus
OpenID identity, profile and offline refresh scopes. A successful, separate
Microsoft authorization-only preview observed the OpenID `email` scope in
Microsoft's response. That isolated result does not establish CRM connection,
mail retrieval, refresh, database behavior, or production readiness.

For verified Microsoft connections, this change accepts only `Mail.Read`,
`User.Read`, `openid`, `profile`, `email` and `offline_access`, allowing the
Microsoft Graph prefix for returned Graph scopes. It requires `Mail.Read` and
rejects `Mail.ReadWrite`, `Mail.Send` and unrecognized extra scopes. The rule
applies to the provider response on code exchange and refresh, an authenticated
verified connection save, and previously recorded verified scopes before a
manual or scheduled sync starts provider I/O. When Microsoft omits scopes on a
refresh, the existing stored scopes are rechecked rather than assumed safe.
Legacy Microsoft and Google connections retain their existing behavior.

This is a check of the provider-reported and stored scope list, not independent
proof of every privilege in a bearer token, all admin grants, application
registration, or future provider behavior. Restrict the actual Entra app and
federation, verify its target and consent, and test OAuth, refresh, identity,
restricted runtime, CRM data handling and revocation independently. A direct
database caller and a malicious provider are outside this code-level guarantee.
Failing this check may require a personal reconnection; no credentials, database
rows, prior permissions or provider settings are modified by this document.

The verified path remains deliberately preview-only. This change neither
activates production nor proves that any existing connection or mailbox is
ready; real customer data must not be put into an artificial test database.
