import { withCrmSalesWrite } from "@/lib/crm-sales-http";
import { NextResponse } from "next/server";
import type { AppSession } from "@/lib/auth/session";
import { upsertLeadRecord } from "@/lib/db/crm-write-repositories";
import { requirePermission } from "@/lib/auth/session";
import { withCrmRead } from "@/lib/crm-command";
import { queryOne } from "@/lib/db/client";
import { parseStudioEnquiryView } from "@/lib/studio-enquiry-view";

export async function GET(request: Request) {
  const auth=await requirePermission(request,"crm:read");
  if(!auth.ok)return auth.response;
  const id=new URL(request.url).searchParams.get("id")||"";
  const headers={"cache-control":"private, no-store","x-content-type-options":"nosniff"};
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))return NextResponse.json({error:"Invalid lead."},{status:400,headers});
  try {
    const row=await withCrmRead(auth.session,(_tx,session)=>queryOne<{enquiry:unknown}>(
      "select metadata->'studioEnquiry' as enquiry from leads where workspace_id=$1::uuid and id=$2::uuid",[session.workspaceId,id]));
    if(!row)return NextResponse.json({error:"Lead not found."},{status:404,headers});
    const enquiry=parseStudioEnquiryView(row.enquiry);
    if(!enquiry)return NextResponse.json({error:"Confirmed enquiry details are unavailable."},{status:404,headers});
    return NextResponse.json({enquiry},{headers});
  } catch {return NextResponse.json({error:"Confirmed enquiry details could not be read."},{status:503,headers});}
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getLeadWriteStatus(reason: string) {
  const normalizedReason = reason.toLowerCase();
  if (/VERSION_CONFLICT|IDEMPOTENCY_CONFLICT|CANONICAL_|USE_CANONICAL_/.test(reason)) return 409;
  if (
    reason.includes("not available in this workspace") ||
    normalizedReason.includes("permission") ||
    normalizedReason.includes("not allowed") ||
    normalizedReason.includes("only be changed")
  ) return 403;
  if (reason.includes("not found")) return 404;
  if (
    reason.includes("required") ||
    reason.includes("Invalid") ||
    reason.includes("too long") ||
    reason.includes("cannot be in the past")
  ) return 400;
  return 503;
}

function getLeadIdFromRequest(request: Request) {
  const url = new URL(request.url);
  return url.searchParams.get("id") ?? url.searchParams.get("leadId") ?? "";
}

function getIdempotencyKeyFromRequest(request: Request): { ok: true; value?: string } | { ok: false; reason: string } {
  const value = request.headers.get("Idempotency-Key")?.trim();
  if (!value) return { ok: true };
  if (value.length > 180) return { ok: false, reason: "Idempotency-Key is too long" };
  if (/[\r\n]/.test(value)) return { ok: false, reason: "Invalid Idempotency-Key" };
  return { ok: true, value };
}

function withLeadIdFromRequest(request: Request, lead: Record<string, unknown>) {
  if (typeof lead.id === "string" && lead.id.trim().length > 0) return lead;
  const id = getLeadIdFromRequest(request);
  return id ? { ...lead, id } : lead;
}

async function postHandler(request: Request, session: AppSession) {
  const auth = { session };

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const lead = typeof input.lead === "object" && input.lead ? input.lead as Record<string, unknown> : input;
  const idempotencyKey = getIdempotencyKeyFromRequest(request);
  if (!idempotencyKey.ok) {
    return NextResponse.json({ error: idempotencyKey.reason }, { status: getLeadWriteStatus(idempotencyKey.reason) });
  }

  const result = await upsertLeadRecord({ idempotencyKey: idempotencyKey.value, lead, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ code: result.code, error: result.reason }, { status: result.status ?? getLeadWriteStatus(result.reason) });
  }

  return NextResponse.json({ lead: result.data, persisted: true });
}

async function patchHandler(request: Request, session: AppSession) {
  const auth = { session };

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const lead = typeof input.lead === "object" && input.lead ? input.lead as Record<string, unknown> : input;
  const result = await upsertLeadRecord({
    lead: withLeadIdFromRequest(request, lead),
    requireExisting: true,
    session: auth.session,
  });

  if (!result.persisted) {
    return NextResponse.json({ code: result.code, error: result.reason }, { status: result.status ?? getLeadWriteStatus(result.reason) });
  }

  return NextResponse.json({ lead: result.data, persisted: true });
}

export const POST = withCrmSalesWrite(postHandler);
export const PATCH = withCrmSalesWrite(patchHandler);
