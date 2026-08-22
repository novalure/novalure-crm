import { NextResponse } from "next/server";
import { getRequestSession, resolveWorkspaceScopedSession, type AppSession } from "@/lib/auth/session";
import {
  loadPaginatedPropertyAssets,
  loadPropertyReservations,
  loadPropertyUnits,
} from "@/lib/db/crm-loaders";
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
import { enforceCsrfForSession } from "@/lib/security/csrf";
import {
  routePropertyInquiry,
  runPropertyChannelPreflight,
  type PropertyAssetSummary,
  type PropertyInquiryRouteInput,
} from "@/lib/property-department";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
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

const propertyInquiryIdFields = [
  "projectId",
  "propertyId",
  "unitId",
  "contactId",
  "leadId",
  "ownerUserId",
  "funnelId",
  "formId",
] as const;

function normalizeInquiryId(field: typeof propertyInquiryIdFields[number], value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  const normalized = field === "propertyId" ? candidate.replace(/^listing:/, "") : candidate;
  if (!uuidPattern.test(normalized)) return null;
  return field === "propertyId" && candidate.startsWith("listing:") ? `listing:${normalized}` : normalized;
}

function parsePropertyInquiry(payload: Record<string, unknown>, workspaceId: string) {
  const inquiry: Record<string, unknown> = {
    ...payload,
    sourceChannel: typeof payload.sourceChannel === "string" && payload.sourceChannel.trim()
      ? payload.sourceChannel.trim()
      : "Manual",
    workspaceId,
  };

  for (const field of propertyInquiryIdFields) {
    const value = normalizeInquiryId(field, payload[field]);
    if (value === null) return { error: `Invalid ${field}` } as const;
    if (value === undefined) delete inquiry[field];
    else inquiry[field] = value;
  }

  return { inquiry: inquiry as PropertyInquiryRouteInput } as const;
}

async function loadCanonicalPropertyInquiryCandidates(workspaceId: string) {
  const [firstPage, units, reservations] = await Promise.all([
    loadPaginatedPropertyAssets(workspaceId, { limit: 200, offset: 0 }),
    loadPropertyUnits(workspaceId),
    loadPropertyReservations(workspaceId),
  ]);
  const assets = [...firstPage.assets];
  let nextOffset = firstPage.pagination.nextOffset;
  const loadedOffsets = new Set<number>([0]);

  while (firstPage.pagination.hasMore && nextOffset !== null && !loadedOffsets.has(nextOffset)) {
    loadedOffsets.add(nextOffset);
    const page = await loadPaginatedPropertyAssets(workspaceId, { limit: 200, offset: nextOffset });
    assets.push(...page.assets);
    nextOffset = page.pagination.nextOffset;
    if (!page.pagination.hasMore) break;
  }

  return {
    assets: assets.filter((asset) => (
      asset.workspaceId === workspaceId &&
      asset.kind === "property" &&
      Boolean(asset.sellerListingId) &&
      asset.id === `listing:${asset.sellerListingId}`
    )),
    reservations: reservations.filter((reservation) => reservation.workspaceId === workspaceId),
    units: units.filter((unit) => unit.workspaceId === workspaceId),
  };
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
  const result = await loadPaginatedPropertyAssets(auth.session.workspaceId, {
    limit: parseIntegerParam(url.searchParams.get("limit"), 50, 1, 200),
    offset: parseIntegerParam(url.searchParams.get("offset"), 0, 0, 100_000),
    projectId,
    q,
    status,
  });

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

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const operation = typeof input.operation === "string" ? input.operation : "create_property";

  if (operation === "route_inquiry") {
    const parsed = parsePropertyInquiry(asObject(input.inquiry), session.workspaceId);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const inquiry = parsed.inquiry;
    const candidates = await loadCanonicalPropertyInquiryCandidates(session.workspaceId);
    const route = routePropertyInquiry(inquiry, candidates);

    if (!canPersistRouting(session)) {
      return NextResponse.json({
        persisted: false,
        reason: "CRM write permission required to persist inquiry routing.",
        route,
      });
    }

    const result = await persistPropertyInquiryRoute({ inquiry, route, session });
    if (!result.persisted) {
      return NextResponse.json(
        { persisted: false, reason: result.reason, route },
        { status: getWriteStatus(result.reason) },
      );
    }

    return NextResponse.json({ data: result.data, persisted: true, route: result.data.route });
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
      const result = await savePropertyCostItems({
        costItems: input.costItems,
        projectId: input.projectId,
        propertyId: input.propertyId,
        session,
      });
      if (!result.persisted) {
        return NextResponse.json({ error: result.reason }, { status: getWriteStatus(result.reason) });
      }
      return NextResponse.json({ data: result.data, persisted: true });
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
