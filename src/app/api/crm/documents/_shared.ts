import { NextResponse } from "next/server";
import { ContentValidationError } from "@/lib/content-library";
import { ContentRepositoryError } from "@/lib/db/content-library-repositories";

export async function readObjectBody(request: Request) {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ContentValidationError("JSON body must be an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ContentValidationError) throw error;
    throw new ContentValidationError("Invalid JSON body");
  }
}

export function contentRouteError(error: unknown) {
  if (error instanceof ContentValidationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  if (error instanceof ContentRepositoryError) {
    const status = {
      CONFLICT: 409,
      FORBIDDEN: 403,
      IDEMPOTENCY_CONFLICT: 409,
      NOT_FOUND: 404,
      PERSISTENCE_UNAVAILABLE: 503,
      REFERENCE_BLOCKED: 423,
    }[error.code];
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  console.error("Content Library route failed", error);
  return NextResponse.json({ error: "The request could not be completed" }, { status: 503 });
}
