import { NextResponse } from "next/server";
import { getRequestSession, type AppSession } from "@/lib/auth/session";
import type { PropertyReservation, PropertyUnit } from "@/lib/crm-types";
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
import {
  routePropertyInquiry,
  runPropertyChannelPreflight,
  type PropertyAssetSummary,
  type PropertyInquiryRouteInput,
} from "@/lib/property-department";

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

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export async function POST(request: Request) {
  const session = await getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
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
