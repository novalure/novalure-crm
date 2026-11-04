"use client";
import { useEffect, useState } from "react";
import type { WorkspaceUser } from "@/lib/crm-types";

type TeamState = { scopeKey: string; attempt: number; users: WorkspaceUser[]; currentUserId: string | null; failed: boolean };
/** The previous workspace/project result is never used while a different scope loads. */
export function useCrmTeam(workspaceId: string, projectId?: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<TeamState | null>(null);
  const normalizedProjectId = projectId || null;
  const scopeKey = JSON.stringify([workspaceId, normalizedProjectId]);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ workspaceId });
    if (normalizedProjectId) query.set("projectId", normalizedProjectId);
    void Promise.resolve().then(() => fetch(`/api/crm/team?${query}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal }))
      .then(async response => {
        const payload = await response.json() as { workspaceId?: string; currentUserId?: string; projectId?: string | null; source?: string; members?: WorkspaceUser[] };
        if (!response.ok || payload.workspaceId !== workspaceId || payload.projectId !== normalizedProjectId || payload.source !== "database" || typeof payload.currentUserId !== "string" || !Array.isArray(payload.members) || payload.members.some(user => user.workspaceId !== workspaceId || user.status !== "active" || typeof user.id !== "string" || typeof user.name !== "string" || typeof user.email !== "string")) throw new Error("Team unavailable");
        if (!controller.signal.aborted) setResult({ scopeKey, attempt, users: payload.members, currentUserId: payload.currentUserId, failed: false });
      })
      .catch(() => { if (!controller.signal.aborted) setResult({ scopeKey, attempt, users: [], currentUserId: null, failed: true }); });
    return () => controller.abort();
  }, [workspaceId, normalizedProjectId, scopeKey, attempt]);
  const current = result?.scopeKey === scopeKey && result.attempt === attempt ? result : null;
  return { users: current?.users ?? [], currentUserId: current?.currentUserId ?? null, loading: !current, failed: current?.failed ?? false, retry: () => setAttempt(value => value + 1) };
}
