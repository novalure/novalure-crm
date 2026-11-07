"use client";
import { csrfFetch } from "./csrf-client";
import { safeSalesFetch, type SalesResponseValidator } from "./crm-safe-client";
/** Explicit Sales component opt-in; global CSRF behavior is unchanged. */
export async function salesFetch(input: RequestInfo | URL, init?: RequestInit, validate?: SalesResponseValidator) {
  if (typeof input === "string" && init) return safeSalesFetch(input, init, (target, options) => csrfFetch(target, options), validate);
  return csrfFetch(input, init);
}
