export const contentLanguages = ["de", "en"] as const;
export const documentVisibilities = ["internal", "customer", "public"] as const;
export const approvalStatuses = ["draft", "needs_review", "approved", "rejected"] as const;
export const templateChannels = ["email", "sms", "letter", "expose", "note"] as const;
export const contentLinkTargetTypes = [
  "contact",
  "organization",
  "lead",
  "project",
  "property",
  "unit",
  "deal",
  "closing",
  "task",
] as const;

export type ContentLanguage = (typeof contentLanguages)[number];
export type DocumentVisibility = (typeof documentVisibilities)[number];
export type ApprovalStatus = (typeof approvalStatuses)[number];
export type TemplateChannel = (typeof templateChannels)[number];
export type ContentLinkTargetType = (typeof contentLinkTargetTypes)[number];

export type DocumentLinkInput = Readonly<{
  targetType: ContentLinkTargetType;
  targetId: string;
  projectId?: string | null;
}>;

export type CreateDocumentInput = Readonly<{
  title: string;
  category?: string;
  projectId?: string | null;
  mediaAssetId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256?: string | null;
  changeNote?: string;
  visibility?: DocumentVisibility;
  tags?: readonly string[];
  links?: readonly DocumentLinkInput[];
}>;

export type AddDocumentVersionInput = Readonly<{
  mediaAssetId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256?: string | null;
  changeNote?: string;
  expectedUpdatedAt: string;
}>;

export type CreateTemplateInput = Readonly<{
  name: string;
  channel: TemplateChannel;
  purpose?: string;
  projectId?: string | null;
  defaultLanguage?: ContentLanguage;
  language?: ContentLanguage;
  subject?: string;
  body: string;
  allowedVariables?: readonly string[];
  variableFallbacks?: Readonly<Record<string, string>>;
  changeNote?: string;
}>;

export type AddTemplateVersionInput = Readonly<{
  language: ContentLanguage;
  subject?: string;
  body: string;
  allowedVariables?: readonly string[];
  variableFallbacks?: Readonly<Record<string, string>>;
  changeNote?: string;
  expectedUpdatedAt: string;
}>;

export type ContentPage = Readonly<{
  page: number;
  pageSize: number;
  offset: number;
}>;

export class ContentValidationError extends Error {
  readonly code = "VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ContentValidationError";
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const variableNamePattern = /^[a-z][a-z0-9_]{0,63}$/;
const languagePattern = /^[a-z]{2}(?:-[A-Z]{2})?$/;
const variableTokenPattern = /{{\s*([a-z][a-z0-9_]{0,63})\s*}}/g;
const unsafeTemplateSyntaxPattern = /{{{\s*|{{\s*[#/>!&^]/;
const unsafeHtmlTemplatePattern = /<\s*(?:script|iframe|object|embed|form|meta|link)\b|\bon[a-z]+\s*=|javascript\s*:/i;

function requireRecord(value: unknown, label = "Payload") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContentValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function cleanRequiredString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string") throw new ContentValidationError(`${label} is required`);
  const result = value.trim();
  if (!result) throw new ContentValidationError(`${label} is required`);
  if (result.length > maxLength) {
    throw new ContentValidationError(`${label} must not exceed ${maxLength} characters`);
  }
  return result;
}

function cleanOptionalString(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ContentValidationError(`${label} must be text`);
  const result = value.trim();
  if (result.length > maxLength) {
    throw new ContentValidationError(`${label} must not exceed ${maxLength} characters`);
  }
  return result;
}

export function parseExpectedUpdatedAt(value: unknown) {
  const parsed = cleanRequiredString(value, "expectedUpdatedAt", 64);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new ContentValidationError("expectedUpdatedAt must be an ISO date");
  }
  return new Date(parsed).toISOString();
}

export function assertUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ContentValidationError(`${label} must be a valid UUID`);
  }
  return value;
}

export function parseOptionalUuid(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  return assertUuid(value, label);
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  fallback: Values[number],
  label: string,
) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !values.includes(value)) {
    throw new ContentValidationError(`${label} is invalid`);
  }
  return value as Values[number];
}

export function normalizeTags(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ContentValidationError("tags must be an array");
  const unique = new Set<string>();
  for (const entry of value) {
    const tag = cleanRequiredString(entry, "tag", 48).toLocaleLowerCase("de");
    unique.add(tag);
    if (unique.size > 25) throw new ContentValidationError("No more than 25 tags are allowed");
  }
  return [...unique];
}

function normalizeVariables(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ContentValidationError("allowedVariables must be an array");
  }
  const result = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !variableNamePattern.test(entry)) {
      throw new ContentValidationError("Template variable names must use lower-case letters, digits and underscores");
    }
    result.add(entry);
    if (result.size > 80) throw new ContentValidationError("No more than 80 template variables are allowed");
  }
  return [...result].sort();
}

function normalizeFallbacks(value: unknown, allowedVariables: readonly string[]) {
  if (value === undefined || value === null) return {};
  const input = requireRecord(value, "variableFallbacks");
  const allowed = new Set(allowedVariables);
  const output: Record<string, string> = {};
  for (const [name, fallback] of Object.entries(input)) {
    if (!allowed.has(name)) {
      throw new ContentValidationError(`Fallback variable ${name} is not in allowedVariables`);
    }
    output[name] = cleanOptionalString(fallback, `Fallback ${name}`, 2000);
  }
  return output;
}

export function extractTemplateVariables(template: string) {
  const names = new Set<string>();
  for (const match of template.matchAll(variableTokenPattern)) names.add(match[1]);
  return [...names].sort();
}

function validateTemplateSyntax(subject: string, body: string, allowedVariables: readonly string[]) {
  const combined = `${subject}\n${body}`;
  if (unsafeTemplateSyntaxPattern.test(combined)) {
    throw new ContentValidationError("Only escaped {{variable_name}} placeholders are supported");
  }
  if (unsafeHtmlTemplatePattern.test(combined)) {
    throw new ContentValidationError("Template contains unsafe active HTML");
  }
  const allowed = new Set(allowedVariables);
  for (const variable of extractTemplateVariables(combined)) {
    if (!allowed.has(variable)) {
      throw new ContentValidationError(`Template variable ${variable} is not allowed`);
    }
  }
  const withoutSupportedTokens = combined.replace(variableTokenPattern, "");
  if (withoutSupportedTokens.includes("{{") || withoutSupportedTokens.includes("}}")) {
    throw new ContentValidationError("Template contains an invalid placeholder");
  }
}

function parseLinks(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ContentValidationError("links must be an array");
  if (value.length > 50) throw new ContentValidationError("No more than 50 links are allowed");
  return value.map((entry): DocumentLinkInput => {
    const link = requireRecord(entry, "link");
    return {
      targetType: enumValue(link.targetType, contentLinkTargetTypes, "contact", "targetType"),
      targetId: assertUuid(link.targetId, "targetId"),
      projectId: parseOptionalUuid(link.projectId, "link projectId"),
    };
  });
}

export function parseCreateDocumentInput(value: unknown): CreateDocumentInput {
  const input = requireRecord(value);
  const checksum = cleanOptionalString(input.checksumSha256, "checksumSha256", 64).toLowerCase();
  if (checksum && !sha256Pattern.test(checksum)) {
    throw new ContentValidationError("checksumSha256 must be a lower-case SHA-256 digest");
  }
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new ContentValidationError("sizeBytes must be a non-negative integer");
  }
  return {
    title: cleanRequiredString(input.title, "title", 240),
    category: cleanOptionalString(input.category, "category", 80) || "document",
    projectId: parseOptionalUuid(input.projectId, "projectId"),
    mediaAssetId: assertUuid(input.mediaAssetId, "mediaAssetId"),
    fileName: cleanRequiredString(input.fileName, "fileName", 255),
    mimeType: cleanRequiredString(input.mimeType, "mimeType", 160).toLowerCase(),
    sizeBytes,
    checksumSha256: checksum || null,
    changeNote: cleanOptionalString(input.changeNote, "changeNote", 1000),
    visibility: enumValue(input.visibility, documentVisibilities, "internal", "visibility"),
    tags: normalizeTags(input.tags),
    links: parseLinks(input.links),
  };
}

export function parseAddDocumentVersionInput(value: unknown): AddDocumentVersionInput {
  const input = requireRecord(value);
  const parsed = parseCreateDocumentInput({
    title: "version",
    mediaAssetId: input.mediaAssetId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    checksumSha256: input.checksumSha256,
    changeNote: input.changeNote,
  });
  return {
    mediaAssetId: parsed.mediaAssetId,
    fileName: parsed.fileName,
    mimeType: parsed.mimeType,
    sizeBytes: parsed.sizeBytes,
    checksumSha256: parsed.checksumSha256,
    changeNote: parsed.changeNote,
    expectedUpdatedAt: parseExpectedUpdatedAt(input.expectedUpdatedAt),
  };
}

export function parseCreateTemplateInput(value: unknown): CreateTemplateInput {
  const input = requireRecord(value);
  const allowedVariables = normalizeVariables(input.allowedVariables);
  const subject = cleanOptionalString(input.subject, "subject", 1000);
  const body = cleanRequiredString(input.body, "body", 100_000);
  validateTemplateSyntax(subject, body, allowedVariables);
  return {
    name: cleanRequiredString(input.name, "name", 160),
    channel: enumValue(input.channel, templateChannels, "email", "channel"),
    purpose: cleanOptionalString(input.purpose, "purpose", 80) || "general",
    projectId: parseOptionalUuid(input.projectId, "projectId"),
    defaultLanguage: enumValue(input.defaultLanguage, contentLanguages, "de", "defaultLanguage"),
    language: enumValue(input.language, contentLanguages, "de", "language"),
    subject,
    body,
    allowedVariables,
    variableFallbacks: normalizeFallbacks(input.variableFallbacks, allowedVariables),
    changeNote: cleanOptionalString(input.changeNote, "changeNote", 1000),
  };
}

export function parseAddTemplateVersionInput(value: unknown): AddTemplateVersionInput {
  const input = requireRecord(value);
  const parsed = parseCreateTemplateInput({
    name: "version",
    channel: "email",
    language: input.language,
    body: input.body,
    subject: input.subject,
    allowedVariables: input.allowedVariables,
    variableFallbacks: input.variableFallbacks,
    changeNote: input.changeNote,
  });
  return {
    language: parsed.language ?? "de",
    subject: parsed.subject,
    body: parsed.body,
    allowedVariables: parsed.allowedVariables,
    variableFallbacks: parsed.variableFallbacks,
    changeNote: parsed.changeNote,
    expectedUpdatedAt: parseExpectedUpdatedAt(input.expectedUpdatedAt),
  };
}

export function parseDocumentUpdateInput(value: unknown) {
  const input = requireRecord(value);
  const update = {
    expectedUpdatedAt: parseExpectedUpdatedAt(input.expectedUpdatedAt),
    title: input.title === undefined ? undefined : cleanRequiredString(input.title, "title", 240),
    category: input.category === undefined
      ? undefined
      : cleanRequiredString(input.category, "category", 80),
    tags: input.tags === undefined ? undefined : normalizeTags(input.tags),
    visibility: input.visibility === undefined
      ? undefined
      : enumValue(input.visibility, documentVisibilities, "internal", "visibility"),
    approvalStatus: input.approvalStatus === undefined
      ? undefined
      : enumValue(input.approvalStatus, approvalStatuses, "draft", "approvalStatus"),
  };
  if (Object.entries(update).every(([key, item]) => key === "expectedUpdatedAt" || item === undefined)) {
    throw new ContentValidationError("At least one document field must be changed");
  }
  return update;
}

export function parseTemplateUpdateInput(value: unknown) {
  const input = requireRecord(value);
  const update = {
    expectedUpdatedAt: parseExpectedUpdatedAt(input.expectedUpdatedAt),
    name: input.name === undefined ? undefined : cleanRequiredString(input.name, "name", 160),
    purpose: input.purpose === undefined ? undefined : cleanRequiredString(input.purpose, "purpose", 80),
    defaultLanguage: input.defaultLanguage === undefined
      ? undefined
      : enumValue(input.defaultLanguage, contentLanguages, "de", "defaultLanguage"),
    approvalStatus: input.approvalStatus === undefined
      ? undefined
      : enumValue(input.approvalStatus, approvalStatuses, "draft", "approvalStatus"),
  };
  if (Object.entries(update).every(([key, item]) => key === "expectedUpdatedAt" || item === undefined)) {
    throw new ContentValidationError("At least one template field must be changed");
  }
  return update;
}

export function parseArchiveInput(value: unknown) {
  const input = requireRecord(value);
  return {
    expectedUpdatedAt: parseExpectedUpdatedAt(input.expectedUpdatedAt),
    reason: cleanRequiredString(input.reason, "reason", 1000),
  };
}

export function parseContentPage(params: URLSearchParams): ContentPage {
  const page = Math.max(1, Math.min(10_000, Number.parseInt(params.get("page") ?? "1", 10) || 1));
  const pageSize = Math.max(1, Math.min(50, Number.parseInt(params.get("pageSize") ?? "20", 10) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function parseIdempotencyKey(request: Request) {
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!key || key.length > 180 || /[\r\n]/.test(key)) {
    throw new ContentValidationError("A valid Idempotency-Key header is required");
  }
  return key;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function renderCommunicationTemplate(input: {
  template: string;
  allowedVariables: readonly string[];
  variableFallbacks?: Readonly<Record<string, string>>;
  values?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  output?: "text" | "html";
}) {
  validateTemplateSyntax("", input.template, input.allowedVariables);
  const fallback = input.variableFallbacks ?? {};
  const values = input.values ?? {};
  const unresolved: string[] = [];
  const rendered = input.template.replace(variableTokenPattern, (_, name: string) => {
    const raw = values[name] ?? fallback[name];
    if (raw === undefined || raw === null || raw === "") {
      unresolved.push(name);
      return "";
    }
    const text = String(raw);
    return input.output === "html" ? escapeHtml(text) : text;
  });
  return { rendered, unresolved: [...new Set(unresolved)].sort() };
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return '"[undefined]"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function isSupportedLanguage(value: string): value is ContentLanguage {
  return contentLanguages.includes(value as ContentLanguage) && languagePattern.test(value);
}
