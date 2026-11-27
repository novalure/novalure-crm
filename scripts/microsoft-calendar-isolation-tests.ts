import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppSession } from "../src/lib/auth/session";

const moduleUrl = (path: string) => pathToFileURL(resolve(process.cwd(), path)).href;
let workspaceToken: "missing" | "unavailable" | "connected" = "missing";
let reads = 0;
let connected = false;
let calendarResponse: (() => Response) | null = null;
let deleteResponseStatus = 204;
mock.module(moduleUrl("src/lib/integrations/calendar-connections.ts"), {namedExports: {
  getCalendarAccessToken: async () => {
    reads++;
    if (workspaceToken === "unavailable") throw new Error("synthetic workspace connection unavailable");
    return workspaceToken === "connected" ? "synthetic-workspace-token" : null;
  },
} });
mock.module(moduleUrl("src/lib/db/crm-operational-readers.ts"), {namedExports: {
  readCalendarConnectionStatuses: async () => ({microsoft:{connected,accountLabel:"synthetic",scopes:["Calendars.ReadWrite"]}}),
} });
type Calendar = typeof import("../src/lib/integrations/microsoft-calendar");
let calendar: Calendar;
before(async () => { calendar = await import("../src/lib/integrations/microsoft-calendar"); });

const keys = ["MICROSOFT_GRAPH_ACCESS_TOKEN", "MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_CALENDAR_USER_ID", "MICROSOFT_GRAPH_USER_ID"] as const;
async function withGlobalCredentials(direct: boolean, run: (calls: string[]) => Promise<void>) {
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {MICROSOFT_TENANT_ID:"synthetic-tenant",MICROSOFT_CLIENT_ID:"synthetic-client",
    MICROSOFT_CLIENT_SECRET:"synthetic-secret",MICROSOFT_CALENDAR_USER_ID:"synthetic-organizer"});
  if (direct) process.env.MICROSOFT_GRAPH_ACCESS_TOKEN = "synthetic-global-token";
  globalThis.fetch = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (String(url).includes("login.microsoftonline.com")) return Response.json({access_token:"synthetic-app-token"});
    if (init?.method === "DELETE") return new Response(null, {status:deleteResponseStatus});
    if (calendarResponse && String(url).includes("/calendarView")) return calendarResponse();
    return Response.json(init?.method === "POST" ? {id:"synthetic-event"} : {value:[]});
  };
  try { await run(calls); } finally {
    calendarResponse = null;
    deleteResponseStatus = 204;
    globalThis.fetch = previousFetch;
    for (const [key,value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

const event = {subject:"Synthetic", startsAt:"2030-01-01T09:00:00Z", endsAt:"2030-01-01T09:30:00Z"};
for (const direct of [true, false]) for (const state of ["missing", "unavailable"] as const) {
  test(`workspace ${state} never invokes ${direct ? "direct token" : "app credentials"} for any calendar operation`, async () => {
    await withGlobalCredentials(direct, async (calls) => {
      workspaceToken=state; reads=0; const workspaceId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      assert.equal((await calendar.syncMicrosoftCalendarEvent({...event,workspaceId})).status,"failed");
      assert.equal((await calendar.updateMicrosoftCalendarEvent({...event,eventId:"synthetic",workspaceId})).status,"failed");
      assert.equal((await calendar.deleteMicrosoftCalendarEvent({eventId:"synthetic",workspaceId})).status,"failed");
      await assert.rejects(calendar.listMicrosoftBusyTimes({timeMin:event.startsAt,timeMax:event.endsAt,workspaceId}), /calendar_availability_unavailable/);
      assert.equal(reads,4); assert.deepEqual(calls,[]);
    });
  });
}
test("an explicitly empty workspace cannot select ambient credentials", async () => {
  await withGlobalCredentials(true, async calls => {
    reads=0; assert.equal((await calendar.syncMicrosoftCalendarEvent({...event,workspaceId:""})).status,"failed");
    assert.equal(reads,0); assert.deepEqual(calls,[]);
  });
});
test("workspace availability distinguishes empty from HTTP failure, malformed or truncated responses", async () => {
  await withGlobalCredentials(false, async () => {
    workspaceToken="connected";
    const query={workspaceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",timeMin:event.startsAt,timeMax:event.endsAt};
    for(const response of [()=>new Response('{}',{status:503}),()=>new Response('not json',{status:200}),()=>Response.json({}),()=>Response.json({value:[],"@odata.nextLink":"https://graph.microsoft.com/next"}),()=>Response.json({value:[{showAs:'busy',start:{dateTime:'invalid'},end:{dateTime:'invalid'}}]})]){
      calendarResponse=response; await assert.rejects(calendar.listMicrosoftBusyTimes(query),/calendar_availability_unavailable/);
    }
    calendarResponse=()=>Response.json({value:[]}); assert.deepEqual(await calendar.listMicrosoftBusyTimes(query),[]);
    calendarResponse=()=>Response.json({value:[{showAs:'busy',start:{dateTime:'2030-01-01T09:00:00',timeZone:'UTC'},end:{dateTime:'2030-01-01T09:30:00',timeZone:'UTC'}}]});
    assert.deepEqual(await calendar.listMicrosoftBusyTimes(query),[{start:'2030-01-01T09:00:00.000Z',end:'2030-01-01T09:30:00.000Z'}]);
  });
});
test("a connected workspace uses its personal token and never the app token endpoint", async () => {
  await withGlobalCredentials(false, async calls => {
    workspaceToken="connected";
    assert.equal((await calendar.syncMicrosoftCalendarEvent({...event,workspaceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})).status,"synced");
    assert.equal(calls.length,1); assert.match(calls[0],/graph\.microsoft\.com\/v1\.0\/me\/calendar\/events/);
  });
});
test("workspace cancellation requires Graph to confirm deletion in its own calendar", async () => {
  await withGlobalCredentials(true, async calls => {
    workspaceToken = "connected";
    const request = {eventId: "synthetic-event", workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
    deleteResponseStatus = 404;
    const missing = await calendar.deleteMicrosoftCalendarEvent(request);
    assert.equal(missing.status, "failed");
    assert.equal(missing.error, "calendar_delete_unconfirmed");
    deleteResponseStatus = 204;
    assert.equal((await calendar.deleteMicrosoftCalendarEvent(request)).status, "synced");
    assert.deepEqual(calls, Array(2).fill("DELETE https://graph.microsoft.com/v1.0/me/calendar/events/synthetic-event"));
  });
});
test("an explicitly unscoped calendar cancellation still accepts a missing event", async () => {
  await withGlobalCredentials(true, async () => {
    deleteResponseStatus = 404;
    assert.equal((await calendar.deleteMicrosoftCalendarEvent({eventId: "synthetic-event"})).status, "synced");
  });
});
for (const direct of [true, false]) test(`explicitly unscoped ${direct ? "direct-token" : "app-credentials"} behavior remains available`, async () => {
  await withGlobalCredentials(direct, async calls => {
    assert.equal((await calendar.syncMicrosoftCalendarEvent(event)).status,"synced");
    assert.equal(calls.length,direct?1:2);
    if (!direct) assert.match(calls[0],/login\.microsoftonline\.com/);
  });
});
test("Studio app-token access remains bound to its configured organizer", async () => {
  await withGlobalCredentials(false, async calls => {
    assert.equal(await calendar.getMicrosoftCalendarAppToken("other-organizer"),null);
    assert.deepEqual(calls,[]);
    assert.equal(await calendar.getMicrosoftCalendarAppToken("synthetic-organizer"),"synthetic-app-token");
    assert.equal(calls.length,1);
  });
});
test("workspace status reports its connection, not configured global credentials", async () => {
  await withGlobalCredentials(true, async () => {
    connected=false;
    const status=await calendar.getWorkspaceMicrosoftCalendarProviderStatus({} as AppSession);
    assert.equal(status.configured,false); assert.equal(status.accountLabel,null); assert.equal(status.mode,"not-configured");
    connected=true;
    assert.equal((await calendar.getWorkspaceMicrosoftCalendarProviderStatus({} as AppSession)).mode,"workspace-oauth");
  });
});
