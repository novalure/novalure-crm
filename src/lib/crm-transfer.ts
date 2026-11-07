/** Interchange rules shared by the preview and the server. No consent is imported. */
export const CRM_TRANSFER_MAX_BYTES = 2 * 1024 * 1024;
export const CRM_TRANSFER_MAX_ROWS = 1000;
export const crmTransferFields = ["name", "email", "phone", "role", "source", "intent", "externalId"] as const;
export type CrmTransferField = (typeof crmTransferFields)[number];
export type CrmTransferMapping = Partial<Record<CrmTransferField, string>>;
export type CrmTransferContact = { name: string; email: string; phone: string; role: "Käufer" | "Verkäufer" | "Investor" | "Bauträger" | "Makler"; source: string; intent: string; externalId: string };
export type CrmTransferPreviewRow = { line: number; contact: CrmTransferContact; status: "ready" | "duplicate" | "invalid"; issues: string[] };
export type CrmTransferPreview = { headers: string[]; mapping: CrmTransferMapping; rows: CrmTransferPreviewRow[]; ready: number; duplicates: number; invalid: number };
export class CrmTransferError extends Error {}

export function parseCrmCsv(text: string): { headers: string[]; rows: string[][] } {
  if (new TextEncoder().encode(text).byteLength > CRM_TRANSFER_MAX_BYTES) throw new CrmTransferError("Die Datei ist größer als 2 MB.");
  const source = text.replace(/^\uFEFF/, "");
  if (!source.trim() || source.includes("\0")) throw new CrmTransferError("Die CSV-Datei ist leer oder enthält ungültige Zeichen.");
  let inQuotes = false;
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (character === '"') {
      if (inQuotes && source[i + 1] === '"') { i++; continue; }
      inQuotes = !inQuotes;
    }
    if (!inQuotes && /[\r\n]/.test(character)) break;
    if (!inQuotes && counts.has(character)) counts.set(character, counts.get(character)! + 1);
  }
  const delimiter = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const records: string[][] = [];
  let row: string[] = [], cell = "", state: "start" | "plain" | "quoted" | "closed" = "start";
  function finishCell() { row.push(cell); cell = ""; state = "start"; }
  function finishRow() {
    finishCell();
    if (row.some(value => value.trim() !== "")) records.push(row);
    row = [];
    if (records.length > CRM_TRANSFER_MAX_ROWS + 1) throw new CrmTransferError("Pro Import sind höchstens 1.000 Datensätze möglich.");
  }
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (state === "quoted") {
      if (character === '"') {
        if (source[i + 1] === '"') { cell += '"'; i++; } else state = "closed";
      } else cell += character;
      continue;
    }
    if (character === delimiter) { finishCell(); continue; }
    if (character === "\r" || character === "\n") {
      finishRow();
      if (character === "\r" && source[i + 1] === "\n") i++;
      continue;
    }
    if (state === "closed") throw new CrmTransferError("Nach einem schließenden Anführungszeichen muss ein Trennzeichen folgen.");
    if (character === '"') {
      if (state !== "start") throw new CrmTransferError("Anführungszeichen innerhalb eines Felds müssen verdoppelt werden.");
      state = "quoted";
    } else { state = "plain"; cell += character; }
  }
  if (state === "quoted") throw new CrmTransferError("Ein CSV-Feld hat kein schließendes Anführungszeichen.");
  if (cell || row.length || state === "closed") finishRow();
  const headers = (records.shift() ?? []).map(value => value.trim());
  if (!headers.length || headers.length > 80 || headers.some(value => !value || value.length > 160)) throw new CrmTransferError("Die erste Zeile benötigt eindeutige Spaltennamen (höchstens 80).");
  if (new Set(headers.map(value => value.toLowerCase())).size !== headers.length) throw new CrmTransferError("Die Spaltennamen sind nicht eindeutig.");
  if (!records.length) throw new CrmTransferError("Die Datei enthält keine Datensätze.");
  if (records.some(record => record.length !== headers.length)) throw new CrmTransferError("Die Anzahl der Felder stimmt nicht in jeder Zeile mit der Kopfzeile überein.");
  return { headers, rows: records };
}

const aliases: Record<CrmTransferField, readonly string[]> = {
  name: ["name", "fullname", "contactname", "kontaktname", "vollername"],
  email: ["email", "emailadresse", "mail"], phone: ["phone", "telefon", "telephone", "mobil", "telefonnummer"],
  role: ["role", "rolle", "type", "typ"], source: ["source", "quelle", "herkunft"],
  intent: ["intent", "interesse", "notiz", "notes", "anliegen"], externalId: ["externalid", "originalid", "id", "sourceid"],
};
const normalHeader = (value: string) => value.toLowerCase().replace(/[\s_\-.]/g, "");
export function suggestCrmTransferMapping(headers: string[]): CrmTransferMapping {
  return Object.fromEntries(crmTransferFields.flatMap(field => {
    const header = headers.find(value => aliases[field].includes(normalHeader(value)));
    return header ? [[field, header]] : [];
  }));
}

export function normalizeTransferEmail(value: string) { return value.trim().toLowerCase(); }
export function normalizeTransferPhone(value: string) {
  const digits = value.replace(/[^\d+]/g, "");
  return digits.startsWith("00") ? "+" + digits.slice(2) : digits;
}
function restoreSpreadsheetText(value: string) { return value.replace(/^'(?=[\s]*[=+\-@])/, "").trim(); }

export function previewCrmTransfer(text: string, requestedMapping?: CrmTransferMapping, existing: readonly { email?: string | null; phone?: string | null }[] = []): CrmTransferPreview {
  const parsed = parseCrmCsv(text);
  const mapping = requestedMapping ?? suggestCrmTransferMapping(parsed.headers);
  if (Object.keys(mapping).some(key => !crmTransferFields.includes(key as CrmTransferField)) || Object.values(mapping).some(value => value && !parsed.headers.includes(value))) throw new CrmTransferError("Die Feldzuordnung enthält eine unbekannte Spalte.");
  const assigned = Object.values(mapping).filter(Boolean);
  if (new Set(assigned).size !== assigned.length) throw new CrmTransferError("Eine CSV-Spalte kann nur einem Kontaktfeld zugeordnet werden.");
  if (!mapping.name || (!mapping.email && !mapping.phone)) throw new CrmTransferError("Name sowie E-Mail oder Telefonnummer müssen zugeordnet sein.");
  const emails = new Set(existing.map(value => normalizeTransferEmail(value.email ?? "")).filter(Boolean));
  const phones = new Set(existing.map(value => normalizeTransferPhone(value.phone ?? "")).filter(Boolean));
  const roles = ["Käufer", "Verkäufer", "Investor", "Bauträger", "Makler"];
  const rows = parsed.rows.map((row, index): CrmTransferPreviewRow => {
    const read = (field: CrmTransferField) => { const column = mapping[field]; return column ? restoreSpreadsheetText(row[parsed.headers.indexOf(column)]) : ""; };
    const role = read("role") || "Käufer";
    const contact: CrmTransferContact = { name: read("name"), email: normalizeTransferEmail(read("email")), phone: read("phone"), role: role as CrmTransferContact["role"], source: read("source") || "Manual", intent: read("intent"), externalId: read("externalId") };
    const issues: string[] = [];
    if (!contact.name || contact.name.length > 180) issues.push("Name fehlt oder ist zu lang (höchstens 180 Zeichen).");
    if (!contact.email && !contact.phone) issues.push("E-Mail oder Telefonnummer fehlt.");
    if (contact.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email) || contact.email.length > 254)) issues.push("E-Mail ist ungültig.");
    if (contact.phone && (!/^[+\d()\s./-]+$/.test(contact.phone) || normalizeTransferPhone(contact.phone).replace(/\D/g, "").length < 5 || contact.phone.length > 80)) issues.push("Telefonnummer ist ungültig.");
    if (!roles.includes(role)) issues.push("Rolle muss Käufer, Verkäufer, Investor, Bauträger oder Makler sein.");
    if (contact.intent.length > 1200 || contact.source.length > 100 || contact.externalId.length > 300) issues.push("Ein Textfeld ist zu lang (Anliegen höchstens 1.200 Zeichen).");
    if (Object.values(contact).some(value => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) issues.push("Ein Feld enthält ungültige Steuerzeichen.");
    const phone = normalizeTransferPhone(contact.phone);
    const duplicate = Boolean((contact.email && emails.has(contact.email)) || (phone && phones.has(phone)));
    if (issues.length === 0) { if (contact.email) emails.add(contact.email); if (phone) phones.add(phone); }
    return { line: index + 2, contact, status: issues.length ? "invalid" : duplicate ? "duplicate" : "ready", issues };
  });
  return { headers: parsed.headers, mapping, rows, ready: rows.filter(row => row.status === "ready").length, duplicates: rows.filter(row => row.status === "duplicate").length, invalid: rows.filter(row => row.status === "invalid").length };
}

/** Quoting alone does not stop spreadsheet formula evaluation. */
export function crmCsvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function buildCrmCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]) {
  return "\uFEFF" + [headers, ...rows].map(row => row.map(crmCsvCell).join(",")).join("\r\n") + "\r\n";
}

function vcardText(value: string) { return value.replaceAll("\\", "\\\\").replace(/\r\n|\r|\n/g, "\\n").replaceAll(";", "\\;").replaceAll(",", "\\,").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""); }
function foldVcardLine(value: string) {
  const lines: string[] = []; let current = "", bytes = 0;
  for (const character of value) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > 75) { lines.push(current); current = " "; bytes = 1; }
    current += character; bytes += size;
  }
  lines.push(current); return lines.join("\r\n");
}
export function buildCrmVcards(contacts: readonly { id: string; name: string; email?: string | null; phone?: string | null }[]) {
  return contacts.map(contact => ["BEGIN:VCARD", "VERSION:4.0", "FN:" + vcardText(contact.name), "UID:urn:uuid:" + vcardText(contact.id), ...(contact.email ? ["EMAIL:" + vcardText(contact.email)] : []), ...(contact.phone ? ["TEL;VALUE=text:" + vcardText(contact.phone)] : []), "END:VCARD"].map(foldVcardLine).join("\r\n")).join("\r\n") + "\r\n";
}
