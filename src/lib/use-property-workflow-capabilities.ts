"use client";

import { useEffect, useState } from "react";
import { propertyWorkspaceEndpoint } from "@/lib/property-interactions";

type Capabilities = { canEditProperty: boolean; canReviewDocuments: boolean; canAssignInquiry: boolean };
const none: Capabilities = { canEditProperty: false, canReviewDocuments: false, canAssignInquiry: false };

export function usePropertyWorkflowCapabilities(workspaceId: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ workspaceId: string; data: Capabilities; failed: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => fetch(`${propertyWorkspaceEndpoint("/api/crm/properties", workspaceId)}&operation=capabilities`, { cache: "no-store", signal: controller.signal }))
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || payload.workspaceId !== workspaceId || !payload.capabilities ||
          Object.keys(none).some((key) => typeof payload.capabilities[key] !== "boolean")) throw new Error("Capabilities unavailable");
        if (!controller.signal.aborted) setResult({ workspaceId, data: payload.capabilities, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ workspaceId, data: none, failed: true });
      });
    return () => controller.abort();
  }, [workspaceId, attempt]);
  const current = result?.workspaceId === workspaceId ? result : null;
  return { ...(current?.data ?? none), loading: !current, failed: current?.failed ?? false, retry: () => setAttempt((value) => value + 1) };
}
