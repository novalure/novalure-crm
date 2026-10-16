# Novalure Studio signed CRM and calendar bridge

## Scope and authority

This branch extends the existing `website-sales-lead-v1` signed receiver. It
does not deploy a migration, grant Microsoft permissions, send invitations, or
activate a Production booking route. The Studio business line remains fixed on
the CRM server: workspace `8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101`, form
`0f98b9fd-d300-4a34-a14c-54a1a61b2415`, and the existing active internal
operator. The browser cannot select another tenant or CRM actor.

Migration `097_studio_sales_calendar_bridge.sql` adds a transaction-bound
handoff reference with the actual CRM lead and submission IDs, then a separate
booking state table. Both tables have forced RLS, exact Studio actor/workspace
policies, active-membership checks and restricted grants. The booking table
stores the hashed idempotency key and request hash, provider transaction ID,
status, exact organizer/calendar/policy binding, calendar event ID, Teams URL when present, invitation trigger flag,
bounded error code and the lead link. No contact detail, message or provider
response body is written to application logs.

The lead receiver verifies the existing timestamped HMAC, consent, bounded
payload, trusted client IP and server-fixed tenant. The accepted response
includes a public reference and an internal `crmLeadId` for the Studio server;
the browser-facing Studio route returns the reference only. A signed
`X-Novalure-Status-Only: 1` request reads the completed durable receipt using
the same body and idempotency key without creating a lead.

## Calendar path

`POST /api/public/website-sales/booking` accepts only a separate versioned
HMAC (`website-sales-booking-v1`) for `availability`, `book` or `status`.
It is disabled unless the runtime is Vercel Preview, or the isolated local
database test harness, and the full policy is configured. The policy requires
an approval ID matching `STUDIO_BOOKING_CONFIG_APPROVAL_ID`; no policy values
are supplied in this branch. `MICROSOFT_CALENDAR_USER_ID` must exactly match
the configured organizer. The provider uses the existing Microsoft tenant,
client ID and client secret with an explicit user and calendar ID. Ambient
`/me` access tokens cannot choose the organizer for this operation.

Availability reads every Graph calendarView page within a bounded horizon and
fails closed on errors, truncation or unexpected responses. It reveals only
free slot times. The booking transaction serializes claims and checks active
overlap before calling Graph. A second Graph availability check immediately
precedes event creation. The create request includes the visitor as attendee,
minimal meeting information, and a durable Graph `transactionId`. Teams
bookings require a provider-returned HTTPS Teams link. Graph acceptance with
attendees triggers invitations; inbox receipt is not asserted.

An uncertain creation is never blindly sent again. A signed status request
scans the exact calendar around the saved time for the saved transaction ID.
Reconciliation stops for manual review if the approved calendar binding has
changed since the claim. When found, CRM persists the actual event ID and link; if the link is missing,
the state remains `needs_attention`. A DB update failure after Graph success
leaves the booking row for the same reconciliation path. The visitor receives
`booked` only after provider creation and CRM persistence both succeed.

## Configuration and proof still required

- Approved isolated Preview CRM and Neon target, separate from Production.
- Approved Franz organizer ID, exact calendar ID, IANA time zone, duration,
  slot interval, daily windows, notice, buffer and horizon in
  `STUDIO_BOOKING_POLICY_JSON`, with an external approval record ID.
- Existing Microsoft client credential permission to read that calendar,
  create an attendee event there and create a Teams meeting; each capability
  must be proved independently with approved QA accounts and test recipients.
- Exact secret binding between Studio and CRM QA deployments, target identity,
  migrations, rollback, security/privacy review, and audit/monitoring gates.
- A separate Production activation change and all eight exact-target Production
  gates; this branch explicitly rejects Production calendar activation.

## Evidence

Local embedded-Postgres tests with synthetic Graph responses cover HMAC and
tenant failures, durable lead IDs, replay, concurrent slot claims, phone and
Teams payloads, DST gaps and repeated clocks, timeout reconciliation,
provider success followed by CRM update failure, and denied provider access.
`INTEGRATION_IMPLEMENTED` and `LOCAL_PASS` apply to this branch. No approved
real QA target or permission was available: `QA_VERIFIED` is open.
`PRODUCTION_VERIFIED` is open. Local tests never establish either status.

Microsoft API basis: [calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0),
[create event in a specified calendar](https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0),
and [event `transactionId`](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0).
