type Pending = { body: string; method: string; key: string; correlation: string; unknown: boolean; inFlight: boolean };
const pending = new Map<string, Pending>();
const unknownMessage = "CRM_RESULT_UNKNOWN: Ergebnis noch ungeklärt. Ursprünglichen Vorgang abgleichen; keine neue Aktion auslösen.";
/** Memory-only transport state; never a business store, cross-tab lock or production delivery claim. */
export async function safeSalesFetch(target: string, init: RequestInit, perform: (target: string, init: RequestInit) => Promise<Response>) {
  const method = (init.method ?? "GET").toUpperCase();
  const path = target.split("?")[0];
  if (!/^(?:\/api\/crm\/(?:contacts|tasks|projects|leads|deals)(?:\/[0-9a-f-]+\/stage)?|\/api\/crm\/offers)$/.test(path) || !["POST", "PATCH", "DELETE"].includes(method)) return perform(target, init);
  if (typeof init.body !== "string") throw new Error("CRM writes require a JSON body");
  const body = JSON.stringify(JSON.parse(init.body));
  const existing = pending.get(target);
  const intent = (value: string) => { const object = JSON.parse(value) as Record<string, unknown>; delete object.idempotencyKey; delete object.correlationId; return JSON.stringify(object); };
  if (existing?.inFlight || (existing && (intent(existing.body) !== intent(body) || existing.method !== method))) throw new Error(unknownMessage);
  const headers = new Headers(init.headers), parsed = JSON.parse(body) as Record<string, unknown>;
  const attempt = existing ?? { body, method, key: headers.get("Idempotency-Key") ?? (typeof parsed.idempotencyKey === "string" ? parsed.idempotencyKey : crypto.randomUUID()), correlation: headers.get("X-Correlation-Id") ?? (typeof parsed.correlationId === "string" ? parsed.correlationId : crypto.randomUUID()), unknown: false, inFlight: false };
  const metadata = { "Content-Type": "application/json", "Idempotency-Key": attempt.key, "X-Correlation-Id": attempt.correlation };
  const reconcile = async () => {
    const query = target.includes("?") ? target.slice(target.indexOf("?")) : "";
    const response = await perform("/api/crm/commands/reconcile" + query, { method: "POST", headers: metadata, body: JSON.stringify({ target, method, body: JSON.parse(attempt.body) }) });
    if (!response.ok) throw new Error(unknownMessage);
    const result = await response.json() as { status: string; response?: { body: unknown; status: number } };
    if (result.status !== "COMMITTED" || !result.response) throw new Error(unknownMessage);
    pending.delete(target);
    return Response.json(result.response.body, { status: result.response.status });
  };
  pending.set(target, attempt); attempt.inFlight = true;
  try {
    if (attempt.unknown) return await reconcile();
    Object.entries(metadata).forEach(([key, value]) => headers.set(key, value));
    let response: Response | undefined;
    try {
      response = await perform(target, { ...init, body: attempt.body, method, headers });
      if (response.status >= 500) attempt.unknown = true;
      else if (response.ok) await response.clone().json();
    } catch { attempt.unknown = true; }
    if (attempt.unknown) return await reconcile();
    pending.delete(target);
    return response!;
  } finally { attempt.inFlight = false; }
}
