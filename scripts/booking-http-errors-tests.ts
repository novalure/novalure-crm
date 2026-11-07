import assert from "node:assert/strict";
import test from "node:test";
import { bookingFailure } from "../src/app/api/booking/_http";
import { BookingConnectionError } from "../src/lib/booking/connections";
import { BookingError } from "../src/lib/booking/types";

test("a missing calendar keeps its actionable conflict code across the shared booking error boundary", async () => {
  const response = bookingFailure(new BookingConnectionError("calendar_not_connected"));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "calendar_not_connected" });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("a connection infrastructure failure retains its unavailable status", async () => {
  const response = bookingFailure(new BookingConnectionError("calendar_encryption_unavailable", 503));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "calendar_encryption_unavailable" });
});

test("ordinary booking errors retain their existing status and unknown internals stay private", async () => {
  const conflict = bookingFailure(new BookingError("slot_unavailable", 409));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "slot_unavailable" });
  const unknown = bookingFailure(new Error("SYNTHETIC PRIVATE INTERNAL DETAIL"));
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), { error: "booking_unavailable" });
});
