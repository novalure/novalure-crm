import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "../src/app/api/version/route";

test("version endpoint exposes only reproducible non-secret deployment metadata", async () => {
  const response = GET();
  assert.equal(response.headers.get("cache-control"), "public, no-store, max-age=0");
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), [
    "applicationVersion",
    "branch",
    "buildTimestamp",
    "deploymentId",
    "gitSha",
  ]);
  assert.equal(Object.values(body).every(value => value === null || typeof value === "string"), true);
});
