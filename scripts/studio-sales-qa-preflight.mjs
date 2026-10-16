#!/usr/bin/env node
// Static, read-only inventory. Never prints credentials, identities or recipient addresses.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const defaultPath = fileURLToPath(new URL("../config/studio-sales-qa.example.json", import.meta.url));
const path = process.argv[2] ?? defaultPath;
const missing = [];
const required = (name, value) => {
  if (typeof value !== "string" || !value.trim()) missing.push(name);
};
let candidate;
try { candidate = JSON.parse(await readFile(path, "utf8")); }
catch { console.error("QA_BLOCKED: candidate file is missing or invalid JSON."); process.exitCode = 1; }

if (candidate) {
  required("approvalRecordId", candidate.approvalRecordId);
  for (const name of ["studioPreviewOrigin", "crmPreviewOrigin", "studioProjectId", "crmProjectId", "qaRunPrefix"])
    required(name, candidate[name]);
  for (const name of ["qaProjectId", "qaBranchId", "qaDatabaseName", "qaRuntimeRole",
    "qaPoolerHost", "productionHostForComparison"])
    required(`database.${name}`, candidate.database?.[name]);
  for (const name of ["organizerId", "calendarId", "timeZone"])
    required(`calendarPolicy.${name}`, candidate.calendarPolicy?.[name]);
  if (!candidate.approvalRecordId || candidate.calendarPolicy?.approvalId !== candidate.approvalRecordId)
    missing.push("calendarPolicy.approvalId (must match approvalRecordId)");
  for (const name of ["durationMinutes", "intervalMinutes", "minNoticeMinutes",
    "bufferMinutes", "horizonDays"]) {
    const minimum = name === "durationMinutes" ? 10 : name === "intervalMinutes" ? 5 :
      name === "horizonDays" ? 1 : 0;
    const maximum = name === "horizonDays" ? 60 :
      name === "durationMinutes" || name === "intervalMinutes" ? 180 : Infinity;
    if (!Number.isInteger(candidate.calendarPolicy?.[name]) ||
        candidate.calendarPolicy[name] < minimum || candidate.calendarPolicy[name] > maximum)
      missing.push(`calendarPolicy.${name}`);
  }
  const hours = candidate.calendarPolicy?.hours;
  if (!hours || typeof hours !== "object" || Array.isArray(hours) ||
      Object.values(hours).every((windows) => !Array.isArray(windows) || !windows.length) ||
      Object.entries(hours).some(([day, windows]) => !/^[0-6]$/.test(day) || !Array.isArray(windows) ||
        windows.some((window) => !Number.isInteger(window?.start) || !Number.isInteger(window?.end) ||
          window.start < 0 || window.end > 1440 || window.end <= window.start)))
    missing.push("calendarPolicy.hours");
  if (!Array.isArray(candidate.approvedTestRecipients) || !candidate.approvedTestRecipients.length ||
      candidate.approvedTestRecipients.some((email) => typeof email !== "string" ||
        email !== email.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    missing.push("approvedTestRecipients");
  for (const name of ["isolatedTargetApproval", "calendarReadApproval", "eventCreateApproval",
    "teamsMeetingApproval", "testRecipientApproval", "sharedSigningSecretBinding",
    "migration097AndRollbackApproval"])
    required(`evidence.${name}`, candidate.evidence?.[name]);
  if (candidate.studioWorkspaceId !== "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101" ||
      candidate.studioActorId !== "6122a6da-e7f4-47fa-bc55-e296bb01af62")
    missing.push("studioWorkspaceId/studioActorId (server-fixed Studio scope)");
  const validOrigin = (value, forbidden) => {
    try { const url = new URL(value); return url.protocol === "https:" && url.origin === value &&
      !forbidden.includes(value); } catch { return false; }
  };
  if (candidate.studioPreviewOrigin && !validOrigin(candidate.studioPreviewOrigin,
    ["https://novalurestudio.ie", "https://www.novalurestudio.ie"])) missing.push("studioPreviewOrigin (isolated HTTPS Preview)");
  if (candidate.crmPreviewOrigin && !validOrigin(candidate.crmPreviewOrigin,
    ["https://www.novalure-crm.app"])) missing.push("crmPreviewOrigin (isolated HTTPS Preview)");
  if (candidate.database?.qaPoolerHost && candidate.database.qaPoolerHost ===
      candidate.database.productionHostForComparison) missing.push("database host separation");
  if (candidate.qaRunPrefix && !/^GOLIVETEST_[A-Za-z0-9_-]{6,80}$/.test(candidate.qaRunPrefix))
    missing.push("qaRunPrefix (QA guard format)");
  try { if (candidate.calendarPolicy?.timeZone) new Intl.DateTimeFormat("en", {
    timeZone: candidate.calendarPolicy.timeZone }); }
  catch { missing.push("calendarPolicy.timeZone (IANA)"); }
  const unique = [...new Set(missing)];
  if (unique.length) {
    console.error("QA_BLOCKED: missing or invalid non-secret fields:");
    for (const name of unique) console.error(`- ${name}`);
    process.exitCode = 1;
  } else {
    console.log("CONFIG_CANDIDATE_COMPLETE; external approvals, deployed bindings and real capabilities remain unverified.");
  }
}
