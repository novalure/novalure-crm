import type { AppSession } from "@/lib/auth/session";
import { hasProductCapability } from "@/lib/product-model";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// These predicates describe the session shape and product permissions. They do
// not authenticate a cookie: withCrmRead must still revalidate the session.
export function hasPersonalMailboxReviewSession(session: AppSession): boolean {
  return session.authenticated && session.source === "cookie" && !session.serviceIdentity &&
    typeof session.authIdentityId === "string" && uuid.test(session.authIdentityId) &&
    typeof session.authSessionId === "string" && uuid.test(session.authSessionId);
}

export function canSuppressReviewedMailboxAddress(session: AppSession): boolean {
  return hasPersonalMailboxReviewSession(session) && session.productRole !== "external_partner" &&
    session.permissions.includes("settings:manage") && hasProductCapability(session.productRole, "settings:manage");
}
