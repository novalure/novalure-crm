import {
  hashPropertyExportSnapshot,
  sha256Hex,
} from "@/lib/property-export/canonical-payload";
import {
  PROPERTY_EXPORT_QA_PROVIDER,
  type ClaimedPropertyExportJob,
  type PropertyExportArtifact,
  type PropertyExportAvailability,
  type PropertyExportSnapshot,
} from "@/lib/property-export/types";

export class PropertyExportProviderConfigurationError extends Error {
  readonly code: "external_portal_launch_off" | "qa_sink_disabled" | "unsupported_provider";

  constructor(
    code: PropertyExportProviderConfigurationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "PropertyExportProviderConfigurationError";
    this.code = code;
  }
}

export function isPropertyExportQaSinkEnabled(env: NodeJS.ProcessEnv = process.env) {
  const vercelEnvironment = env.VERCEL_ENV?.trim().toLowerCase() ?? "";
  return vercelEnvironment === "preview" &&
    env.NOVALURE_PROPERTY_EXPORT_QA_SINK_ENABLED === "1";
}

export function getPropertyExportAvailability(
  env: NodeJS.ProcessEnv = process.env,
): PropertyExportAvailability {
  return {
    externalPortals: [
      { configurationState: "not_configured", key: "willhaben", label: "willhaben", launchState: "launch_off" },
      { configurationState: "not_configured", key: "immobilienscout24", label: "ImmobilienScout24", launchState: "launch_off" },
      { configurationState: "not_configured", key: "immowelt", label: "immowelt", launchState: "launch_off" },
    ],
    qaSink: {
      key: PROPERTY_EXPORT_QA_PROVIDER,
      label: "Novalure Preview QA Sink",
      state: isPropertyExportQaSinkEnabled(env) ? "ready" : "not_configured",
    },
  };
}

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function element(name: string, value: unknown) {
  if (value === null || value === undefined || value === "") return `<${name}/>`;
  return `<${name}>${escapeXml(value)}</${name}>`;
}

function recordValue(record: Record<string, unknown>, key: string) {
  return record[key] ?? null;
}

function safeFilenamePart(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "property";
}

/**
 * Deterministic, non-certified OpenImmo-shaped artifact for the isolated QA
 * sink. The root element is deliberately not `openimmo`: consumers must not
 * mistake this Preview proof for a portal/XSD-certified production feed.
 */
export function buildOpenImmoPreviewXml(snapshot: PropertyExportSnapshot) {
  const property = snapshot.property;
  const identifiers = property.identifiers;
  const pricing = property.pricing;
  const address = property.address;
  const project = property.project;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<novalure-openimmo-preview schema="novalure.property-export-snapshot.v1" certification="none">',
    `  <format>${escapeXml(snapshot.format)}</format>`,
    "  <property>",
    `    ${element("id", property.id)}`,
    `    ${element("object-number", identifiers.objectNumber)}`,
    `    ${element("internal-reference", identifiers.internalReference)}`,
    `    ${element("openimmo-object-id", identifiers.openimmoObjectId)}`,
    `    ${element("title", property.title)}`,
    `    ${element("object-type", property.objectType)}`,
    `    ${element("sub-object-type", property.subObjectType)}`,
    `    ${element("usage-type", property.usageType)}`,
    `    ${element("marketing-type", property.marketingType)}`,
    `    ${element("area-sqm", property.areaSqm)}`,
    `    ${element("rooms", property.rooms)}`,
    `    ${element("year-built", property.yearBuilt)}`,
    `    ${element("updated-at", property.updatedAt)}`,
    "    <address>",
    `      ${element("unstructured", address.unstructured)}`,
    `      ${element("street", address.street)}`,
    `      ${element("house-number", address.houseNumber)}`,
    `      ${element("postal-code", address.postalCode)}`,
    `      ${element("city", address.city)}`,
    `      ${element("federal-state", address.federalState)}`,
    `      ${element("country", address.country)}`,
    "    </address>",
    "    <pricing>",
    `      ${element("visibility", pricing.priceVisibility)}`,
    `      ${element("public-price-cents", pricing.publicPriceCents)}`,
    `      ${element("rent-price-cents", pricing.rentPriceCents)}`,
    `      ${element("rent-net-cents", pricing.rentNetCents)}`,
    `      ${element("monthly-costs-gross-cents", pricing.monthlyCostsGrossCents)}`,
    `      ${element("purchase-ancillary-costs-cents", pricing.purchaseAncillaryCostsCents)}`,
    "    </pricing>",
    "    <contact>",
    `      ${element("name", property.contact.name)}`,
    `      ${element("email", property.contact.email)}`,
    `      ${element("phone", property.contact.phone)}`,
    "    </contact>",
    "    <availability>",
    `      ${element("available-from", property.availability.availableFrom)}`,
    `      ${element("available-from-text", property.availability.availableFromText)}`,
    "    </availability>",
    "    <project>",
    `      ${element("id", project?.id)}`,
    `      ${element("name", project?.name)}`,
    "    </project>",
    "    <units>",
    ...property.units.map((unit) => [
      `      <unit id="${escapeXml(unit.id)}">`,
      `        ${element("unit-number", unit.unitNumber)}`,
      `        ${element("status", unit.status)}`,
      `        ${element("floor", unit.floor)}`,
      `        ${element("area-sqm", unit.areaSqm)}`,
      `        ${element("rooms", unit.rooms)}`,
      `        ${element("price-cents", unit.priceCents)}`,
      "      </unit>",
    ].join("\n")),
    "    </units>",
    "    <texts>",
    ...snapshot.texts.map((item) => [
      `      <text key="${escapeXml(recordValue(item, "textKey"))}" position="${escapeXml(recordValue(item, "position"))}">`,
      `        ${element("title", recordValue(item, "title"))}`,
      `        ${element("content", recordValue(item, "content"))}`,
      `        ${element("seo-title", recordValue(item, "seoTitle"))}`,
      `        ${element("seo-description", recordValue(item, "seoDescription"))}`,
      "      </text>",
    ].join("\n")),
    "    </texts>",
    "    <costs>",
    ...snapshot.costs.map((item) => [
      `      <cost key="${escapeXml(recordValue(item, "costKey"))}" group="${escapeXml(recordValue(item, "groupKey"))}" position="${escapeXml(recordValue(item, "position"))}">`,
      `        ${element("label", recordValue(item, "label"))}`,
      `        ${element("monthly-net-cents", recordValue(item, "monthlyNetCents"))}`,
      `        ${element("monthly-vat-cents", recordValue(item, "monthlyVatCents"))}`,
      `        ${element("monthly-gross-cents", recordValue(item, "monthlyGrossCents"))}`,
      `        ${element("one-time-net-cents", recordValue(item, "oneTimeNetCents"))}`,
      `        ${element("one-time-vat-cents", recordValue(item, "oneTimeVatCents"))}`,
      `        ${element("one-time-gross-cents", recordValue(item, "oneTimeGrossCents"))}`,
      `        ${element("vat-percent", recordValue(item, "vatPercent"))}`,
      "      </cost>",
    ].join("\n")),
    "    </costs>",
    "    <media>",
    ...snapshot.media.map((item) => [
      `      <asset id="${escapeXml(recordValue(item, "id"))}" position="${escapeXml(recordValue(item, "position"))}">`,
      `        ${element("type", recordValue(item, "mediaType"))}`,
      `        ${element("category", recordValue(item, "category"))}`,
      `        ${element("title", recordValue(item, "title"))}`,
      `        ${element("alt-text", recordValue(item, "altText"))}`,
      `        ${element("mime-type", recordValue(item, "mimeType"))}`,
      `        ${element("reference", recordValue(item, "mediaReference"))}`,
      "      </asset>",
    ].join("\n")),
    "    </media>",
    "    <documents>",
    ...snapshot.documents.map((item) => [
      `      <document id="${escapeXml(recordValue(item, "id"))}">`,
      `        ${element("category", recordValue(item, "category"))}`,
      `        ${element("title", recordValue(item, "title"))}`,
      `        ${element("mime-type", recordValue(item, "mimeType"))}`,
      `        ${element("reference", recordValue(item, "mediaReference"))}`,
      `        ${element("required", recordValue(item, "requiredForPublication"))}`,
      "      </document>",
    ].join("\n")),
    "    </documents>",
    "  </property>",
    "</novalure-openimmo-preview>",
  ];

  return `${lines.join("\n")}\n`;
}

export function createQaSinkArtifact(snapshot: PropertyExportSnapshot): PropertyExportArtifact {
  const content = buildOpenImmoPreviewXml(snapshot);
  const objectReference = snapshot.property.identifiers.objectNumber ?? snapshot.property.id;
  return {
    content,
    contentType: "application/xml; charset=utf-8",
    filename: `novalure-qa-${safeFilenamePart(objectReference)}.xml`,
    sha256: sha256Hex(content),
  };
}

export async function deliverPropertyExportToQaSink(
  job: ClaimedPropertyExportJob,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (job.providerKey !== PROPERTY_EXPORT_QA_PROVIDER) {
    throw new PropertyExportProviderConfigurationError(
      "unsupported_provider",
      "External property portal delivery is launch-off and not configured.",
    );
  }
  if (!isPropertyExportQaSinkEnabled(env)) {
    throw new PropertyExportProviderConfigurationError(
      "qa_sink_disabled",
      "The Preview QA property export sink is not enabled for this runtime.",
    );
  }

  const recalculatedPayloadHash = hashPropertyExportSnapshot(job.payloadSnapshot);
  if (recalculatedPayloadHash !== job.payloadSha256) {
    throw new Error("Property export payload integrity check failed");
  }

  const artifact = createQaSinkArtifact(job.payloadSnapshot);
  return {
    artifact,
    providerRequestId: `qa_${job.id.replaceAll("-", "")}_${artifact.sha256.slice(0, 16)}`,
    resultMetadata: {
      certification: "none",
      deliveryMode: "preview_qa_sink",
      networkRequestPerformed: false,
      payloadSha256: job.payloadSha256,
    },
  };
}
