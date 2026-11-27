/** Per-mounted-view request fencing. This does not cancel provider or server work. */
export function createMailboxViewFence() {
  let generation = 0;
  return {
    begin: () => ++generation,
    invalidate: () => { generation++; },
    isCurrent: (ticket: number) => ticket === generation,
  };
}
export async function applyMailboxView<T>(fence: ReturnType<typeof createMailboxViewFence>, ticket: number, pending: Promise<T>, apply: (data: T) => void) {
  const data = await pending;
  if (fence.isCurrent(ticket)) apply(data);
}
