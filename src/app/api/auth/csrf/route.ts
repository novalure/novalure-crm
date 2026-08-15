import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import { issueCsrfToken } from "@/lib/security/csrf";

export async function GET(request: Request) {
  const session = await getRequestSession(request);
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { headers: { "Cache-Control": "private, no-store" }, status: 401 },
    );
  }

  const issuance = issueCsrfToken(request, session);
  if (!issuance.ok) return issuance.response;

  return NextResponse.json(
    {
      csrfToken: issuance.created.token,
      expiresAt: new Date(issuance.created.expiresAt).toISOString(),
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
