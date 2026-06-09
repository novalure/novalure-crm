import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

const testDbHost = "ep-morning-fog-al1enszq-pooler.c-3.eu-central-1.aws.neon.tech";
const testDbSuffix = "98273025";
const prodDbHost = "ep-wandering-union-alem0781-pooler.c-3.eu-central-1.aws.neon.tech";

function loadEnvFile(path) {
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function maskDatabaseUrl(value) {
  return value
    .replace(/:\/\/[^:@/]+:([^@/]+)@/, "://***:***@")
    .replace(/(project|database|dbname)=([^&\s]+)/gi, "$1=***");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function buildField(input) {
  return {
    conditionalFieldId: "",
    conditionalValue: "",
    defaultValue: "",
    errorMessage: "",
    fileAccept: "",
    fileMaxMb: 0,
    helpText: "",
    maxValue: "",
    minValue: "",
    multiple: false,
    options: [],
    placeholder: "",
    stepId: "contact",
    validationPattern: "",
    ...input,
  };
}

async function postForm(baseUrl, body, acceptJson = false) {
  return fetch(new URL("/api/forms/submissions", baseUrl), {
    body,
    headers: {
      Accept: acceptJson ? "application/json" : "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
}

async function postBooking(baseUrl, body) {
  return fetch(new URL("/api/meetings/bookings", baseUrl), {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const json = await response.json().catch(() => ({}));
  return { json, response };
}

function nextWeekdayDate(offsetDays = 2) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

loadEnvFile(join(process.cwd(), ".env.local"));

const databaseUrl = process.env.DATABASE_URL;
assert(databaseUrl, "DATABASE_URL is missing");
const parsedDatabaseUrl = new URL(databaseUrl);
const activeHost = parsedDatabaseUrl.hostname;
const maskedUrl = maskDatabaseUrl(databaseUrl);

console.log(`Active DATABASE_URL: ${maskedUrl}`);
console.log(`Active DB host: ${activeHost}`);
console.log(`Expected Test DB suffix: ${testDbSuffix}`);

assert(activeHost === testDbHost, `Refusing to write: active DB host is not the Test DB (${testDbHost})`);
assert(activeHost !== prodDbHost, "Refusing to write: active DB host is the Prod DB");

const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.SLUGFIX_BASE_URL || "http://127.0.0.1:3000";
const runId = `SLUGFIX_TEST_${Date.now()}`;
const slug = `slugfix-${Date.now()}`;
const contactEmail = `${runId.toLowerCase()}@example.test`;
const sql = neon(databaseUrl);
let workspaceA;
let workspaceB;

try {
  const health = await fetch(publicBaseUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => {
    throw new Error(`PUBLIC_BASE_URL is not reachable (${publicBaseUrl}): ${error.message}`);
  });
  assert(health.status < 500, `PUBLIC_BASE_URL responded with ${health.status}`);

  await sql`
    delete from workspaces
    where name like 'SLUGFIX_TEST_%'
  `;

  [workspaceA] = await sql`
    insert into workspaces (name)
    values (${`${runId} Workspace A`})
    returning id, public_key as "publicKey"
  `;
  [workspaceB] = await sql`
    insert into workspaces (name)
    values (${`${runId} Workspace B`})
    returning id, public_key as "publicKey"
  `;
  assert(workspaceA?.publicKey && workspaceB?.publicKey, "Migration did not create workspace public keys");

  const formFields = [
    buildField({ crmField: "name", id: "name", label: "Name", required: true, type: "text" }),
    buildField({ crmField: "email", id: "email", label: "E-Mail", required: true, type: "email" }),
    buildField({
      crmField: "privacy_consent",
      id: "privacy_consent",
      label: "Datenschutz",
      required: true,
      type: "consent",
    }),
  ];
  const formSettings = {
    doubleOptIn: false,
    spamProtection: false,
    steps: [{ description: "", id: "contact", title: "Kontakt" }],
  };
  const formActions = {
    createTask: false,
    followUpEmail: false,
    redirectUrl: "",
    thankYouMessage: "Danke",
  };

  await sql`
    insert into forms (workspace_id, name, slug, status, variant, template, crm_target, fields, actions, settings)
    values
      (${workspaceA.id}, ${`${runId} Form A`}, ${slug}, 'eingebaut', 'standalone', 'contact', 'lead', ${JSON.stringify(formFields)}::jsonb, ${JSON.stringify(formActions)}::jsonb, ${JSON.stringify(formSettings)}::jsonb),
      (${workspaceB.id}, ${`${runId} Form B`}, ${slug}, 'eingebaut', 'standalone', 'contact', 'lead', ${JSON.stringify(formFields)}::jsonb, ${JSON.stringify(formActions)}::jsonb, ${JSON.stringify(formSettings)}::jsonb)
  `;

  const meetingConfig = {
    availability: {
      bufferMinutes: 0,
      durationMinutes: 30,
      intervalMinutes: 30,
      minNoticeMinutes: 0,
      rollingWeeks: 4,
      timeZone: "Europe/Vienna",
      weeklyHours: [
        { day: 1, end: "17:00", start: "09:00" },
        { day: 2, end: "17:00", start: "09:00" },
        { day: 3, end: "17:00", start: "09:00" },
        { day: 4, end: "17:00", start: "09:00" },
        { day: 5, end: "17:00", start: "09:00" },
      ],
    },
    defaultMeetingProvider: "manual-link",
    defaultProvider: "none",
  };
  const meetingAutomation = {
    allowCancel: true,
    allowReschedule: true,
    confirmationEnabled: false,
    postFollowUpEnabled: false,
    reminderEnabled: false,
  };

  await sql`
    insert into meeting_pages (workspace_id, slug, title, status, calendar_integrations, share_config, automation)
    values
      (${workspaceA.id}, ${slug}, ${`${runId} Meeting A`}, 'active', ${JSON.stringify(meetingConfig)}::jsonb, '{}'::jsonb, ${JSON.stringify(meetingAutomation)}::jsonb),
      (${workspaceB.id}, ${slug}, ${`${runId} Meeting B`}, 'active', ${JSON.stringify(meetingConfig)}::jsonb, '{}'::jsonb, ${JSON.stringify(meetingAutomation)}::jsonb)
  `;

  const formBody = new URLSearchParams({
    email: contactEmail,
    form_slug: `${workspaceA.publicKey}/${slug}`,
    name: `${runId} Contact`,
    privacy_consent: "on",
    return_to: `/forms/${workspaceA.publicKey}/${slug}`,
    slugfix_probe: runId,
    utm_source: "slugfix_qa",
  });
  const formResponse = await postForm(publicBaseUrl, formBody, true);
  const formJson = await formResponse.json().catch(() => ({}));
  assert(formResponse.status === 200 && formJson.persisted === true, `Form submit failed: ${formResponse.status}`);

  const [submission] = await sql`
    select workspace_id as "workspaceId", form_id as "formId"
    from form_submissions
    where raw_payload->>'slugfix_probe' = ${runId}
    order by created_at desc
    limit 1
  `;
  assert(submission?.workspaceId === workspaceA.id, "Form submission was not written to Workspace A");

  const badFormBody = new URLSearchParams(formBody);
  badFormBody.set("form_slug", `bad_${workspaceA.publicKey}/${slug}`);
  badFormBody.set("email", `bad_${contactEmail}`);
  const badFormResponse = await postForm(publicBaseUrl, badFormBody, true);
  assert(badFormResponse.status === 404, `Bad form key should be 404, got ${badFormResponse.status}`);

  const availabilityDate = nextWeekdayDate();
  const availabilityAUrl = new URL("/api/meetings/availability", publicBaseUrl);
  availabilityAUrl.searchParams.set("workspace_public_key", workspaceA.publicKey);
  availabilityAUrl.searchParams.set("slug", slug);
  availabilityAUrl.searchParams.set("date", availabilityDate);
  const availabilityA = await getJson(availabilityAUrl);
  assert(availabilityA.response.status === 200, `Availability A failed: ${availabilityA.response.status}`);
  const slot = availabilityA.json.availability?.slots?.find((item) => item.available)?.time;
  assert(slot, "No available slot returned for Workspace A");

  const availabilityBUrl = new URL(availabilityAUrl);
  availabilityBUrl.searchParams.set("workspace_public_key", workspaceB.publicKey);
  const availabilityB = await getJson(availabilityBUrl);
  assert(availabilityB.response.status === 200, `Availability B failed: ${availabilityB.response.status}`);

  const legacyAvailabilityUrl = new URL("/api/meetings/availability", publicBaseUrl);
  legacyAvailabilityUrl.searchParams.set("slug", slug);
  const legacyAvailability = await getJson(legacyAvailabilityUrl);
  assert(legacyAvailability.response.status === 409, `Ambiguous legacy availability should be 409, got ${legacyAvailability.response.status}`);

  const bookingBody = new URLSearchParams({
    calendar: "none",
    email: contactEmail,
    meeting: "manual-link",
    name: `${runId} Booking`,
    selectedDate: availabilityA.json.availability.date,
    slot,
    slug,
    utm_source: "slugfix_qa",
    workspace_public_key: workspaceA.publicKey,
  });
  const bookingResponse = await postBooking(publicBaseUrl, bookingBody);
  assert([302, 303, 307, 308].includes(bookingResponse.status), `Booking should redirect, got ${bookingResponse.status}`);
  const bookingLocation = bookingResponse.headers.get("location") || "";
  assert(bookingLocation.includes(`/book/${workspaceA.publicKey}/${slug}`), "Booking redirect is not canonical");

  const [booking] = await sql`
    select workspace_id as "workspaceId", meeting_page_id as "meetingPageId"
    from meeting_bookings
    where contact_email = ${contactEmail}
      and slug = ${slug}
    order by created_at desc
    limit 1
  `;
  assert(booking?.workspaceId === workspaceA.id, "Booking was not written to Workspace A");

  const badBookingBody = new URLSearchParams(bookingBody);
  badBookingBody.set("workspace_public_key", `bad_${workspaceA.publicKey}`);
  badBookingBody.set("email", `bad_booking_${contactEmail}`);
  const badBookingResponse = await postBooking(publicBaseUrl, badBookingBody);
  assert([302, 303, 307, 308].includes(badBookingResponse.status), `Bad booking should redirect with error, got ${badBookingResponse.status}`);
  const [badBooking] = await sql`
    select id
    from meeting_bookings
    where contact_email = ${`bad_booking_${contactEmail}`}
    limit 1
  `;
  assert(!badBooking, "Bad workspace key created a booking");

  console.log("FU-01 form submit isolation: PASS");
  console.log("FU-02 meeting availability/book isolation: PASS");
  console.log(`Synthetic prefix: ${runId}`);
} finally {
  if (workspaceA?.id || workspaceB?.id) {
    await sql`
      delete from workspaces
      where id = any(${[workspaceA?.id, workspaceB?.id].filter(Boolean)}::uuid[])
    `;
  }
}
