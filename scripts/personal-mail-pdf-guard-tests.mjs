import assert from 'node:assert/strict';
import {test} from 'node:test';
import pdfLib from 'pdf-lib';
import preflight from '../src/lib/crm-mailbox-pdf-preflight.cjs';
const {PDFContext,PDFDocument,PDFName,PDFNull}=pdfLib;
const {assertPassivePdfObjects,assertNoPdfOpenAction,preflightPdf}=preflight;
const catalog=()=>PDFContext.create().obj({Type:'Catalog'});
test('passive catalog dictionaries are accepted as direct or already enumerated roots',()=>{
 const root=catalog();assert.doesNotThrow(()=>assertPassivePdfObjects(root,[]));
 assert.doesNotThrow(()=>assertPassivePdfObjects(root,[[null,root]]));
});
test('resolved direct catalog is checked using a marker-only mock with no action contents',()=>{
 const root=catalog();root.set(PDFName.of('OpenAction'),PDFNull);
 assert.throws(()=>assertPassivePdfObjects(root,[]),/ACTIVE/);
});
test('already enumerated catalog and other indirect objects keep the same marker rejection',()=>{
 const root=catalog(),marker=PDFContext.create().obj({});
 marker.set(PDFName.of('AA'),PDFNull);
 assert.throws(()=>assertPassivePdfObjects(root,[[null,marker]]),/ACTIVE/);
 root.set(PDFName.of('OpenAction'),PDFNull);
 assert.throws(()=>assertPassivePdfObjects(root,[[null,root]]),/ACTIVE/);
});
test('renderer action summaries accept only absence, independent of Map or object shape',()=>{
 assert.doesNotThrow(()=>assertNoPdfOpenAction(null));
 assert.doesNotThrow(()=>assertNoPdfOpenAction(undefined));
 for(const value of [new Map(),new Map([['action','mock-marker']]),{action:'mock-marker'},{}])
  assert.throws(()=>assertNoPdfOpenAction(value),/ACTIVE/);
});
test('unsupported roots and existing object and nesting bounds remain closed',()=>{
 assert.throws(()=>assertPassivePdfObjects(null,[]),/INVALID/);
 assert.throws(()=>assertPassivePdfObjects(catalog(),Array.from({length:20001},()=>[null,PDFNull])),/LIMIT/);
 const ctx=PDFContext.create(),root=catalog();let nested=ctx.obj([]);
 for(let i=0;i<32;i++)nested=ctx.obj([nested]);
 root.set(PDFName.of('PassiveMock'),nested);
 assert.throws(()=>assertPassivePdfObjects(root,[]),/LIMIT/);
});
test('an ordinary passive one-page PDF still passes the full stream preflight',async()=>{
 const doc=await PDFDocument.create();doc.addPage([100,100]);
 const bytes=await doc.save();
 await assert.doesNotReject(()=>preflightPdf(Buffer.from(bytes)));
});
