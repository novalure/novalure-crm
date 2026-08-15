import { getAuthRuntimeStatus, getRequestSession, serializeSession } from "@/lib/auth/session";

export async function GET(request: Request) {
  const session = await getRequestSession(request);

  if (!session) {
    return Response.json({ authenticated: false, ...getAuthRuntimeStatus() }, { status: 401 });
  }

  return Response.json(serializeSession(session));
}
