import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import { executeQuery, hasDatabaseUrl, queryOne } from "@/lib/db/client";

type OnboardingRow = {
  completedAt: string | null;
};

async function getCompletedAt(userId: string, workspaceId: string) {
  return queryOne<OnboardingRow>(
    `
      select onboarding_completed_at as "completedAt"
      from workspace_users
      where id = $1::uuid
        and workspace_id = $2::uuid
      limit 1
    `,
    [userId, workspaceId],
  );
}

export async function GET(request: Request) {
  const session = await getRequestSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!hasDatabaseUrl()) {
    return NextResponse.json({ completedAt: null, source: "fallback" });
  }

  try {
    const row = await getCompletedAt(session.userId, session.workspaceId);
    return NextResponse.json({ completedAt: row?.completedAt ?? null, source: "database" });
  } catch {
    return NextResponse.json({ completedAt: null, source: "migration_pending" });
  }
}

export async function POST(request: Request) {
  const session = await getRequestSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!hasDatabaseUrl()) {
    return NextResponse.json({ completedAt: new Date().toISOString(), persisted: false, source: "fallback" });
  }

  try {
    await executeQuery(
      `
        update workspace_users
        set onboarding_completed_at = coalesce(onboarding_completed_at, now()),
            updated_at = now()
        where id = $1::uuid
          and workspace_id = $2::uuid
      `,
      [session.userId, session.workspaceId],
    );
    const row = await getCompletedAt(session.userId, session.workspaceId);

    return NextResponse.json({
      completedAt: row?.completedAt ?? new Date().toISOString(),
      persisted: true,
      source: "database",
    });
  } catch {
    return NextResponse.json(
      { error: "onboarding_not_persisted", persisted: false, source: "migration_pending" },
      { status: 503 },
    );
  }
}
