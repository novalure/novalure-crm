import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = (path: string) => pathToFileURL(resolve(process.cwd(), path)).href;
let writes = 0;
let lookups = 0;
let providerCalls = 0;
const session = {workspaceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
const status = {configured:false,provider:"microsoft-365",external:false,accountLabel:null,
  mode:"not-configured",reason:"calendar_workspace_connection_required",scopes:[]};
mock.module(moduleUrl("src/lib/auth/session.ts"), {namedExports: {
  requirePermissionAndProductCapability: async () => ({ok:true,session}),
} });
mock.module(moduleUrl("src/lib/integrations/microsoft-calendar.ts"), {namedExports: {
  getWorkspaceMicrosoftCalendarProviderStatus: async (input: unknown) => {
    lookups++; assert.equal(input,session); return status;
  },
  syncMicrosoftCalendarEvent: async () => {providerCalls++; throw new Error("unexpected provider operation");},
} });
mock.module(moduleUrl("src/lib/db/runtime-repositories.ts"), {namedExports: {
  listCalendarSyncEvents: async () => [],
  upsertProviderConnection: async (input: {status:string}) => {writes++; assert.equal(input.status,"not_configured"); return null;},
  insertCalendarSyncEvent: async () => {writes++; throw new Error("unexpected write");},
  writeAuditLog: async () => {writes++; throw new Error("unexpected audit");},
} });
let route: typeof import("../src/app/api/calendar/microsoft/route");
before(async () => { route = await import("../src/app/api/calendar/microsoft/route"); });

test("POST refuses a workspace without an approved calendar before provider or writes", async () => {
  writes=lookups=providerCalls=0;
  const response=await route.POST(new Request("https://crm.example.invalid/api/calendar/microsoft", {
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({subject:"Synthetic",startsAt:"2030-01-01T09:00:00Z",endsAt:"2030-01-01T09:30:00Z"}),
  }));
  assert.equal(response.status,409); assert.equal((await response.json()).error,"calendar_workspace_connection_required");
  assert.equal(lookups,1); assert.equal(providerCalls,0); assert.equal(writes,0);
});
test("GET reports the scoped connection status", async () => {
  writes=lookups=providerCalls=0;
  const response=await route.GET(new Request("https://crm.example.invalid/api/calendar/microsoft"));
  assert.equal(response.status,200); const payload=await response.json();
  assert.equal(payload.provider.configured,false); assert.equal(payload.provider.accountLabel,null);
  assert.equal(lookups,1); assert.equal(providerCalls,0); assert.equal(writes,1);
});
