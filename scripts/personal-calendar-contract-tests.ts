import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarOAuthResultRedirect } from "../src/lib/integrations/calendar-oauth-redirect";

test("successful calendar callback replaces an earlier error and retains the authorized scope",()=>{
  const url=calendarOAuthResultRedirect("/?workspaceId=QA&calendar_error=old&calendar_connected=microsoft#calendar","https://crm.example.test",{connected:"google"});
  assert.equal(url.origin,"https://crm.example.test");assert.equal(url.pathname,"/");assert.equal(url.hash,"#calendar");
  assert.equal(url.searchParams.get("workspaceId"),"QA");assert.equal(url.searchParams.get("calendar_connected"),"google");assert.equal(url.searchParams.has("calendar_error"),false);
});
test("failed calendar callback removes old success and duplicate error parameters",()=>{
  const url=calendarOAuthResultRedirect("/?calendar_connected=google&calendar_error=old&calendar_error=older#calendar","https://crm.example.test",{error:"consent denied"});
  assert.equal(url.searchParams.has("calendar_connected"),false);assert.deepEqual(url.searchParams.getAll("calendar_error"),["consent denied"]);
});
test("calendar callback keeps the existing safe local redirect boundary",()=>{
  for(const target of ["https://other.example.test/#calendar","//other.example.test/","/api/unsafe","/login"]){
    const url=calendarOAuthResultRedirect(target,"https://crm.example.test",{connected:"microsoft"});
    assert.equal(url.origin,"https://crm.example.test");assert.equal(url.pathname,"/");assert.equal(url.hash,"#calendar");
  }
});
