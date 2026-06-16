#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { neon } from "@neondatabase/serverless";

const CODEX_PREFIX = "CODEXTEST_";
const defaultQaPassword = "QA-Novalure-Local-2026!";
const envFiles = [".env.local", ".env.production.local"];
const novalureGrowthWorkspaceId = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const novalureGrowthStages = ["Neu", "Qualifiziert", "Demo gebucht", "Demo gehalten", "Angebot", "Pilot", "Gewonnen", "Verloren"];
const novalureGrowthSources = ["Website", "Empfehlung", "LinkedIn", "Partner", "Event", "Newsletter", "Outbound", "Formular"];

function loadEnv(path) {
  if (!fs.existsSync(path)) return;

  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

for (const file of envFiles) loadEnv(file);

const baseUrl = (process.env.NOVALURE_QA_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const explicitQaEmail = process.env.NOVALURE_QA_EMAIL || process.env.QA_LOGIN_EMAIL || "";
const configuredEmail = explicitQaEmail || "franz@novalure.local";
const configuredPassword =
  process.env.NOVALURE_QA_PASSWORD ||
  process.env.QA_LOGIN_PASSWORD ||
  process.env.NOVALURE_LOGIN_PASSCODE ||
  defaultQaPassword;

function cleanDatabaseUrl(value) {
  if (!value) return "";
  const trimmed = String(value).trim().replace(/^['"]|['"]$/g, "");
  const prefixedUrl = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);
  return prefixedUrl?.[1] ?? trimmed;
}

const databaseUrl =
  cleanDatabaseUrl(process.env.DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL) ||
  cleanDatabaseUrl(process.env.POSTGRES_PRISMA_URL);

const sql = databaseUrl ? neon(databaseUrl) : null;
const cookies = new Map();
const matrix = [];
const createdRecords = [];
const technicalErrors = [];

function statusIcon(ok) {
  if (ok === true) return "gruen";
  if (ok === false) return "rot";
  return "unklar";
}

function addMatrix(row) {
  matrix.push({
    entity: row.entity,
    operation: row.operation,
    expected: row.expected,
    actual: row.actual,
    dbReadConfirmed: row.dbReadConfirmed ?? "nein",
    status: row.status ?? statusIcon(row.ok),
    cause: row.cause ?? "",
  });
}

function addCreated(type, id, location, label) {
  if (!id) return;
  createdRecords.push({ type, id, location, label });
}

function sameArray(actual, expected) {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function splitSetCookie(header) {
  if (!header) return [];
  return header.split(/,(?=[^;,]+=)/g);
}

function storeCookies(headers) {
  const values =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [];
  const cookieValues = values.length ? values : splitSetCookie(headers.get("set-cookie"));

  for (const value of cookieValues) {
    const [cookie] = value.split(";");
    const separator = cookie.indexOf("=");
    if (separator === -1) continue;
    const name = cookie.slice(0, separator).trim();
    const cookieValue = cookie.slice(separator + 1).trim();
    if (!cookieValue) cookies.delete(name);
    else cookies.set(name, cookieValue);
  }
}

function cookieHeader() {
  return Array.from(cookies.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const init = {
    headers,
    method: options.method ?? "GET",
    redirect: options.redirect ?? "manual",
  };

  if (options.auth !== false && cookies.size > 0) {
    headers.set("cookie", cookieHeader());
  }

  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.json);
  } else if (options.body !== undefined) {
    init.body = options.body;
  }

  const response = await fetch(`${baseUrl}${path}`, init);
  storeCookies(response.headers);
  const contentType = response.headers.get("content-type") ?? "";
  const json = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
  const text = json ? "" : await response.text().catch(() => "");
  return { json, response, text };
}

async function dbQuery(query, params = []) {
  if (!sql) throw new Error("No database URL is configured for direct DB verification.");
  return await sql.query(query, params);
}

async function findLoginCandidate() {
  if (explicitQaEmail) return configuredEmail;
  if (!sql) return configuredEmail;

  const candidates = [
    configuredEmail,
    "qa-platform-admin@novalure.local",
    "franz@novalure.local",
  ];
  const rows = await dbQuery(
    `
      select email
      from workspace_users
      where status = 'active'
        and role in ('owner', 'admin', 'agent')
      order by
        case
          when lower(email) = lower($1) then 0
          when lower(email) like 'qa-%' then 1
          when role = 'owner' then 2
          when role = 'admin' then 3
          else 4
        end,
        created_at asc
      limit 10
    `,
    [configuredEmail],
  );

  for (const email of candidates) {
    if (rows.some((row) => String(row.email).toLowerCase() === email.toLowerCase())) return email;
  }
  return rows[0]?.email ?? configuredEmail;
}

async function login() {
  const email = await findLoginCandidate();
  const body = new URLSearchParams({ email, password: configuredPassword, returnTo: "/" });
  const result = await request("/api/auth/login", {
    auth: false,
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  if (![302, 303, 307, 308].includes(result.response.status) || !cookies.has("novalure_session")) {
    throw new Error(`Login failed with status ${result.response.status}. Set NOVALURE_QA_EMAIL and NOVALURE_QA_PASSWORD if this database uses real user passwords.`);
  }
}

async function getSession() {
  const result = await request("/api/auth/session");
  if (!result.response.ok || !result.json?.authenticated) {
    throw new Error(`/api/auth/session failed with status ${result.response.status}`);
  }
  return result.json;
}

async function getCore() {
  const result = await request("/api/crm/core");
  if (!result.response.ok) {
    throw new Error(`/api/crm/core failed with status ${result.response.status}`);
  }
  return result.json;
}

async function logoutAndLoginAgain() {
  await request("/api/auth/logout", { method: "POST" }).catch(() => null);
  cookies.clear();
  await login();
}

function recordApiError(scope, result) {
  if (result.response.ok) return;
  const body = result.json ? JSON.stringify(result.json) : String(result.text).slice(0, 500);
  technicalErrors.push({ scope, status: result.response.status, body });
}

async function dbReadById(table, id, workspaceId) {
  if (!id) return null;
  const rows = await dbQuery(`select * from ${table} where id = $1 and workspace_id = $2 limit 1`, [id, workspaceId]);
  return rows[0] ?? null;
}

async function dbReadLeadByLegacyId(workspaceId, legacyId, fallbackIntent) {
  const rows = await dbQuery(
    `
      select *
      from leads
      where workspace_id = $1
        and (
          metadata->>'legacyId' = $2
          or intent = $3
        )
      order by received_at desc
      limit 1
    `,
    [workspaceId, legacyId, fallbackIntent],
  );
  return rows[0] ?? null;
}

async function runContactTests(context) {
  const stamp = context.stamp;
  const contactName = `${CODEX_PREFIX}CONTACT_${stamp}`;
  const email = `codextest-contact-${stamp}@example.test`;
  const create = await request("/api/crm/contacts", {
    json: {
      contact: {
        consent: `${CODEX_PREFIX}CONSENT_OPT_IN`,
        email,
        intent: `${CODEX_PREFIX}Contact create DB read`,
        name: contactName,
        phone: `+43 660 ${stamp.slice(-6)}`,
        projectId: context.projectId,
        role: "Buyer",
        source: "Manual",
      },
    },
    method: "POST",
  });
  recordApiError("Contact create", create);
  const contactId = create.json?.contact?.id;
  const contactRow = await dbReadById("contacts", contactId, context.workspaceId);
  addCreated("Kontakt", contactId, "contacts", contactName);
  addMatrix({
    entity: "Kontakt",
    operation: "Create",
    expected: "persistiert + per DB lesbar",
    actual: create.response.ok ? `HTTP ${create.response.status}, id ${contactId}` : `HTTP ${create.response.status}`,
    dbReadConfirmed: contactRow ? "ja" : "nein",
    ok: create.response.ok && Boolean(contactRow) && contactRow.name === contactName,
    cause: create.response.ok ? "" : create.json?.error ?? create.text,
  });

  const editedName = `${contactName}_EDITED`;
  const update = await request("/api/crm/contacts", {
    json: {
      contact: {
        consent: `${CODEX_PREFIX}CONSENT_OPT_OUT`,
        email,
        id: contactId,
        intent: `${CODEX_PREFIX}Contact update DB read`,
        name: editedName,
        phone: `+43 699 ${stamp.slice(-6)}`,
        projectId: context.projectId,
        role: "Investor",
        source: "Manual",
      },
    },
    method: "PATCH",
  });
  recordApiError("Contact update", update);
  const editedContactRow = await dbReadById("contacts", contactId, context.workspaceId);
  addMatrix({
    entity: "Kontakt",
    operation: "Update",
    expected: "Aenderung persistiert",
    actual: update.response.ok ? `HTTP ${update.response.status}` : `HTTP ${update.response.status}`,
    dbReadConfirmed: editedContactRow?.name === editedName ? "ja" : "nein",
    ok: update.response.ok && editedContactRow?.name === editedName,
    cause: update.response.ok ? "" : update.json?.error ?? update.text,
  });

  const consentRows = await dbQuery(
    `
      select id, status
      from consent_records
      where workspace_id = $1 and contact_id = $2
      order by id desc
      limit 5
    `,
    [context.workspaceId, contactId],
  );
  for (const row of consentRows) addCreated("Consent", row.id, "consent_records", row.status);
  addMatrix({
    entity: "Consent",
    operation: "Create/Update ueber Kontakt",
    expected: "Consent-Status wird als DB-Datensatz geschrieben",
    actual: `${consentRows.length} consent_records für Kontakt`,
    dbReadConfirmed: consentRows.some((row) => row.status === `${CODEX_PREFIX}CONSENT_OPT_OUT`) ? "ja" : "nein",
    ok: consentRows.some((row) => row.status === `${CODEX_PREFIX}CONSENT_OPT_OUT`),
    cause: consentRows.length ? "" : "Kein consent_records-Datensatz nach Kontakt-Speicherung gefunden",
  });

  context.contactId = contactId;
  context.contactEmail = email;
}

async function runLeadTests(context) {
  const stamp = context.stamp;
  const localLeadId = `lead_local_codextest_${stamp}`;
  const intent = `${CODEX_PREFIX}LEAD_${stamp}`;
  const create = await request("/api/crm/leads", {
    json: {
      lead: {
        id: localLeadId,
        projectId: context.projectId,
        contactId: context.contactId,
        source: "Manual",
        type: "Buyer",
        status: "Neu",
        score: 67,
        budget: "520000",
        intent,
        nextAction: `${CODEX_PREFIX}Lead next action`,
        receivedAt: new Date().toISOString(),
        slaDueAt: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
        assignedToUserId: context.userId,
        buyerProfile: {
          budgetFrom: 450000,
          budgetTo: 650000,
          desiredLocation: "CODEXTEST Vienna",
          financingStatus: "unknown",
          mustHaveCriteria: ["CODEXTEST balcony"],
          niceToHaveCriteria: ["CODEXTEST garage"],
          propertyType: "Apartment",
        },
      },
    },
    method: "POST",
  });
  recordApiError("Lead create", create);
  const returnedLeadId = create.json?.lead?.id;
  const leadRow = returnedLeadId
    ? await dbReadById("leads", returnedLeadId, context.workspaceId)
    : await dbReadLeadByLegacyId(context.workspaceId, localLeadId, intent);
  const leadId = returnedLeadId ?? leadRow?.id;
  addCreated("Lead", leadId, "leads", intent);
  addMatrix({
    entity: "Lead",
    operation: "Create",
    expected: "persistiert + per DB lesbar + API Erfolg",
    actual: create.response.ok ? `HTTP ${create.response.status}, id ${returnedLeadId}` : `HTTP ${create.response.status}`,
    dbReadConfirmed: leadRow ? "ja" : "nein",
    ok: create.response.ok && Boolean(leadRow) && leadRow.intent === intent,
    cause: create.response.ok ? "" : create.json?.error ?? create.text,
  });

  const updatedAction = `${CODEX_PREFIX}Lead qualified ${stamp}`;
  const update = await request("/api/crm/leads", {
    json: {
      lead: {
        id: leadId,
        projectId: context.projectId,
        contactId: context.contactId,
        source: "Manual",
        type: "Buyer",
        status: "Qualifizieren",
        score: 72,
        intent,
        nextAction: updatedAction,
        assignedToUserId: context.userId,
      },
    },
    method: "PATCH",
  });
  recordApiError("Lead update", update);
  const updatedLeadRow = await dbReadById("leads", leadId, context.workspaceId);
  addMatrix({
    entity: "Lead",
    operation: "Update",
    expected: "Status/Naechste Aktion persistieren + API Erfolg",
    actual: update.response.ok ? `HTTP ${update.response.status}` : `HTTP ${update.response.status}`,
    dbReadConfirmed: updatedLeadRow?.next_action === updatedAction && updatedLeadRow?.status === "Qualifizieren" ? "ja" : "nein",
    ok: update.response.ok && updatedLeadRow?.next_action === updatedAction && updatedLeadRow?.status === "Qualifizieren",
    cause: update.response.ok ? "" : update.json?.error ?? update.text,
  });

  await logoutAndLoginAgain();
  const core = await getCore();
  const persistedAfterNewSession = (core.data?.leads ?? []).some((lead) => lead.id === leadId && lead.nextAction === updatedAction);
  addMatrix({
    entity: "Lead",
    operation: "Persistenz nach neuer Session",
    expected: "Lead ist nach neuer Session im DB-Core sichtbar",
    actual: persistedAfterNewSession ? "in /api/crm/core sichtbar" : "nicht in /api/crm/core sichtbar",
    dbReadConfirmed: updatedLeadRow ? "ja" : "nein",
    ok: persistedAfterNewSession,
    cause: persistedAfterNewSession ? "" : "Core-Reload zeigt Lead nicht mit dem gespeicherten Stand",
  });

  const invalid = await request("/api/crm/leads", {
    json: {
      lead: {
        projectId: context.projectId,
        contactId: context.contactId,
        intent: `${CODEX_PREFIX}INVALID_LEAD_${stamp}`,
        nextAction: `${CODEX_PREFIX}Invalid due date`,
        nextContactAt: "2020-01-01T00:00:00.000Z",
      },
    },
    method: "POST",
  });
  addMatrix({
    entity: "Lead",
    operation: "Fehlerfall",
    expected: "ungültiger Schreibvorgang wird klar abgelehnt",
    actual: `HTTP ${invalid.response.status} ${invalid.json?.error ?? ""}`.trim(),
    dbReadConfirmed: "nein",
    ok: !invalid.response.ok && Boolean(invalid.json?.error),
    cause: invalid.response.ok ? "Ungültiger Lead wurde akzeptiert" : invalid.json?.error ?? invalid.text,
  });

  context.leadId = leadId;
}

function getSourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) return "";
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end === -1 ? undefined : end);
}

function runLeadUiStateGuardTest() {
  const source = fs.readFileSync("src/components/lead-inbox.tsx", "utf8");
  const blocks = [
    getSourceBlock(source, "const saveFieldDraft = async", "const acceptLead = async"),
    getSourceBlock(source, "const acceptLead = async", "const archiveLead = async"),
    getSourceBlock(source, "const archiveLead = async", "const createTask = async"),
  ];
  const mutationAfterPersist = blocks.every((block) => {
    const persistIndex = block.indexOf("await persistLead");
    const updateIndex = block.indexOf("updateLead(");
    const activityIndex = block.indexOf("addActivity(");
    return persistIndex !== -1 && updateIndex > persistIndex && activityIndex > persistIndex;
  });
  const visibleErrorOnFailure = blocks.every((block) => block.includes("catch") && block.includes("setNotice(text.saveError)"));

  addMatrix({
    entity: "Lead",
    operation: "UI Fehler-Rollback",
    expected: "lokaler UI-Status wird erst nach API-Erfolg gesetzt",
    actual: mutationAfterPersist && visibleErrorOnFailure
      ? "persistLead vor updateLead/addActivity, Fehler setzt saveError"
      : "lokaler Zustand kann vor API-Erfolg geändert werden",
    dbReadConfirmed: "n/a",
    ok: mutationAfterPersist && visibleErrorOnFailure,
    cause: mutationAfterPersist && visibleErrorOnFailure
      ? ""
      : "Lead-Inbox kann UI-State vor bestätigtem Server-Save ändern oder Fehler nicht sichtbar melden",
  });
}

async function runProjectTests(context) {
  const stamp = context.stamp;
  const name = `${CODEX_PREFIX}PROJECT_${stamp}`;
  const beforeCore = await getCore();
  const beforeWorkspace = await request("/api/workspaces");
  const beforeWorkspaceCount = beforeWorkspace.json?.workspaces?.find((item) => item.id === context.workspaceId)?.activeProjects;
  const create = await request("/api/crm/projects", {
    json: {
      project: {
        name,
        status: "Aktiv",
        type: "CODEXTEST real estate project",
        customerType: "real_estate_broker",
        defaultOperatingModel: "self_service_customer",
        setupDefaults: { calendarProvider: "none", meetingProvider: "manual-link", teamStructure: "small_team" },
      },
    },
    method: "POST",
  });
  recordApiError("Project create", create);
  const projectId = create.json?.project?.id;
  const projectRow = await dbReadById("projects", projectId, context.workspaceId);
  addCreated("Projekt", projectId, "projects", name);
  addMatrix({
    entity: "Projekt",
    operation: "Create",
    expected: "persistiert + per DB lesbar",
    actual: create.response.ok ? `HTTP ${create.response.status}, id ${projectId}` : `HTTP ${create.response.status}`,
    dbReadConfirmed: projectRow ? "ja" : "nein",
    ok: create.response.ok && projectRow?.name === name,
    cause: create.response.ok ? "" : create.json?.error ?? create.text,
  });

  const editedName = `${name}_EDITED`;
  const patch = await request("/api/crm/projects", {
    json: { project: { id: projectId, name: editedName } },
    method: "PATCH",
  });
  recordApiError("Project update", patch);
  const editedProjectRow = await dbReadById("projects", projectId, context.workspaceId);
  await logoutAndLoginAgain();
  const projectCoreAfterNewSession = await getCore();
  const projectVisibleAfterNewSession = (projectCoreAfterNewSession.data?.projects ?? [])
    .some((project) => project.id === projectId && project.name === editedName);
  addMatrix({
    entity: "Projekt",
    operation: "Update",
    expected: "Projekt-Aenderung persistiert ueber API",
    actual: `HTTP ${patch.response.status}`,
    dbReadConfirmed: editedProjectRow?.name === editedName ? "ja" : "nein",
    ok: patch.response.ok && editedProjectRow?.name === editedName && projectVisibleAfterNewSession,
    cause: patch.response.ok
      ? projectVisibleAfterNewSession ? "" : "Projekt-Update ist nach frischer Session nicht im Core sichtbar"
      : patch.json?.error ?? patch.text,
  });

  const afterCore = await getCore();
  const afterWorkspace = await request("/api/workspaces");
  const afterWorkspaceCount = afterWorkspace.json?.workspaces?.find((item) => item.id === context.workspaceId)?.activeProjects;
  const coreCount = afterCore.data?.projects?.length ?? 0;
  const dbActiveCountRows = await dbQuery(
    "select count(*)::int as count from projects where workspace_id = $1 and status <> 'Archiviert'",
    [context.workspaceId],
  );
  const dbTotalCountRows = await dbQuery(
    "select count(*)::int as count from projects where workspace_id = $1",
    [context.workspaceId],
  );
  addMatrix({
    entity: "Projekt",
    operation: "Aggregate",
    expected: "Projektzaehler, DB-Aktivzahl und Liste sind konsistent",
    actual: `core=${coreCount}, workspacesBefore=${beforeWorkspaceCount ?? "n/a"}, workspacesAfter=${afterWorkspaceCount ?? "n/a"}, dbAktiv=${dbActiveCountRows[0]?.count}, dbGesamt=${dbTotalCountRows[0]?.count}, coreBefore=${beforeCore.data?.projects?.length ?? "n/a"}`,
    dbReadConfirmed: "ja",
    ok: Number(afterWorkspaceCount) === Number(dbActiveCountRows[0]?.count) && coreCount === Number(dbTotalCountRows[0]?.count),
    cause: Number(afterWorkspaceCount) === coreCount ? "" : "/api/workspaces zaehlt nur status <> 'Archiviert', /api/crm/core listet alle Projekte",
  });
}

async function runDealTests(context) {
  const stamp = context.stamp;
  const core = await getCore();
  const stages = (core.data?.crmPipelineStages ?? [])
    .filter((stage) => stage.projectId === context.projectId)
    .sort((a, b) => a.position - b.position);
  const firstStage = stages[0]?.name ?? "Neu";
  const secondStage = stages[1]?.name ?? firstStage;
  const name = `${CODEX_PREFIX}DEAL_${stamp}`;
  const create = await request("/api/crm/deals", {
    json: {
      deal: {
        contactId: context.contactId,
        expectedCloseDate: "2026-08-15",
        name,
        nextAction: `${CODEX_PREFIX}Deal next action`,
        probability: 42,
        projectId: context.projectId,
        riskLevel: "mittel",
        source: "Manual",
        stage: firstStage,
        value: "510000",
      },
    },
    method: "POST",
  });
  recordApiError("Deal create", create);
  const dealId = create.json?.deal?.id;
  const dealRow = await dbReadById("deals", dealId, context.workspaceId);
  addCreated("Deal", dealId, "deals", name);
  addMatrix({
    entity: "Deal/Pipeline-Phase",
    operation: "Create",
    expected: "Deal persistiert + Projekt/Kontakt verknuepft",
    actual: create.response.ok ? `HTTP ${create.response.status}, id ${dealId}` : `HTTP ${create.response.status}`,
    dbReadConfirmed: dealRow ? "ja" : "nein",
    ok: create.response.ok && dealRow?.project_id === context.projectId && dealRow?.contact_id === context.contactId,
    cause: create.response.ok ? "" : create.json?.error ?? create.text,
  });

  const updatedAction = `${CODEX_PREFIX}Deal update ${stamp}`;
  const update = await request("/api/crm/deals", {
    json: {
      deal: {
        contactId: context.contactId,
        expectedCloseDate: "2026-09-01",
        id: dealId,
        name,
        nextAction: updatedAction,
        probability: 64,
        projectId: context.projectId,
        riskLevel: "hoch",
        source: "Manual",
        stage: secondStage,
        value: "777000",
      },
    },
    method: "PATCH",
  });
  recordApiError("Deal update", update);
  const updatedDealRow = await dbReadById("deals", dealId, context.workspaceId);
  addMatrix({
    entity: "Deal/Pipeline-Phase",
    operation: "Update",
    expected: "Stage/Felder persistieren",
    actual: update.response.ok ? `HTTP ${update.response.status}` : `HTTP ${update.response.status}`,
    dbReadConfirmed: updatedDealRow?.next_action === updatedAction && updatedDealRow?.stage === secondStage ? "ja" : "nein",
    ok: update.response.ok && updatedDealRow?.next_action === updatedAction && updatedDealRow?.stage === secondStage,
    cause: update.response.ok ? "" : update.json?.error ?? update.text,
  });

  context.dealId = dealId;
}

async function runTaskTests(context) {
  const stamp = context.stamp;
  const title = `${CODEX_PREFIX}TASK_${stamp}`;
  const create = await request("/api/crm/tasks", {
    json: {
      task: {
        contactId: context.contactId,
        due: "2026-07-10T10:00:00.000Z",
        leadId: context.leadId,
        priority: "Hoch",
        projectId: context.projectId,
        status: "open",
        title,
      },
    },
    method: "POST",
  });
  recordApiError("Task create", create);
  const taskId = create.json?.task?.id;
  const taskRow = await dbReadById("tasks", taskId, context.workspaceId);
  addCreated("Aufgabe", taskId, "tasks", title);
  addMatrix({
    entity: "Aufgabe",
    operation: "Create",
    expected: "Aufgabe persistiert + Lead/Projekt verknuepft",
    actual: create.response.ok ? `HTTP ${create.response.status}, id ${taskId}` : `HTTP ${create.response.status}`,
    dbReadConfirmed: taskRow ? "ja" : "nein",
    ok: create.response.ok && taskRow?.lead_id === context.leadId && taskRow?.project_id === context.projectId,
    cause: create.response.ok ? "" : create.json?.error ?? create.text,
  });

  const editedTitle = `${title}_DONE`;
  const update = await request("/api/crm/tasks", {
    json: {
      task: {
        contactId: context.contactId,
        due: "2026-07-11T10:00:00.000Z",
        id: taskId,
        leadId: context.leadId,
        priority: "Normal",
        projectId: context.projectId,
        status: "done",
        title: editedTitle,
      },
    },
    method: "PATCH",
  });
  recordApiError("Task update", update);
  const updatedTaskRow = await dbReadById("tasks", taskId, context.workspaceId);
  addMatrix({
    entity: "Aufgabe",
    operation: "Update",
    expected: "Aufgabenstatus persistiert",
    actual: update.response.ok ? `HTTP ${update.response.status}` : `HTTP ${update.response.status}`,
    dbReadConfirmed: updatedTaskRow?.title === editedTitle && updatedTaskRow?.status === "done" ? "ja" : "nein",
    ok: update.response.ok && updatedTaskRow?.title === editedTitle && updatedTaskRow?.status === "done",
    cause: update.response.ok ? "" : update.json?.error ?? update.text,
  });
}

async function runNoteTests(context) {
  const stamp = context.stamp;
  const title = `${CODEX_PREFIX}NOTE_${stamp}`;
  const detail = `${CODEX_PREFIX}Note detail ${stamp}`;
  const create = await request("/api/crm/notes", {
    json: {
      note: {
        contactId: context.contactId,
        detail,
        leadId: context.leadId,
        projectId: context.projectId,
        title,
      },
    },
    method: "POST",
  });
  recordApiError("Note create", create);
  const noteId = create.json?.note?.id;
  const noteRow = noteId
    ? (await dbQuery(
        "select * from contact_timeline_items where id = $1 and workspace_id = $2 and channel = 'Notiz' limit 1",
        [noteId, context.workspaceId],
      ))[0]
    : null;
  addCreated("Notiz", noteId, "contact_timeline_items", title);

  const editedDetail = `${detail} EDITED`;
  const update = await request("/api/crm/notes", {
    json: {
      note: {
        contactId: context.contactId,
        detail: editedDetail,
        id: noteId,
        leadId: context.leadId,
        projectId: context.projectId,
        title: `${title}_EDITED`,
      },
    },
    method: "PATCH",
  });
  recordApiError("Note update", update);
  const updatedNoteRow = noteId
    ? (await dbQuery(
        "select * from contact_timeline_items where id = $1 and workspace_id = $2 and channel = 'Notiz' limit 1",
        [noteId, context.workspaceId],
      ))[0]
    : null;
  await logoutAndLoginAgain();
  const noteList = await request(`/api/crm/notes?leadId=${encodeURIComponent(context.leadId)}`);
  const visibleAfterNewSession = (noteList.json?.notes ?? []).some((note) => note.id === noteId && note.detail === editedDetail);

  addMatrix({
    entity: "Notiz",
    operation: "Create/Update",
    expected: "Notiz persistiert + Lead/Kontakt verknuepft",
    actual: create.response.ok && update.response.ok
      ? `HTTP ${create.response.status}/${update.response.status}, id ${noteId}`
      : `HTTP ${create.response.status}/${update.response.status}`,
    dbReadConfirmed: updatedNoteRow?.detail === editedDetail ? "ja" : "nein",
    ok:
      create.response.ok &&
      update.response.ok &&
      noteRow?.contact_id === context.contactId &&
      updatedNoteRow?.detail === editedDetail &&
      updatedNoteRow?.metadata?.leadId === context.leadId &&
      visibleAfterNewSession,
    cause: create.response.ok && update.response.ok
      ? visibleAfterNewSession ? "" : "Notiz ist nach frischer Session nicht ueber den API-Lesepfad sichtbar"
      : create.json?.error ?? update.json?.error ?? create.text ?? update.text,
  });
}

async function runCalendarEventTests(context) {
  const stamp = context.stamp;
  const title = `${CODEX_PREFIX}EVENT_${stamp}`;
  const startsAt = "2026-08-01T09:00:00.000Z";
  const endsAt = "2026-08-01T09:30:00.000Z";
  const create = await request("/api/crm/calendar-events", {
    json: {
      event: {
        contactId: context.contactId,
        endsAt,
        leadId: context.leadId,
        location: "Telefon",
        outcomeGoal: `${CODEX_PREFIX}Internal appointment goal`,
        preparation: [`${CODEX_PREFIX}Prepare file`],
        projectId: context.projectId,
        startsAt,
        status: "geplant",
        title,
      },
    },
    method: "POST",
  });
  recordApiError("Calendar event create", create);
  const eventId = create.json?.event?.id;
  const eventRow = eventId
    ? (await dbQuery(
        "select * from calendar_events where id = $1 and workspace_id = $2 limit 1",
        [eventId, context.workspaceId],
      ))[0]
    : null;
  addCreated("Termin", eventId, "calendar_events", title);

  const editedTitle = `${title}_EDITED`;
  const update = await request("/api/crm/calendar-events", {
    json: {
      event: {
        contactId: context.contactId,
        endsAt: "2026-08-01T10:00:00.000Z",
        id: eventId,
        leadId: context.leadId,
        location: "Telefon",
        outcomeGoal: `${CODEX_PREFIX}Internal appointment goal edited`,
        preparation: [`${CODEX_PREFIX}Updated preparation`],
        projectId: context.projectId,
        startsAt: "2026-08-01T09:15:00.000Z",
        status: "vorbereiten",
        title: editedTitle,
      },
    },
    method: "PATCH",
  });
  recordApiError("Calendar event update", update);
  const updatedEventRow = eventId
    ? (await dbQuery(
        "select * from calendar_events where id = $1 and workspace_id = $2 limit 1",
        [eventId, context.workspaceId],
      ))[0]
    : null;
  await logoutAndLoginAgain();
  const eventList = await request(`/api/crm/calendar-events?leadId=${encodeURIComponent(context.leadId)}`);
  const visibleAfterNewSession = (eventList.json?.events ?? []).some((event) => event.id === eventId && event.title === editedTitle);
  const noExternalCommunication =
    updatedEventRow?.teams_join_url === null &&
    updatedEventRow?.metadata?.externalCommunication === false &&
    updatedEventRow?.metadata?.calendarProvider === "manual";

  addMatrix({
    entity: "Termin",
    operation: "Create/Update",
    expected: "interner Termin persistiert ohne externe Kommunikation",
    actual: create.response.ok && update.response.ok
      ? `HTTP ${create.response.status}/${update.response.status}, id ${eventId}`
      : `HTTP ${create.response.status}/${update.response.status}`,
    dbReadConfirmed: updatedEventRow?.title === editedTitle ? "ja" : "nein",
    ok:
      create.response.ok &&
      update.response.ok &&
      eventRow?.lead_id === context.leadId &&
      updatedEventRow?.title === editedTitle &&
      noExternalCommunication &&
      visibleAfterNewSession,
    cause: create.response.ok && update.response.ok
      ? noExternalCommunication
        ? visibleAfterNewSession ? "" : "Termin ist nach frischer Session nicht ueber den internen API-Lesepfad sichtbar"
        : "Terminpfad hat externe Kommunikationsfelder gesetzt"
      : create.json?.error ?? update.json?.error ?? create.text ?? update.text,
  });
}

async function runKnownGapTests() {
}

async function runGrowthWorkspaceSeedChecks() {
  try {
    const workspaceRows = await dbQuery(
      "select id, name, slug from workspaces where id = $1 limit 1",
      [novalureGrowthWorkspaceId],
    );
    const workspace = workspaceRows[0];
    addMatrix({
      entity: "Novalure Growth",
      operation: "Workspace seed",
      expected: "Workspace existiert mit stabilem Slug",
      actual: workspace ? `${workspace.name} / ${workspace.slug ?? ""}` : "nicht gefunden",
      dbReadConfirmed: workspace?.id === novalureGrowthWorkspaceId ? "ja" : "nein",
      ok: workspace?.name === "Novalure Growth" && workspace?.slug === "novalure-growth",
      cause: workspace ? "" : "Novalure Growth Workspace fehlt",
    });

    const stageRows = await dbQuery(
      `
        select s.name
        from crm_pipeline_stages s
        join crm_pipelines p on p.id = s.pipeline_id
        where p.workspace_id = $1
          and p.key = 'novalure_growth_pipeline'
        order by s.position asc
      `,
      [novalureGrowthWorkspaceId],
    );
    const stages = stageRows.map((row) => row.name);
    addMatrix({
      entity: "Novalure Growth",
      operation: "Pipeline seed",
      expected: novalureGrowthStages.join(", "),
      actual: stages.join(", "),
      dbReadConfirmed: stages.length ? "ja" : "nein",
      ok: sameArray(stages, novalureGrowthStages),
      cause: sameArray(stages, novalureGrowthStages) ? "" : "Pipeline-Stufen weichen von der Growth-Vorgabe ab",
    });

    const sourceRows = await dbQuery(
      `
        select source_value
        from workspace_lead_sources
        where workspace_id = $1
        order by position asc
      `,
      [novalureGrowthWorkspaceId],
    );
    const sources = sourceRows.map((row) => row.source_value);
    addMatrix({
      entity: "Novalure Growth",
      operation: "Lead sources seed",
      expected: novalureGrowthSources.join(", "),
      actual: sources.join(", "),
      dbReadConfirmed: sources.length ? "ja" : "nein",
      ok: sameArray(sources, novalureGrowthSources),
      cause: sameArray(sources, novalureGrowthSources) ? "" : "Leadquellen weichen von der Growth-Vorgabe ab",
    });

    const botRows = await dbQuery(
      "select name, status from bots where workspace_id = $1 order by name asc",
      [novalureGrowthWorkspaceId],
    );
    addMatrix({
      entity: "Novalure Growth",
      operation: "Bot seed",
      expected: "5 Bots, Status inactive",
      actual: `${botRows.length} Bot(s), Status ${[...new Set(botRows.map((row) => row.status))].join(", ")}`,
      dbReadConfirmed: botRows.length ? "ja" : "nein",
      ok: botRows.length === 5 && botRows.every((row) => row.status === "inactive"),
      cause: botRows.length === 5 && botRows.every((row) => row.status === "inactive")
        ? ""
        : "Growth-Bots fehlen oder sind nicht inactive",
    });

    const moduleRows = await dbQuery(
      "select module_key, enabled from workspace_module_settings where workspace_id = $1",
      [novalureGrowthWorkspaceId],
    );
    const modules = new Map(moduleRows.map((row) => [row.module_key, row.enabled]));
    const propertyModules = ["properties", "objectsMandates", "units", "reservations", "projectOverview"];
    const propertyModulesOk = propertyModules.every((key) => modules.get(key) === true);
    addMatrix({
      entity: "Novalure Growth",
      operation: "enabledModules seed",
      expected: "Immobilienmodule true, CRM-Module true",
      actual: propertyModules.map((key) => `${key}=${modules.get(key)}`).join(", "),
      dbReadConfirmed: moduleRows.length ? "ja" : "nein",
      ok: propertyModulesOk,
      cause: propertyModulesOk ? "" : "Mindestens ein Immobilienmodul ist nicht aktiv oder fehlt",
    });
  } catch (error) {
    addMatrix({
      entity: "Novalure Growth",
      operation: "Seed verification",
      expected: "Growth Workspace Seed ist per DB lesbar",
      actual: "Fehler",
      dbReadConfirmed: "nein",
      ok: false,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function printSchemaCheck() {
  if (!databaseUrl) {
    throw new Error("No database URL found. DATABASE_URL or POSTGRES_URL is required for DB verification.");
  }

  const tables = ["leads", "projects", "contacts", "deals", "tasks", "consent_records"];
  const role = await dbQuery("select current_user as role, current_database() as database");
  const rls = await dbQuery(
    `
      select
        c.relname as table,
        c.relrowsecurity as rls,
        c.relforcerowsecurity as force_rls
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = any($1::text[])
      order by c.relname
    `,
    [tables],
  );
  const privileges = await dbQuery(
    `
      select table_name, privilege_type
      from information_schema.role_table_grants
      where grantee = current_user
        and table_schema = 'public'
        and table_name = any($1::text[])
      order by table_name, privilege_type
    `,
    [tables],
  );
  const columns = await dbQuery(
    `
      select table_name, column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = any($1::text[])
        and column_name = any($2::text[])
      order by table_name, column_name
    `,
    [
      tables,
      ["last_contact_at", "next_contact_at", "created_at", "updated_at", "workspace_id", "project_id", "status"],
    ],
  );

  console.log(JSON.stringify({ columns, privileges, rls, role }, null, 2));
}

async function printCodexTestRecords() {
  if (!databaseUrl) {
    throw new Error("No database URL found. DATABASE_URL or POSTGRES_URL is required for DB verification.");
  }

  const rows = [];
  const queries = [
    {
      label: "Kontakt",
      location: "contacts",
      query:
        "select id, name as label from contacts where name like $1 or intent like $1 or email like 'codextest-%' order by id",
      params: [`${CODEX_PREFIX}%`],
    },
    {
      label: "Consent",
      location: "consent_records",
      query: "select id, status as label from consent_records where status like $1 order by id",
      params: [`${CODEX_PREFIX}%`],
    },
    {
      label: "Lead",
      location: "leads",
      query:
        "select id, intent as label from leads where intent like $1 or next_action like $1 or metadata->>'legacyId' like 'lead_local_codextest_%' order by id",
      params: [`${CODEX_PREFIX}%`],
    },
    {
      label: "Buyer Search Profile",
      location: "buyer_search_profiles",
      query: "select id, title as label from buyer_search_profiles where title like $1 order by id",
      params: [`${CODEX_PREFIX}%`],
    },
    {
      label: "Broker Mandate",
      location: "broker_mandates",
      query: "select id, title as label from broker_mandates where title like $1 order by id",
      params: [`${CODEX_PREFIX}%`],
    },
    {
      label: "Projekt",
      location: "projects",
      query: "select id, name as label from projects where name like $1 order by id",
      params: [`${CODEX_PREFIX}%`],
    },
    {
      label: "Deal",
      location: "deals",
      query: "select id, name as label from deals where name like $1 or next_action like $1 order by id",
      params: [`${CODEX_PREFIX}%`],
    },
    {
      label: "Aufgabe",
      location: "tasks",
      query: "select id, title as label from tasks where title like $1 order by id",
      params: [`${CODEX_PREFIX}%`],
    },
    {
      label: "Notiz",
      location: "contact_timeline_items",
      query: "select id, title as label from contact_timeline_items where title like $1 or detail like $1 order by id",
      params: [`${CODEX_PREFIX}%`],
    },
    {
      label: "Termin",
      location: "calendar_events",
      query: "select id, title as label from calendar_events where title like $1 or outcome_goal like $1 order by id",
      params: [`${CODEX_PREFIX}%`],
    },
    {
      label: "Audit Log",
      location: "audit_logs",
      query: "select id, action as label from audit_logs where after::text like $1 order by id",
      params: [`%${CODEX_PREFIX}%`],
    },
    {
      label: "Analytics Event",
      location: "analytics_events",
      query: "select id, event_type as label from analytics_events where metadata::text like $1 order by id",
      params: [`%${CODEX_PREFIX}%`],
    },
  ];

  for (const item of queries) {
    const result = await dbQuery(item.query, item.params);
    for (const row of result) {
      rows.push({ type: item.label, id: row.id, location: item.location, label: row.label });
    }
  }

  console.log(JSON.stringify(rows, null, 2));
}

function printMarkdownTable(rows) {
  const headers = ["Entität", "Operation", "Erwartet", "Tatsächlich", "DB-Read bestätigt", "Status", "Fehlermeldung/Ursache"];
  console.log(headers.join(" | "));
  console.log(headers.map(() => "---").join(" | "));
  for (const row of rows) {
    console.log([
      row.entity,
      row.operation,
      row.expected,
      row.actual,
      row.dbReadConfirmed,
      row.status,
      row.cause,
    ].map((value) => String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "/")).join(" | "));
  }
}

async function main() {
  if (!databaseUrl) {
    throw new Error("No database URL found. DATABASE_URL or POSTGRES_URL is required for DB verification.");
  }

  if (process.argv.includes("--schema-check")) {
    await printSchemaCheck();
    return;
  }

  if (process.argv.includes("--list-codextest")) {
    await printCodexTestRecords();
    return;
  }

  await login();
  const session = await getSession();
  const core = await getCore();
  const project = core.data?.projects?.find((item) => item.status !== "Archiviert") ?? core.data?.projects?.[0];
  if (!project?.id) throw new Error("No project found for persistence diagnostics.");

  const context = {
    projectId: project.id,
    stamp: String(Date.now()),
    userId: session.user?.id,
    workspaceId: session.workspace?.id,
  };

  console.log(`QA persistence diagnostics against ${baseUrl}`);
  console.log(`Workspace: ${context.workspaceId}`);
  console.log(`Baseline project: ${context.projectId}`);

  await runContactTests(context);
  await runLeadTests(context);
  runLeadUiStateGuardTest();
  await runProjectTests(context);
  await runDealTests(context);
  await runTaskTests(context);
  await runNoteTests(context);
  await runCalendarEventTests(context);
  await runKnownGapTests();
  await runGrowthWorkspaceSeedChecks();

  console.log("\nTEST_MATRIX");
  printMarkdownTable(matrix);

  console.log("\nTECHNICAL_ERRORS");
  console.log(JSON.stringify(technicalErrors, null, 2));

  console.log("\nCREATED_CODEXTEST_RECORDS");
  console.log(JSON.stringify(createdRecords, null, 2));

  const failing = matrix.filter((row) => row.status === "rot");
  if (failing.length) {
    console.error(`\nPersistence diagnostics finished with ${failing.length} red row(s).`);
    process.exitCode = 1;
  } else {
    console.log("\nPersistence diagnostics finished green.");
  }
}

main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
