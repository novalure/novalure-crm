import "server-only";
import type { DrivingRouter } from "./travel";
import { TravelCheckError } from "./travel";

type Json = Record<string, unknown>;
const object = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};

/** No route response is persisted. Deduplication is limited to this operation. */
export function createGoogleMapsRouter(options: { fetcher?: typeof fetch; maxRequests?: number; apiKey?: string; now?: () => number } = {}): DrivingRouter {
  const cache = new Map<string, Promise<{ minutes: number }>>();
  let requests = 0;
  return async input => {
    const key = JSON.stringify([input.origin, input.destination, input.departureTime]);
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const apiKey = options.apiKey ?? process.env.GOOGLE_MAPS_ROUTES_API_KEY;
      if (!apiKey) throw new TravelCheckError("MAPS_NOT_CONFIGURED");
      if (++requests > (options.maxRequests ?? 80)) throw new TravelCheckError("MAPS_REQUEST_BUDGET");
      if (Date.parse(input.departureTime) < (options.now?.() ?? Date.now())) throw new TravelCheckError("TRAVEL_DEPARTURE_PAST");
      let response: Response;
      try {
        response = await (options.fetcher ?? fetch)("https://routes.googleapis.com/directions/v2:computeRoutes", {
          method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
          headers: {
            "Content-Type": "application/json", "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": "routes.duration,geocodingResults.origin,geocodingResults.destination,fallbackInfo",
          },
          body: JSON.stringify({ origin: { address: input.origin }, destination: { address: input.destination },
            travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", departureTime: input.departureTime }),
        });
      } catch { throw new TravelCheckError("MAPS_UNAVAILABLE"); }
      if (!response.ok) throw new TravelCheckError(response.status === 401 || response.status === 403 ? "MAPS_ACCESS_DENIED" : "MAPS_UNAVAILABLE");
      let data: Json;
      try { data = object(await response.json()); } catch { throw new TravelCheckError("MAPS_INVALID_RESPONSE"); }
      // A traffic fallback cannot prove the requested departure-time prognosis.
      if (data.fallbackInfo !== undefined) throw new TravelCheckError("MAPS_TRAFFIC_UNAVAILABLE");
      const geocoding = object(data.geocodingResults);
      for (const point of [geocoding.origin, geocoding.destination]) {
        const place = object(point), status = object(place.geocoderStatus);
        const types = Array.isArray(place.type) ? place.type : [];
        if (place.partialMatch === true || typeof place.placeId !== "string" || !place.placeId ||
          status.code !== undefined && status.code !== 0 ||
          !types.some(type => ["street_address", "premise", "subpremise", "establishment", "point_of_interest"].includes(String(type)))) {
          throw new TravelCheckError("ADDRESS_AMBIGUOUS");
        }
      }
      const routes = Array.isArray(data.routes) ? data.routes : [];
      const duration = object(routes[0]).duration;
      if (typeof duration !== "string" || !/^\d+(?:\.\d+)?s$/.test(duration)) throw new TravelCheckError("ROUTE_UNAVAILABLE");
      const seconds = Number(duration.slice(0, -1));
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) throw new TravelCheckError("ROUTE_UNAVAILABLE");
      return { minutes: Math.ceil(seconds / 60) };
    })();
    cache.set(key, pending);
    return pending;
  };
}
