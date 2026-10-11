import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { AppSession } from "@/lib/auth/session";
import { findWorkspaceMediaAsset, readMediaAssetContent, saveWorkspaceFile, type MediaAsset } from "@/lib/media-store";
import { rasterUploadLimits } from "@/lib/media-raster-validation";
import { parsePropertyIntegerCents } from "@/lib/property-money";
import { normalizePurchaseAncillaryCalculation } from "@/lib/property-purchase-costs";
import { PROPERTY_EXPOSE_MAX_PDF_BYTES, PROPERTY_EXPOSE_MAX_IMAGES, PROPERTY_EXPOSE_MAX_FLOORPLANS,
  type PropertyExposeDocument, type PropertyExposeOptions, type PropertyExposeState, type PropertyExposeImage } from "@/lib/property-expose";
import { assertExposeRevision, canWritePropertyExpose, exposeUuid, findPropertyExposeVersionAsset, loadPropertyExposeSnapshot,
  persistPropertyExposeChange, PropertyExposeError, type ExposeSnapshot, type ExposeStoredVersion } from "@/lib/db/property-expose-repositories";
import { validatePropertyExposePdf } from "@/lib/property-expose-pdf-validation";
import { renderPropertyExposePdf } from "@/lib/property-expose-pdf";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const iso = () => new Date().toISOString();
export function parsePropertyExposeOptions(value: unknown): PropertyExposeOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PropertyExposeError("EXPOSE_OPTIONS_INVALID", 400, "Invalid Exposé options.");
  const o = value as Record<string, unknown>;
  const allowed = ["template", "language", "address", "showPrice", "showContact", "imageIds", "floorPlanIds", "title", "description"];
  if (Object.keys(o).some(k => !allowed.includes(k)) || !["compact", "full"].includes(String(o.template)) ||
      !["de", "en"].includes(String(o.language)) || !["city", "full", "hidden"].includes(String(o.address)) ||
      typeof o.showPrice !== "boolean" || typeof o.showContact !== "boolean" ||
      !Array.isArray(o.imageIds) || !Array.isArray(o.floorPlanIds) || o.imageIds.length > PROPERTY_EXPOSE_MAX_IMAGES ||
      o.floorPlanIds.length > PROPERTY_EXPOSE_MAX_FLOORPLANS || o.imageIds.some(v => !exposeUuid(v)) ||
      o.floorPlanIds.some(v => !exposeUuid(v) && !(typeof v === "string" && v.startsWith("document:") && exposeUuid(v.slice(9)))) ||
      new Set([...o.imageIds, ...o.floorPlanIds]).size !== o.imageIds.length + o.floorPlanIds.length ||
      (o.title !== undefined && (typeof o.title !== "string" || o.title.length > 180)) ||
      (o.description !== undefined && (typeof o.description !== "string" || o.description.length > 16000))) {
    throw new PropertyExposeError("EXPOSE_OPTIONS_INVALID", 400, "Invalid Exposé options, text length or image selection.");
  }
  return o as PropertyExposeOptions;
}
export async function readLimitedMediaBytes(asset: MediaAsset, limit = PROPERTY_EXPOSE_MAX_PDF_BYTES): Promise<Uint8Array> {
  if (asset.storageAccess !== "private" || asset.isPublic || asset.hasActivePublicShare || asset.publicToken ||
      asset.sizeBytes <= 0 || asset.sizeBytes > limit) throw new PropertyExposeError("EXPOSE_FILE_UNAVAILABLE", 409, "A private readable file is required.");
  const content = await readMediaAssetContent(asset);
  if (!content || content.sizeBytes <= 0 || content.sizeBytes > limit) throw new PropertyExposeError("EXPOSE_FILE_UNAVAILABLE", 409, "File is unavailable or exceeds its size limit.");
  if (content.body instanceof Uint8Array) {
    if (content.body.byteLength !== asset.sizeBytes || content.body.byteLength > limit) throw new PropertyExposeError("EXPOSE_FILE_CHANGED", 409, "File size changed.");
    return content.body;
  }
  const reader = content.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  const deadline = Date.now() + 20_000;
  let timeout: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new PropertyExposeError("EXPOSE_READ_TIMEOUT", 503, "File could not be read in time.")), 20_000); });
  try {
    while (true) {
      if (Date.now() > deadline) throw new PropertyExposeError("EXPOSE_READ_TIMEOUT", 503, "File could not be read in time.");
      const item = await Promise.race([reader.read(), expired]);
      if (item.done) break;
      total += item.value.byteLength;
      if (total > limit) throw new PropertyExposeError("EXPOSE_FILE_TOO_LARGE", 413, "File exceeds the allowed size.");
      chunks.push(item.value);
    }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { clearTimeout(timeout!); reader.releaseLock(); }
  if (total !== asset.sizeBytes) throw new PropertyExposeError("EXPOSE_FILE_CHANGED", 409, "File size changed.");
  return Buffer.concat(chunks, total);
}
function exposeUrl(snapshot: ExposeSnapshot, documentId: string, download = false) {
  return `/api/crm/properties/expose/${documentId}?workspaceId=${encodeURIComponent(snapshot.workspaceId)}&propertyId=${snapshot.propertyId}${download ? "&download=1" : ""}`;
}
async function stateFromSnapshot(snapshot: ExposeSnapshot, session: AppSession): Promise<PropertyExposeState> {
  const p = snapshot.source.listing;
  const versions = [];
  const newestFirst = [...snapshot.registry.versions].reverse();
  // Bound concurrent DB lookups rather than issuing 100 sequential HTTP queries
  // or an unbounded burst. Promise.all preserves the displayed version order.
  for (let offset = 0; offset < newestFirst.length; offset += 6) {
    versions.push(...await Promise.all(newestFirst.slice(offset, offset + 6).map(async version => {
      const available = Boolean(await findPropertyExposeVersionAsset(snapshot, version.id));
      return { id: version.id, source: version.source, fileName: version.fileName, createdAt: version.createdAt,
        sizeBytes: version.sizeBytes, pageCount: version.pageCount, versionLabel: version.versionLabel,
        sourceFingerprint: version.sourceFingerprint, stale: version.sourceFingerprint !== snapshot.sourceFingerprint,
        available, options: version.options, previewUrl: exposeUrl(snapshot, version.id), downloadUrl: exposeUrl(snapshot, version.id, true) };
    })));
  }
  const media = snapshot.source.media.map(m => ({ id: String(m.id), title: text(m.title), kind: m.kind as "image" | "floorplan",
    isCover: m.isCover === true, mimeType: text(m.mimeType), url: `/api/media/files/${m.assetId}?workspaceId=${snapshot.workspaceId}` }));
  const defaults: PropertyExposeOptions = { template: "compact", language: "de", address: "city", showPrice: true, showContact: true,
    imageIds: [...snapshot.source.media].filter(m => m.kind === "image").sort((a, b) => Number(b.isCover) - Number(a.isCover) || Number(a.position) - Number(b.position))
      .slice(0, 3).map(m => String(m.id)), floorPlanIds: [] };
  const warnings = ["EXPOSE_PRIVATE_ONLY"];
  if (!snapshot.source.company) warnings.push("EXPOSE_COMPANY_PROFILE_NOT_APPROVED");
  if (!media.length) warnings.push("EXPOSE_NO_ELIGIBLE_IMAGES");
  if (snapshot.registry.activeDocumentId && !versions.find(v => v.id === snapshot.registry.activeDocumentId)?.available) warnings.push("EXPOSE_ACTIVE_UNAVAILABLE");
  return { propertyId: snapshot.propertyId, propertyTitle: text(p.title), revision: snapshot.registry.revision,
    sourceFingerprint: snapshot.sourceFingerprint, preferredSource: snapshot.registry.preferredSource,
    activeDocumentId: snapshot.registry.activeDocumentId, versions, media, defaultOptions: defaults, warnings, canEdit: canWritePropertyExpose(session) };
}
export async function getPropertyExposeState(session: AppSession, propertyId: string) {
  return stateFromSnapshot(await loadPropertyExposeSnapshot(session.workspaceId, propertyId), session);
}
export function buildPropertyExposeDocument(snapshot: ExposeSnapshot, options: PropertyExposeOptions, images: PropertyExposeImage[]): PropertyExposeDocument {
  const p = snapshot.source.listing, de = options.language === "de";
  const money = (value: unknown) => {
    const cents = parsePropertyIntegerCents(value); return cents === null ? null : new Intl.NumberFormat(de ? "de-AT" : "en-GB", { style: "currency", currency: "EUR" }).format(cents / 100);
  };
  const sanitizeAddress = (value: unknown) => {
    let result = text(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    if (options.address !== "full") for (const privatePart of [text(p.address)]) {
      if (privatePart.length >= 3) result = result.split(privatePart).join(de ? "[Adresse ausgeblendet]" : "[address hidden]");
    }
    return result;
  };
  const channel = p.channelPriceVisibility && typeof p.channelPriceVisibility === "object" ? p.channelPriceVisibility as Record<string, unknown> : {};
  const visibility = ["publish_price", "price_on_request", "hide_price"].includes(String(channel.Exposé)) ? channel.Exposé : p.priceVisibility;
  const visibleMoney = options.showPrice && visibility === "publish_price";
  const rental = p.marketingType === "rent";
  const supportedMarketing = ["sale", "rent", "sale_or_rent"].includes(String(p.marketingType));
  if (!supportedMarketing) throw new PropertyExposeError("EXPOSE_MARKETING_INVALID", 400, "Purchase or rental marketing type must be saved before export.");
  // Public price is authoritative when set. A valuation/unit sum is NEVER a fallback.
  const selectedPrice = p.publicPriceCents ?? (rental ? p.rentPriceCents ?? p.rentNetCents : p.targetPriceCents);
  const priceAmount = money(selectedPrice);
  const notices = [de ? "Dieses Exposé wurde aus dem gespeicherten Objektstand erstellt. Angaben und Verfügbarkeit bitte vor Weitergabe prüfen." :
    "This brochure was created from the saved property record. Please verify the information and availability before sharing."];
  if (visibleMoney && priceAmount === null) throw new PropertyExposeError("EXPOSE_PRICE_MISSING", 400, "A valid saved display price is missing. Choose price on request or hide the price explicitly.");
  const facts = [];
  if (text(p.objectType)) facts.push({ label: de ? "Objektart" : "Property type", value: text(p.objectType) });
  for (const [field, label, suffix] of [["areaSqm", de ? "Fläche" : "Area", " m²"], ["rooms", de ? "Zimmer" : "Rooms", ""], ["yearBuilt", de ? "Baujahr" : "Year built", ""]]) {
    if (p[field] !== null && p[field] !== undefined && Number.isFinite(Number(p[field])) && Number(p[field]) > 0) {
      facts.push({ label, value: new Intl.NumberFormat(de ? "de-AT" : "en-GB").format(Number(p[field])) + suffix });
    }
  }
  const availability = text(p.availableFromText) || text(p.availableFrom);
  if (availability) facts.push({ label: de ? "Verfügbar" : "Available", value: availability });
  const costs = [];
  // Hiding price also hides all price-derived totals/rates, preventing reconstruction.
  if (visibleMoney) {
    const calculation = normalizePurchaseAncillaryCalculation(p.purchaseAncillaryCalculation);
    const differentBasis = calculation && parsePropertyIntegerCents(selectedPrice) !== parsePropertyIntegerCents(p.targetPriceCents);
    const ancillary = !rental && !differentBasis ? money(p.purchaseAncillaryCostsCents) : null;
    if (!rental && differentBasis) notices.push(de ? "Automatische Kaufnebenkosten wurden nicht ausgegeben, da ihre Berechnungsbasis vom freigegebenen Anzeigepreis abweicht." : "Automatic purchase ancillary costs were omitted because their calculation basis differs from the approved display price.");
    if (ancillary !== null) {
      costs.push({ label: de ? "Kaufnebenkosten (Auswahl/Pauschale)" : "Purchase ancillary costs (selection/allowance)", value: ancillary });
      if (calculation) costs.push({ label: de ? "Berechnungsbasis" : "Calculation basis", value: `${new Intl.NumberFormat(de ? "de-AT" : "en-GB").format(calculation.rateBps / 100)} % × ${money(p.targetPriceCents) ?? "—"}` });
      notices.push(de ? "Die Kaufnebenkosten sind eine bearbeitbare Auswahl/Pauschale, keine vollständige gesetzliche Gesamtkostenberechnung. Individuelle Kosten und Ausnahmen sind gesondert zu prüfen." :
        "Purchase ancillary costs are an editable selection/allowance, not a complete statutory total. Individual costs and exemptions require separate review.");
    }
    for (const c of snapshot.source.costs) {
      const monthly = money(c.monthlyGrossCents), once = money(c.oneTimeGrossCents);
      if (monthly !== null && Number(c.monthlyGrossCents) !== 0) costs.push({ label: `${sanitizeAddress(c.label)} (${de ? "monatlich" : "monthly"})`, value: monthly });
      if (once !== null && Number(c.oneTimeGrossCents) !== 0) costs.push({ label: `${sanitizeAddress(c.label)} (${de ? "einmalig" : "one-time"})`, value: once });
    }
  }
  const description = sanitizeAddress(options.description ?? snapshot.source.texts[0]?.content);
  const energy = [];
  if (text(p.energyClass)) energy.push({ label: de ? "Energieklasse (gespeichert)" : "Energy class (saved)", value: text(p.energyClass) });
  if (text(p.energyValidUntil)) energy.push({ label: de ? "Energieausweis gültig bis" : "Energy certificate valid until", value: text(p.energyValidUntil) });
  if (!energy.length) notices.push(de ? "Energieangaben fehlen im gespeicherten Objektstand." : "Energy information is missing from the saved property.");
  const company = snapshot.source.company;
  const contact = options.showContact ? { name: text(p.contactName) || undefined, email: text(p.contactEmail) || text(company?.email) || undefined,
    phone: text(p.contactPhone) || text(company?.phone) || undefined, company: text(company?.name) || undefined } : undefined;
  if (options.showContact && !contact?.email && !contact?.phone) notices.push(de ? "Ein öffentlicher Ansprechpartner fehlt." : "A public contact is missing.");
  return { template: options.template, language: options.language, title: sanitizeAddress(options.title || p.title).slice(0, 180),
    reference: sanitizeAddress(p.objectNumber) || snapshot.propertyId.slice(0, 8), createdAt: iso(),
    address: options.address === "full" ? text(p.address) : options.address === "city" ? [text(p.postalCode), text(p.city) || text(p.region)].filter(Boolean).join(" ") : undefined,
    price: options.showPrice && visibility === "price_on_request" ? (de ? "Preis auf Anfrage" : "Price on request") : visibleMoney ? `${rental ? (de ? "Miete" : "Rent") : (de ? "Kaufpreis" : "Purchase price")}: ${priceAmount}${rental ? (de ? " / Monat" : " / month") : ""}` : undefined,
    facts, sections: description ? [{ heading: de ? "Beschreibung" : "Description", text: description }] : [], costs, energy, contact, images, notices };
}
async function selectedImages(snapshot: ExposeSnapshot, options: PropertyExposeOptions) {
  const output: PropertyExposeImage[] = [];
  const floorPlanPdfs: NonNullable<PropertyExposeDocument["floorPlanPdfs"]> = [];
  const sourceMediaHashes: Record<string, string> = {};
  let floorPlanPages = 0;
  let totalInput = 0;
  for (const [kind, ids] of [["image", options.imageIds], ["floorplan", options.floorPlanIds]] as const) for (const id of ids) {
    const selected = snapshot.source.media.find(m => m.id === id && m.kind === kind);
    if (!selected) throw new PropertyExposeError("EXPOSE_MEDIA_INVALID", 409, "Selected media is not a private eligible image of this property.");
    const asset = await findWorkspaceMediaAsset(String(selected.assetId), snapshot.workspaceId);
    if (!asset || asset.folder.toLowerCase() !== `properties/${snapshot.propertyId}` && /^properties\//i.test(asset.folder)) throw new PropertyExposeError("EXPOSE_MEDIA_INVALID", 409, "Media scope changed.");
    const bytes = await readLimitedMediaBytes(asset);
    sourceMediaHashes[id] = createHash("sha256").update(bytes).digest("hex");
    totalInput += bytes.length;
    if (totalInput > 60 * 1024 * 1024) throw new PropertyExposeError("EXPOSE_MEDIA_BUDGET", 413, "Selected images exceed the 60 MB source budget. Select fewer images.");
    const caption = options.address === "full" ? text(selected.title) :
      `${options.language === "de" ? (kind === "floorplan" ? "Grundriss" : "Objektfoto") : (kind === "floorplan" ? "Floor plan" : "Property photo")} ${output.length + floorPlanPdfs.length + 1}`;
    if (asset.mimeType === "application/pdf" && kind === "floorplan") {
      const { pageCount } = await validatePropertyExposePdf(bytes);
      floorPlanPages += pageCount;
      if (floorPlanPages > PROPERTY_EXPOSE_MAX_FLOORPLANS) throw new PropertyExposeError("EXPOSE_FLOORPLAN_LIMIT", 400, "A maximum of eight total floor plan pages can be exported.");
      // PDF page content can itself disclose an address. With address hidden/city,
      // do not claim that page embedding redacts text already present in a plan.
      if (options.address !== "full") throw new PropertyExposeError("EXPOSE_FLOORPLAN_ADDRESS_REVIEW", 400, "PDF floor plans can contain the full address. To include them, explicitly allow the full address or use a pre-redacted plan image.");
      floorPlanPdfs.push({ id, bytes, caption, pageCount });
      continue;
    }
    if (kind === "floorplan" && ++floorPlanPages > PROPERTY_EXPOSE_MAX_FLOORPLANS) throw new PropertyExposeError("EXPOSE_FLOORPLAN_LIMIT", 400, "A maximum of eight total floor plan pages can be exported.");
    let image: Buffer;
    try {
      image = await sharp(bytes, { failOn: "warning", limitInputPixels: rasterUploadLimits.maxPixels, page: 0, pages: 1 })
        .rotate().resize({ width: kind === "floorplan" ? 2400 : 1800, height: kind === "floorplan" ? 3200 : 2400, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" }).jpeg({ quality: kind === "floorplan" ? 90 : 82 }).timeout({ seconds: 5 }).toBuffer();
    } catch { throw new PropertyExposeError("EXPOSE_MEDIA_INVALID", 415, "An image could not be decoded safely."); }
    output.push({ id, kind, bytes: image, mimeType: "image/jpeg", caption });
  }
  return { images: output, floorPlanPdfs, sourceMediaHashes };
}
export async function readPropertyExposePdf(session: AppSession, propertyId: string, documentId: string) {
  const snapshot = await loadPropertyExposeSnapshot(session.workspaceId, propertyId);
  const version = await findPropertyExposeVersionAsset(snapshot, documentId);
  if (!version) throw new PropertyExposeError("EXPOSE_FILE_UNAVAILABLE", 404, "Exposé file is not available for this property.");
  const asset = await findWorkspaceMediaAsset(version.assetId, session.workspaceId);
  if (!asset) throw new PropertyExposeError("EXPOSE_FILE_UNAVAILABLE", 404, "Exposé file is unavailable.");
  const bytes = await readLimitedMediaBytes(asset);
  if (createHash("sha256").update(bytes).digest("hex") !== version.sha256) throw new PropertyExposeError("EXPOSE_FILE_CHANGED", 409, "Exposé file integrity could not be verified.");
  return { bytes, version, snapshot };
}
export async function mutatePropertyExpose(session: AppSession, input: Record<string, unknown>, file?: File) {
  if (!canWritePropertyExpose(session)) throw new PropertyExposeError("EXPOSE_FORBIDDEN", 403, "Property operating rights are required.");
  if (!exposeUuid(input.propertyId)) throw new PropertyExposeError("EXPOSE_INVALID_SCOPE", 400, "Invalid property scope.");
  const snapshot = await loadPropertyExposeSnapshot(session.workspaceId, input.propertyId);
  assertExposeRevision(snapshot, input.expectedRevision);
  const operation = input.operation;
  if (operation === "generate" || operation === "upload") {
    if (snapshot.registry.versions.length >= 100) throw new PropertyExposeError("EXPOSE_VERSION_LIMIT", 409, "The 100-version limit has been reached.");
    let bytes: Uint8Array, options: PropertyExposeOptions | undefined;
    let sourceMediaHashes: Record<string, string> | undefined;
    let name: string;
    if (operation === "generate") {
      if (input.confirmed !== true) throw new PropertyExposeError("EXPOSE_CONFIRMATION_REQUIRED", 400, "Confirm the selected saved information for this private PDF.");
      options = parsePropertyExposeOptions(input.options);
      const selected = await selectedImages(snapshot, options);
      sourceMediaHashes = selected.sourceMediaHashes;
      bytes = await renderPropertyExposePdf({ ...buildPropertyExposeDocument(snapshot, options, selected.images), floorPlanPdfs: selected.floorPlanPdfs });
      name = `Novalure_Expose_${snapshot.propertyId.slice(0, 8)}_${options.language}_${iso().slice(0, 10)}.pdf`;
    } else {
      if (!(file instanceof File) || file.type.toLowerCase() !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf") || file.size <= 0 || file.size > PROPERTY_EXPOSE_MAX_PDF_BYTES) {
        throw new PropertyExposeError("EXPOSE_PDF_REQUIRED", 415, "A PDF file of 10 MB or less is required.");
      }
      bytes = new Uint8Array(await file.arrayBuffer());
      name = file.name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 160).replace(/\.pdf$/i, "") + ".pdf";
    }
    const { pageCount } = await validatePropertyExposePdf(bytes);
    const asset = await saveWorkspaceFile({ file: new File([Buffer.from(bytes)], name, { type: "application/pdf" }), name,
      workspaceId: session.workspaceId, folder: `properties/${snapshot.propertyId}` });
    const version: ExposeStoredVersion = { id: randomUUID(), assetId: asset.id, source: operation === "generate" ? "generated" : "uploaded",
      fileName: name, createdAt: iso(), sizeBytes: bytes.byteLength, pageCount, versionLabel: `v${snapshot.registry.versions.length + 1}`,
      sourceFingerprint: snapshot.sourceFingerprint, sha256: createHash("sha256").update(bytes).digest("hex"), ...(options ? { options, sourceMediaHashes } : {}) };
    // Storage and SQL cannot commit atomically. An uncertain write never deletes
    // the new private asset automatically (it may already have a committed reference).
    await persistPropertyExposeChange({ snapshot, session, expectedRevision: input.expectedRevision, operation: "version", version });
    return { persisted: true, documentId: version.id, data: await getPropertyExposeState(session, snapshot.propertyId) };
  }
  if (operation === "activate") {
    if (input.confirmed !== true || !exposeUuid(input.documentId)) throw new PropertyExposeError("EXPOSE_CONFIRMATION_REQUIRED", 400, "Review and confirm the exact PDF before activation.");
    await readPropertyExposePdf(session, snapshot.propertyId, input.documentId);
    await persistPropertyExposeChange({ snapshot, session, expectedRevision: input.expectedRevision, operation, documentId: input.documentId });
  } else if (operation === "deactivate") {
    if (input.confirmed !== true) throw new PropertyExposeError("EXPOSE_CONFIRMATION_REQUIRED", 400, "Confirm removal of the active Exposé selection.");
    await persistPropertyExposeChange({ snapshot, session, expectedRevision: input.expectedRevision, operation });
  } else if (operation === "preferences") {
    if (input.preferredSource !== "generated" && input.preferredSource !== "uploaded") throw new PropertyExposeError("EXPOSE_OPTIONS_INVALID", 400, "Invalid source preference.");
    await persistPropertyExposeChange({ snapshot, session, expectedRevision: input.expectedRevision, operation, preferredSource: input.preferredSource });
  } else throw new PropertyExposeError("EXPOSE_OPERATION_INVALID", 400, "Unsupported Exposé operation.");
  return { persisted: true, data: await getPropertyExposeState(session, snapshot.propertyId) };
}
