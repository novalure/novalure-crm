import { NextResponse } from "next/server";
import { getRequestSession, resolveWorkspaceScopedSession, type AppSession } from "@/lib/auth/session";
import { canUseBrokerProjectEditScope } from "@/lib/broker-flow/access-policy";
import { canViewAllWorkspaceContacts } from "@/lib/contact-access";
import {
  loadPaginatedPropertyAssets,
  loadPropertyReservations,
  loadPropertyUnits,
} from "@/lib/db/crm-loaders";
import {
  attachPropertyDocument,
  attachPropertyMedia,
  createSellerListingRecord,
  loadPropertyInquiryProjectGrantIds,
  persistPropertyInquiryRoute,
  savePropertyCostItems,
  savePropertyTextBlocks,
  updatePropertyMediaOrder,
  updatePropertyPriceVisibility,
  updateSellerListingRecord,
} from "@/lib/db/property-department-repositories";
import { hasProductCapability } from "@/lib/product-model";
import { enforceCsrfForSession } from "@/lib/security/csrf";
import { canAccessPropertyExports } from "@/lib/property-export/access";
import {
  routePropertyInquiry,
  type PropertyAssetSummary,
  type PropertyInquiryRouteInput,
  type PropertyInquiryRouteResult,
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
  if (lower.includes("invalid") || lower.includes("title") || lower.includes("address")) return 400;
  if (lower.includes("not found")) return 404;
  if (lower.includes("permission") || lower.includes("forbidden") || lower.includes("required")) return 403;
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

function safeCsvCell(value: unknown) {
  const raw = value === null || value === undefined ? "" : String(value);
  const spreadsheetSafe = /^[=+\-@\t\r]/.test(raw.trimStart()) ? `'${raw}` : raw;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}

function propertyAssetsCsv(assets: PropertyAssetSummary[]) {
  const rows = [
    ["id", "title", "address", "project", "status", "object_type", "area_sqm", "price"],
    ...assets.map((asset) => [
      asset.sellerListingId ?? asset.id,
      asset.title,
      asset.location,
      asset.projectName,
      asset.status,
      asset.objectType,
      asset.areaSqm ?? "",
      asset.price ?? "",
    ]),
  ];
  return `\uFEFF${rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n")}\r\n`;
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

async function loadCanonicalPropertyInquiryCandidates(session: AppSession) {
  const workspaceWide = canViewAllWorkspaceContacts(session);
  const assetScope = {
    actorUserId: session.userId,
    allowProjectEditGrants: canUseBrokerProjectEditScope(session),
    workspaceWide,
  };
  const [firstPage, units, reservations, explicitProjectGrantIds] = await Promise.all([
    loadPaginatedPropertyAssets(session.workspaceId, { ...assetScope, limit: 200, offset: 0 }),
    loadPropertyUnits(session.workspaceId),
    loadPropertyReservations(session.workspaceId),
    workspaceWide ? Promise.resolve([]) : loadPropertyInquiryProjectGrantIds(session),
  ]);
  const assets = [...firstPage.assets];
  let nextOffset = firstPage.pagination.nextOffset;
  const loadedOffsets = new Set<number>([0]);

  while (firstPage.pagination.hasMore && nextOffset !== null && !loadedOffsets.has(nextOffset)) {
    loadedOffsets.add(nextOffset);
    const page = await loadPaginatedPropertyAssets(session.workspaceId, {
      ...assetScope,
      limit: 200,
      offset: nextOffset,
    });
    assets.push(...page.assets);
    nextOffset = page.pagination.nextOffset;
    if (!page.pagination.hasMore) break;
  }

  const scopedAssets = assets.filter((asset) => (
    asset.workspaceId === session.workspaceId &&
    asset.kind === "property" &&
    Boolean(asset.sellerListingId) &&
    asset.id === `listing:${asset.sellerListingId}`
  ));
  const assetProjectIds = new Set(scopedAssets.map((asset) => asset.projectId).filter((id): id is string => Boolean(id)));
  const visibleUnitIds = new Set(scopedAssets.flatMap((asset) => asset.unitIds ?? []));
  const fullProjectIds = workspaceWide ? assetProjectIds : new Set(explicitProjectGrantIds);
  const scopedUnits = units.filter((unit) => (
    unit.workspaceId === session.workspaceId &&
    (fullProjectIds.has(unit.projectId) || visibleUnitIds.has(unit.id))
  ));
  const allowedUnitIds = new Set([...visibleUnitIds, ...scopedUnits.map((unit) => unit.id)]);
  const allowedProjectIds = new Set([...assetProjectIds, ...fullProjectIds]);

  return {
    candidates: {
      assets: scopedAssets,
      reservations: reservations.filter((reservation) => (
        reservation.workspaceId === session.workspaceId && allowedUnitIds.has(reservation.unitId)
      )),
      units: scopedUnits,
    },
    scope: {
      projectIds: allowedProjectIds,
      propertyIds: new Set(scopedAssets.flatMap((asset) => (
        asset.sellerListingId ? [asset.id, asset.sellerListingId] : [asset.id]
      ))),
      unitIds: allowedUnitIds,
    },
  };
}

function isPropertyInquiryRouteWithinScope(
  inquiry: PropertyInquiryRouteInput,
  route: PropertyInquiryRouteResult,
  scope: {
    projectIds: ReadonlySet<string>;
    propertyIds: ReadonlySet<string>;
    unitIds: ReadonlySet<string>;
  },
) {
  return [inquiry.projectId, route.projectId].every((id) => !id || scope.projectIds.has(id))
    && [inquiry.propertyId, route.propertyId].every((id) => !id || scope.propertyIds.has(id))
    && [inquiry.unitId, route.unitId].every((id) => !id || scope.unitIds.has(id));
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
  const format = url.searchParams.get("format")?.trim().toLowerCase() || null;
  if (format && format !== "csv") {
    return NextResponse.json({ error: "Invalid format" }, { status: 400 });
  }

  if (format === "csv") {
    if (!canAccessPropertyExports(auth.session)) {
      return NextResponse.json(
        { error: "Property CSV export requires the server-side export policy." },
        { headers: { "cache-control": "private, no-store" }, status: 403 },
      );
    }
    const firstPage = await loadPaginatedPropertyAssets(auth.session.workspaceId, {
      actorUserId: auth.session.userId,
      allowProjectEditGrants: canUseBrokerProjectEditScope(auth.session),
      limit: 200,
      offset: 0,
      projectId,
      q,
      status,
      workspaceWide: canViewAllWorkspaceContacts(auth.session),
    });
    if (firstPage.pagination.total > 5_000) {
      return NextResponse.json(
        { error: "CSV export is limited to 5,000 records. Apply a narrower project, status, or search filter." },
        { headers: { "cache-control": "private, no-store" }, status: 413 },
      );
    }
    const csvAssets = [...firstPage.assets];
    let offset = firstPage.pagination.nextOffset;
    while (offset !== null) {
      const page = await loadPaginatedPropertyAssets(auth.session.workspaceId, {
        actorUserId: auth.session.userId,
        allowProjectEditGrants: canUseBrokerProjectEditScope(auth.session),
        limit: 200,
        offset,
        projectId,
        q,
        status,
        workspaceWide: canViewAllWorkspaceContacts(auth.session),
      });
      csvAssets.push(...page.assets);
      offset = page.pagination.nextOffset;
    }
    return new Response(propertyAssetsCsv(csvAssets), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": 'attachment; filename="novalure-properties.csv"',
        "content-type": "text/csv; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const result = await loadPaginatedPropertyAssets(auth.session.workspaceId, {
    actorUserId: auth.session.userId,
    allowProjectEditGrants: canUseBrokerProjectEditScope(auth.session),
    limit: parseIntegerParam(url.searchParams.get("limit"), 50, 1, 200),
    offset: parseIntegerParam(url.searchParams.get("offset"), 0, 0, 100_000),
    projectId,
    q,
    status,
    workspaceWide: canViewAllWorkspaceContacts(auth.session),
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
    const canonical = await loadCanonicalPropertyInquiryCandidates(session);
    const route = routePropertyInquiry(inquiry, canonical.candidates);
    if (!isPropertyInquiryRouteWithinScope(inquiry, route, canonical.scope)) {
      return NextResponse.json({ error: "Property inquiry target not found." }, { status: 404 });
    }

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
    return NextResponse.json(
      {
        code: "legacy_property_preflight_removed",
        error: "Legacy client-supplied preflight was removed. Use the canonical property export API.",
        persisted: false,
        replacement: "/api/crm/property-exports",
      },
      { headers: { "cache-control": "private, no-store" }, status: 410 },
    );
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
