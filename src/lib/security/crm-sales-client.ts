"use client";
import { csrfFetch } from "./csrf-client";
import { safeSalesFetch } from "./crm-safe-client";
/** Explicit Sales component opt-in; global CSRF behavior is unchanged. */
export async function salesFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (typeof input === "string" && init) return safeSalesFetch(input, init, (target, options) => csrfFetch(target, options));
  return csrfFetch(input, init);
}
