type CoreRequestTicket = Readonly<{ id: number; workspaceId: string }>;

/** Mounted CRM lifetime; no stale response may replace a newer or foreign scope. */
export function createCrmCoreRequestGuard(initialWorkspaceId: string) {
  let mounted = true;
  let activeWorkspaceId = initialWorkspaceId;
  let sequence = 0;
  let latestRefresh: CoreRequestTicket | null = null;
  let pendingSwitch: CoreRequestTicket | null = null;
  const isCurrentSwitch = (ticket: CoreRequestTicket) => mounted && pendingSwitch === ticket;

  return {
    activate() {
      mounted = true;
    },
    dispose() {
      mounted = false;
      latestRefresh = null;
      pendingSwitch = null;
    },
    beginRefresh(workspaceId: string): CoreRequestTicket | null {
      if (!mounted || pendingSwitch || workspaceId !== activeWorkspaceId) return null;
      latestRefresh = { id: ++sequence, workspaceId };
      return latestRefresh;
    },
    isCurrentRefresh(ticket: CoreRequestTicket) {
      return mounted && !pendingSwitch && latestRefresh === ticket && activeWorkspaceId === ticket.workspaceId;
    },
    beginSwitch(workspaceId: string): CoreRequestTicket | null {
      if (!mounted) return null;
      latestRefresh = null;
      pendingSwitch = { id: ++sequence, workspaceId };
      return pendingSwitch;
    },
    completeSwitch(ticket: CoreRequestTicket) {
      if (!isCurrentSwitch(ticket)) return false;
      activeWorkspaceId = ticket.workspaceId;
      pendingSwitch = null;
      return true;
    },
    failSwitch(ticket: CoreRequestTicket) {
      if (!isCurrentSwitch(ticket)) return false;
      pendingSwitch = null;
      return true;
    },
  };
}
