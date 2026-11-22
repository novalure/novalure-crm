import assert from "node:assert/strict";
import {test} from "node:test";
import {websiteStudioBody,websiteStudioRenderedResponse} from "../src/lib/website-sales-studio-http";
import type {WebsiteDemoArtifact} from '../src/lib/website-sales-studio';
import {createHash} from 'node:crypto';
test("Studio body bounds count UTF-8 bytes and cancel the underlying stream",async()=>{let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify({finding:"ä".repeat(40)})));},cancel(){cancelled=true;}});const request=new Request("http://localhost/api/crm/website-sales/studio",{method:"POST",body:stream,duplex:"half"} as RequestInit);await assert.rejects(websiteStudioBody(request,32),{code:"PAYLOAD_TOO_LARGE",status:413});assert.equal(cancelled,true);});
test('protected raster response serves exact decoded bytes and preserves strict sandbox policy',async()=>{
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kXkAAAAASUVORK5CYII=','base64'),sha256=createHash('sha256').update(bytes).digest('hex');
 const artifact={content:{assets:[{path:`hero-${sha256}.png`,mediaType:'image/png',bodyEncoding:'BASE64',body:bytes.toString('base64'),sha256}]}} as unknown as WebsiteDemoArtifact;
 const response=websiteStudioRenderedResponse(artifact,artifact.content.assets[0]!.path);
 assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'private, no-store');
 assert.match(response.headers.get('content-security-policy')!,/script-src 'none'/);assert.match(response.headers.get('content-security-policy')!,/sandbox allow-same-origin/);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 assert.equal(websiteStudioRenderedResponse(artifact,'foreign.png').status,404);
 assert.throws(()=>websiteStudioRenderedResponse({...artifact,content:{...artifact.content,assets:[{...artifact.content.assets[0]!,body:Buffer.from('tampered').toString('base64')}]}} as WebsiteDemoArtifact,artifact.content.assets[0]!.path),/RASTER_DIGEST/);
});
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
