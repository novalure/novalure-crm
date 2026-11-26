# Mailbox connection status presentation

This candidate projects the stored connection into a user-facing status. It is
not a provider health check and it does not change the connection row or tokens.
An authenticated connection with disallowed or malformed stored permissions is
shown as requiring review. Enabling automatic checking is refused for a
verified Microsoft connection with such permissions; disabling it remains
possible when an authorized active CRM session and the database are available.
Existing shared-client Microsoft connections show a warning for additional
permissions but retain their existing operational behavior. Microsoft display
also checks the configured identity mode against stored tenant, subject and
account binding. Actual manual and automatic provider calls retain their
independent server-side permission checks.

A non-null synchronization lease or a still-running manual synchronization
record is shown as an unconfirmed check, including an expired but uncleared
lease. A pending or failed browser operation does not present stale mailbox data
as confirmed: the visible mailbox state is cleared if loading or a command
fails. A configured connection is labeled as configured, not guaranteed live.
The time of the last completed fetch remains a historical fact, not proof of a
fresh fetch or complete mailbox reconciliation. An old `current` automatic
status is not represented as verified current. A per-view request fence stops
an earlier response from restoring discarded state after a later action fails;
this does not cancel the underlying request.

This projection cannot guarantee an error was persisted during a database
outage. For example, an unrelated permitted settings operation may clear a
lease; not every automatic run has its own persistent run row. A missing marker
therefore cannot prove a successful refresh, and a previous marker can remain
indefinitely after a crash until separately reconciled. Recovery and persisted
error-state guarantees need an independently reviewed durable design. RLS,
transaction races, real database failure, browser network behavior, Microsoft
and production deployment are not established by synthetic tests.
