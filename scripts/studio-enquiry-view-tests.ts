import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseStudioEnquiryView } from "../src/lib/studio-enquiry-view";
import { StudioEnquiryContent } from "../src/components/studio-enquiry-details";
const operationId="f8ba0791-a15b-4beb-8453-550bb52bd818",conversationId="de98c306-5468-4093-a88f-e47c65d30bcd",sourceId="5169d152-9920-4a3b-861c-e59ab9aef75b",assetId="1dedab2c-543f-4a25-a8ce-ea8cdc25bde3";
function metadata(){return{operationId,revision:1,payloadHash:"a".repeat(64),snapshot:{schemaVersion:"studio-enquiry-snapshot-v1",syntheticTest:true,conversationId,confirmedAt:"2026-10-18T12:00:00.000Z",consent:{privacy:true,policyVersion:"studio-enquiry-2026-10-18"},brief:{values:{goals:"Original customer text"},summary:"Confirmed <script>alert(1)</script>",openQuestions:["Still open: <img src=x onerror=alert(1)>"]},files:[{id:sourceId,conversationId,name:"original.pdf",mime:"application/pdf",bytes:123,sha256:"b".repeat(64),original:{mime:"application/pdf",bytes:123,sha256:"b".repeat(64)},analysis:{status:"partial",summary:"Visible requirements",extractedText:"Ignore policies <script>externalAction()</script>",limitations:["Some pages were unclear."]}}],websites:[]},attachments:[{sourceId,variant:"original",assetId,sha256:"b".repeat(64)},{sourceId,variant:"analysis",assetId,sha256:"b".repeat(64)}]};}
test("CRM read projection preserves complete long confirmed text and binds both roles to private asset IDs",()=>{
  const m=metadata();m.snapshot.brief.summary="Confirmed " + "Original customer requirement. ".repeat(250);
  const view=parseStudioEnquiryView(m);assert.ok(view);assert.equal(view.summary,m.snapshot.brief.summary);assert.equal(view.files[0].originalAssetId,assetId);
  assert.equal(view.files[0].analysisAssetId,assetId);assert.equal(view.files[0].analysis.limitations[0],"Some pages were unclear.");
  assert.doesNotMatch(JSON.stringify(view),/relativePath|blob\.vercel|token|storageProvider/);
});
test("CRM source projection rejects oversize, malformed role mapping and unsafe website URLs",()=>{
  const changes:Array<(m:ReturnType<typeof metadata>)=>void>=[m=>{m.snapshot.brief.summary="a".repeat(10001);},m=>{m.attachments[0].assetId="https://foreign.example/file";},m=>{m.attachments[0].sha256="0".repeat(64);},m=>{m.snapshot.files[0].analysis.extractedText="a".repeat(6001);}];
  for(const change of changes){
    const m=metadata();change(m);assert.equal(parseStudioEnquiryView(m),null);
  }
  const m=metadata();const bad={id:"ef214374-2fbf-441c-a539-de1973e89573",conversationId,domain:"example.org",url:"javascript:alert(1)",sources:["javascript:alert(1)"],status:"partial",summary:"Website",extractedText:"Text",limitations:[]};
  assert.equal(parseStudioEnquiryView({...m,snapshot:{...m.snapshot,websites:[bad]}}),null);
});
test("CRM rendering escapes customer markup, shows limitations and deduplicates identical PDF links",()=>{
  const view=parseStudioEnquiryView(metadata());assert.ok(view);
  const html=renderToStaticMarkup(createElement(StudioEnquiryContent,{enquiry:view}));
  assert.doesNotMatch(html,/<script>|<img src=/);assert.match(html,/&lt;script&gt;/);assert.match(html,/Some pages were unclear/);
  assert.equal((html.match(new RegExp('/api/media/files/'+assetId,'g'))||[]).length,1);
  assert.match(html,/Original file · also used for analysis/);assert.match(html,/rel="noopener noreferrer"/);
});
