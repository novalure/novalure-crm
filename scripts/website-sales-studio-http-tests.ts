import assert from "node:assert/strict";
import {test} from "node:test";
import {websiteStudioBody} from "../src/lib/website-sales-studio-http";
test("Studio body bounds count UTF-8 bytes and cancel the underlying stream",async()=>{let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify({finding:"ä".repeat(40)})));},cancel(){cancelled=true;}});const request=new Request("http://localhost/api/crm/website-sales/studio",{method:"POST",body:stream,duplex:"half"} as RequestInit);await assert.rejects(websiteStudioBody(request,32),{code:"PAYLOAD_TOO_LARGE",status:413});assert.equal(cancelled,true);});
test("Studio does not execute a valid JSON prefix when an unfinished body stream times out",{timeout:15000},async()=>{let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{"potentiallyValid":true}'));},cancel(){cancelled=true;}});const request=new Request("http://localhost/api/crm/website-sales/studio",{method:"POST",body:stream,duplex:"half"} as RequestInit);await assert.rejects(websiteStudioBody(request),{code:"BODY_TIMEOUT",status:408});assert.equal(cancelled,true);});


test("preview exchange binds configured external origin and secure cookies despite an internal proxy URL", async()=>{
 const {websiteStudioExchangeOrigin}=await import("../src/lib/website-sales-studio-http");
 const make=(origin?:string,site="same-origin")=>new Request("http://localhost:3000/api/public/website-sales-studio/exchange",{method:"POST",headers:{...(origin?{origin}:{}),"sec-fetch-site":site}});
 const external=websiteStudioExchangeOrigin(make("https://crm.example"),"https://crm.example");
 assert.equal(external?.origin,"https://crm.example");assert.equal(external?.protocol,"https:");
 assert.equal(websiteStudioExchangeOrigin(make(),"https://crm.example"),null);
 assert.equal(websiteStudioExchangeOrigin(make("https://evil.example"),"https://crm.example"),null);
 assert.equal(websiteStudioExchangeOrigin(make("https://crm.example","cross-site"),"https://crm.example"),null);
 assert.equal(websiteStudioExchangeOrigin(make("null"),"https://crm.example"),null);
 assert.equal(websiteStudioExchangeOrigin(make("https://crm.example"),"invalid origin"),null);
 const local=new Request("http://localhost:3000/api/public/website-sales-studio/exchange",{method:"POST",headers:{origin:"http://127.0.0.1:62190","sec-fetch-site":"same-origin"}});
 assert.equal(websiteStudioExchangeOrigin(local,"http://127.0.0.1:62190")?.origin,"http://127.0.0.1:62190");
});
