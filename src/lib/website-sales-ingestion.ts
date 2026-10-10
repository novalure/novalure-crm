import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const websiteSalesContractVersion = "website-sales-lead-v1";
export const websiteSalesFormId = "0f98b9fd-d300-4a34-a14c-54a1a61b2415";
export const websiteSalesWorkspaceId = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";

const acceptedPackages = new Set([
  "STARTER",
  "BUSINESS",
  "PREMIUM",
  "MANAGED_CARE",
  "PERFORMANCE",
  "CONVERSION",
  "UNDECIDED",
  "CUSTOM",
]);

export type WebsiteSalesLeadPayload = {
  attribution?: Record<string, unknown>;
  company?: string;
  consent: boolean;
  currentWebsiteUrl?: string;
  email: string;
  idempotencyKey: string;
  message: string;
  name: string;
  packageInterest: string;
  phone?: string;
  syntheticTest?: boolean;
  version: string;
};

function cleanString(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function cleanAttribution(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const acceptedKeys = [
    "landingPage",
    "pageUrl",
    "referrer",
    "utmCampaign",
    "utmContent",
    "utmMedium",
    "utmSource",
    "utmTerm",
  ];
  return Object.fromEntries(
    acceptedKeys.map((key) => [key, cleanString((value as Record<string, unknown>)[key], 2_048)])
      .filter(([, entry]) => Boolean(entry)),
  );
}

export function parseWebsiteSalesLeadPayload(value: unknown): WebsiteSalesLeadPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const email = cleanString(record.email, 254).toLowerCase();
  const packageInterest = cleanString(record.packageInterest, 40);
  const idempotencyKey = cleanString(record.idempotencyKey, 128);
  const currentWebsiteUrl = cleanString(record.currentWebsiteUrl, 2_048);
  if (
    cleanString(record.version, 64) !== websiteSalesContractVersion ||
    !cleanString(record.name, 120) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    !cleanString(record.message, 3_000) ||
    cleanString(record.message, 3_000).length < 20 ||
    record.consent !== true ||
    !acceptedPackages.has(packageInterest) ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(idempotencyKey) ||
    (currentWebsiteUrl && !isSafeWebsiteUrl(currentWebsiteUrl))
  ) {
    return null;
  }

  return {
    attribution: cleanAttribution(record.attribution),
    company: cleanString(record.company, 160),
    consent: true,
    currentWebsiteUrl,
    email,
    idempotencyKey,
    message: cleanString(record.message, 3_000),
    name: cleanString(record.name, 120),
    packageInterest,
    phone: cleanString(record.phone, 40),
    syntheticTest: record.syntheticTest === true,
    version: websiteSalesContractVersion,
  };
}

function isSafeWebsiteUrl(value: string) {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function buildWebsiteSalesSignature(input: { body: string; secret: string; timestamp: string }) {
  return createHmac("sha256", input.secret)
    .update(`${websiteSalesContractVersion}.${input.timestamp}.${input.body}`, "utf8")
    .digest("base64url");
}

export function verifyWebsiteSalesSignature(input: {
  body: string;
  secret: string | undefined;
  signature: string | null;
  timestamp: string | null;
}) {
  const timestamp = input.timestamp ?? "";
  const timestampSeconds = Number(timestamp);
  const secret = input.secret?.trim() ?? "";
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) return false;
  if (!/^[0-9]{10,11}$/u.test(timestamp) || !Number.isInteger(timestampSeconds)) return false;
  if (Math.abs(Math.floor(Date.now() / 1_000) - timestampSeconds) > 300) return false;
  if (!input.signature || input.signature.length > 128) return false;

  const expected = Buffer.from(buildWebsiteSalesSignature({ body: input.body, secret, timestamp }));
  const supplied = Buffer.from(input.signature);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function resolveWebsiteSalesClientIp(value: string | null) {
  const candidate = value?.split(",", 1)[0]?.trim() ?? "";
  return candidate && isIP(candidate) ? candidate : null;
}

export function createWebsiteSalesReference() {
  return `NL-${randomBytes(4).toString("hex").toUpperCase()}`;
}
