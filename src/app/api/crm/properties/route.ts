import {
  assertCrmFields,
  crmCommandErrorResponse,
  crmRequestMetadata,
  CrmCommandError,
  withCrmRead,
} from "@/lib/crm-command";
import { NextResponse } from "next/server";
import { getRequestSession, resolveWorkspaceScopedSession, type AppSession } from "@/lib/auth/session";
import type { PropertyReservation, PropertyUnit } from "@/lib/crm-types";
import { loadPaginatedPropertyAssets } from "@/lib/db/crm-loaders";
import {
  attachPropertyDocument,
  attachPropertyMedia,
  createSellerListingRecord,
  persistPropertyInquiryRoute,
  recordPropertyPreflightRun,
  savePropertyCostItems,
  savePropertyTextBlocks,
  updatePropertyMediaOrder,
  updatePropertyPriceVisibility,
  updateSellerListingRecord,
} from "@/lib/db/property-department-repositories";
import { hasProductCapability } from "@/lib/product-model";
import { readBoundedCrmJson } from "@/lib/crm-request-body";
import { enforceCsrfForSession } from "@/lib/security/csrf";
import {
  routePropertyInquiry,
  runPropertyChannelPreflight,
  type PropertyAssetSummary,
  type PropertyInquiryRouteInput,
} from "@/lib/property-department";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROPERTY_POST_BYTES = 16_384;
const MAX_PROPERTY_COST_ITEMS = 100;
const propertyCostItemFields = [
  "costKey", "key", "groupKey", "label", "monthlyGross", "monthlyGrossCents", "monthlyNet",
  "monthlyNetCents", "monthlyVat", "monthlyVatCents", "oneTimeGross", "oneTimeGrossCents",
  "oneTimeNet", "oneTimeNetCents", "oneTimeVat", "oneTimeVatCents", "vatPercent", "optional",
  "commissionRelevant", "exposeVisible", "internalNote", "position", "metadata",
] as const;

async function readJson(request: Request) {
  return readBoundedCrmJson(request, MAX_PROPERTY_POST_BYTES);
}

function boundedString(value: unknown, label: string, maxLength: number, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new CrmCommandError("INVALID_COST_ITEM", `${label} is required`);
    return;
  }
  if (typeof value !== "string") {
    throw new CrmCommandError("INVALID_COST_ITEM", `${label} must be a string`);
  }
  const length = value.trim().length;
  if ((required && length === 0) || length > maxLength) {
    throw new CrmCommandError("INVALID_COST_ITEM", `${label} must contain 1-${maxLength} characters`);
  }
}

function assertPropertyCostItemsBoundary(input: Record<string, unknown>) {
  assertCrmFields(input, ["operation", "projectId", "propertyId", "costItems", "idempotencyKey", "correlationId"]);
  if (!Array.isArray(input.costItems)) {
    throw new CrmCommandError("INVALID_COST_ITEMS", "costItems must be an array");
  }
  if (input.costItems.length > MAX_PROPERTY_COST_ITEMS) {
    throw new CrmCommandError("COST_ITEMS_LIMIT", `costItems must contain at most ${MAX_PROPERTY_COST_ITEMS} items`);
  }
  for (const [index, rawItem] of input.costItems.entries()) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      throw new CrmCommandError("INVALID_COST_ITEM", `costItems[${index}] must be an object`);
    }
    const item = rawItem as Record<string, unknown>;
    assertCrmFields(item, propertyCostItemFields);
    const hasCostKey = typeof item.costKey === "string" && item.costKey.trim().length > 0;
    boundedString(hasCostKey ? item.costKey : item.key, `costItems[${index}].costKey`, 100, true);
    boundedString(item.costKey, `costItems[${index}].costKey`, 100);
    boundedString(item.key, `costItems[${index}].key`, 100);
    boundedString(item.groupKey, `costItems[${index}].groupKey`, 100);
    boundedString(item.label, `costItems[${index}].label`, 200, true);
    boundedString(item.internalNote, `costItems[${index}].internalNote`, 2_000);
    for (const field of [
      "monthlyGross", "monthlyGrossCents", "monthlyNet", "monthlyNetCents", "monthlyVat",
      "monthlyVatCents", "oneTimeGross", "oneTimeGrossCents", "oneTimeNet", "oneTimeNetCents",
      "oneTimeVat", "oneTimeVatCents", "vatPercent",
    ] as const) {
      if (typeof item[field] === "string") boundedString(item[field], `costItems[${index}].${field}`, 80);
    }
    for (const field of ["optional", "commissionRelevant", "exposeVisible"] as const) {
      if (item[field] !== undefined && typeof item[field] !== "boolean") {
        throw new CrmCommandError("INVALID_COST_ITEM", `costItems[${index}].${field} must be a boolean`);
      }
    }
    if (item.position !== undefined && (!Number.isSafeInteger(item.position) || Number(item.position) < 0)) {
      throw new CrmCommandError("INVALID_COST_ITEM", `costItems[${index}].position must be a non-negative integer`);
    }
    if (item.metadata !== undefined
      && (!item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata))) {
      throw new CrmCommandError("INVALID_COST_ITEM", `costItems[${index}].metadata must be an object`);
    }
  }
}

function canWriteProperty(session: AppSession) {
  const hasCrmWrite = session.permissions.includes("crm:write");
  const canOperate =
    hasProductCapability(session.productRole, "workspace:operate") ||
    hasProductCapability(session.productRole, "pipeline:write");
  const isAdmin = session.role === "owner" ||
    session.role === "admin" ||
    hasProductCapability(session.productRole, "settings:manage") ||
    hasProductCapability(session.productRole, "workspace:admin");

  return hasCrmWrite && (canOperate || isAdmin);
}

function canPersistRouting(session: AppSession) {
  return session.permissions.includes("crm:write");
}

function getWriteStatus(reason: string) {
  const lower = reason.toLowerCase();
  if (lower.includes("permission") || lower.includes("forbidden") || lower.includes("required")) return 403;
  if (lower.includes("not found")) return 404;
  if (lower.includes("invalid") || lower.includes("title") || lower.includes("address")) return 400;
  return 503;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function parseIntegerParam(value: string | null, fallback: number, min: number, max: number) {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseProjectId(value: string | null) {
  if (!value) return null;
  return uuidPattern.test(value) ? value : undefined;
}

function parseStatus(value: string | null) {
  if (!value) return null;
  const status = value.trim();
  return /^[a-z_]{1,50}$/i.test(status) ? status : undefined;
}

function parseIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{16,160}$/.test(value) ? value : null;
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const projectId = parseProjectId(url.searchParams.get("projectId"));
  if (projectId === undefined) {
    return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
  }

  const status = parseStatus(url.searchParams.get("status"));
  if (status === undefined) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const q = url.searchParams.get("q")?.trim().slice(0, 100) || null;
  const result = await withCrmRead(auth.session, () => loadPaginatedPropertyAssets(auth.session.workspaceId, {
    limit: parseIntegerParam(url.searchParams.get("limit"), 50, 1, 200),
    offset: parseIntegerParam(url.searchParams.get("offset"), 0, 0, 100_000),
    projectId,
    q,
    status,
  }));

  return NextResponse.json({
    data: { assets: result.assets },
    filters: {
      projectId,
      q,
      status,
    },
    pagination: result.pagination,
    persisted: true,
    source: "database",
  });
}

export async function POST(request: Request) {
  const session = await getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const csrf = await enforceCsrfForSession(request, session);
  if (!csrf.ok) return csrf.response;

  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    return crmCommandErrorResponse(error);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return crmCommandErrorResponse(new CrmCommandError("INVALID_REQUEST", "JSON object required"));
  }

  const input = body as Record<string, unknown>;
  const operation = typeof input.operation === "string" ? input.operation : "create_property";

  if (operation === "route_inquiry") {
    const inquiry = {
      ...asObject(input.inquiry),
      workspaceId: session.workspaceId,
    } as PropertyInquiryRouteInput;
    const route = routePropertyInquiry(inquiry, {
      assets: asArray<PropertyAssetSummary>(input.assets),
      reservations: asArray<PropertyReservation>(input.reservations),
      units: asArray<PropertyUnit>(input.units),
    });

    if (!canPersistRouting(session)) {
      return NextResponse.json({
        persisted: false,
        reason: "CRM write permission required to persist inquiry routing.",
        route,
      });
    }

    const result = await persistPropertyInquiryRoute({ inquiry, route, session });
    if (!result.persisted) {
      return NextResponse.json({ persisted: false, reason: result.reason, route });
    }

    return NextResponse.json({ data: result.data, persisted: true, route });
  }

  if (operation === "run_preflight") {
    const idempotencyKey = parseIdempotencyKey(request);
    if (input.recordHistory !== false && !idempotencyKey) {
      return NextResponse.json({ error: "A valid Idempotency-Key header is required" }, { status: 400 });
    }
    const asset = asObject(input.asset) as PropertyAssetSummary;
    const channel = typeof input.channel === "string" && input.channel.trim()
      ? input.channel.trim()
      : "Immobilienportal";
    if (!asset.id || !asset.title) {
      return NextResponse.json({ error: "Preflight asset is required" }, { status: 400 });
    }

    const preflight = runPropertyChannelPreflight(asset, channel);
    if (!canPersistRouting(session) || input.recordHistory === false) {
      return NextResponse.json({
        preflight,
        persisted: false,
        reason: "CRM write permission required to record preflight history.",
      });
    }

    const result = await recordPropertyPreflightRun({
      assetId: asset.sellerListingId ? `listing:${asset.sellerListingId}` : asset.id,
      channel,
      idempotencyKey: idempotencyKey ?? "not-persisted",
      preflight,
      projectId: asset.projectId,
      session,
    });

    if (!result.persisted) {
      return NextResponse.json({ preflight, persisted: false, reason: result.reason });
    }

    return NextResponse.json({ data: result.data, preflight, persisted: true });
  }

  if (operation !== "create_property") {
    if (!canWriteProperty(session)) {
      return NextResponse.json({ error: "CRM write and property operating rights are required" }, { status: 403 });
    }

    if (operation === "update_property_core") {
      const propertyPayload = asObject(input.property);
      const result = await updateSellerListingRecord({
        property: Object.keys(propertyPayload).length ? propertyPayload : input,
        propertyId: input.propertyId ?? propertyPayload.id,
        session,
      });
      if (!result.persisted) {
        return NextResponse.json({ error: result.reason }, { status: getWriteStatus(result.reason) });
      }
      return NextResponse.json({ data: result.data, persisted: true });
    }

    if (operation === "save_text_blocks") {
      const result = await savePropertyTextBlocks({
        projectId: input.projectId,
        propertyId: input.propertyId,
        session,
        textBlocks: input.textBlocks,
      });
      if (!result.persisted) {
        return NextResponse.json({ error: result.reason }, { status: getWriteStatus(result.reason) });
      }
      return NextResponse.json({ data: result.data, persisted: true });
    }

    if (operation === "save_cost_items") {
      let correlationId: string | undefined;
      try {
        assertPropertyCostItemsBoundary(input);
        const metadata = crmRequestMetadata(request, input);
        correlationId = metadata.correlationId;
        const result = await savePropertyCostItems({
          costItems: input.costItems,
          projectId: input.projectId,
          propertyId: input.propertyId,
          session,
          ...metadata,
        });
        if (!result.persisted) {
          return NextResponse.json({ error: result.reason }, { status: getWriteStatus(result.reason) });
        }
        return NextResponse.json({
          auditReference: result.auditReference,
          commandId: result.commandId,
          correlationId,
          data: result.data,
          persisted: true,
          replayed: result.replayed,
        });
      } catch (error) {
        return crmCommandErrorResponse(error, correlationId);
      }
    }

    if (operation === "attach_media") {
      const result = await attachPropertyMedia({
        media: asObject(input.media),
        projectId: input.projectId,
        propertyId: input.propertyId,
        session,
      });
      if (!result.persisted) {
        return NextResponse.json({ error: result.reason }, { status: getWriteStatus(result.reason) });
      }
      return NextResponse.json({ data: result.data, persisted: true });
    }

    if (operation === "attach_document") {
      const result = await attachPropertyDocument({
        document: asObject(input.document),
        projectId: input.projectId,
        propertyId: input.propertyId,
        session,
      });
      if (!result.persisted) {
        return NextResponse.json({ error: result.reason }, { status: getWriteStatus(result.reason) });
      }
      return NextResponse.json({ data: result.data, persisted: true });
    }

    if (operation === "update_media_order") {
      const result = await updatePropertyMediaOrder({
        mediaItems: input.mediaItems,
        propertyId: input.propertyId,
        session,
      });
      if (!result.persisted) {
        return NextResponse.json({ error: result.reason }, { status: getWriteStatus(result.reason) });
      }
      return NextResponse.json({ data: result.data, persisted: true });
    }

    if (operation === "update_price_visibility") {
      const result = await updatePropertyPriceVisibility({
        channelPriceVisibility: input.channelPriceVisibility,
        priceVisibility: input.priceVisibility,
        projectId: input.projectId,
        propertyId: input.propertyId,
        publicPrice: input.publicPrice,
        session,
      });
      if (!result.persisted) {
        return NextResponse.json({ error: result.reason }, { status: getWriteStatus(result.reason) });
      }
      return NextResponse.json({ data: result.data, persisted: true });
    }

    return NextResponse.json({ error: "Unsupported property operation" }, { status: 400 });
  }

  if (!canWriteProperty(session)) {
    return NextResponse.json({ error: "CRM write and property operating rights are required" }, { status: 403 });
  }

  const result = await createSellerListingRecord({ property: input, session });
  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getWriteStatus(result.reason) });
  }

  return NextResponse.json({ data: result.data, persisted: true });
}
