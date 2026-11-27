import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {MediaAsset} from '../src/lib/media-store';
import type {WebExposeSnapshot} from '../src/lib/web-expose';
import {buildPublicWebExposePdf,publicWebExposePdfResponse} from '../src/lib/web-expose-pdf';

const token='A'.repeat(43);
test('117 public gallery photos keep the PDF limited while retaining approved floor plans',async()=>{
  const png=await sharp({create:{width:32,height:32,channels:3,background:'#159678'}}).png().toBuffer();
  const ids:string[]=Array.from({length:117},()=>randomUUID()),planId=randomUUID(),docId=randomUUID(),workspaceId=randomUUID();
  const media=ids.map((assetId,i)=>({id:randomUUID(),kind:'image' as const,assetId,title:`Synthetic photo ${i+1}`}));
  const snapshot:WebExposeSnapshot={schemaVersion:1,language:'de',locale:'de-AT',countryCode:'AT',title:'Synthetic apartment',description:'Synthetic description',location:'Synthetic area',price:null,priceVisibility:'price_on_request',facts:[],media,
    resources:[{id:randomUUID(),kind:'floorplan',assetId:planId,url:null,title:'Synthetic floor plan',mimeType:'image/png'},{id:randomUUID(),kind:'document',assetId:docId,url:null,title:'Synthetic document',mimeType:'application/pdf'}],units:[],contact:{name:'',email:'',phone:''},privacyUrl:'https://example.invalid/privacy',legalUrl:'https://example.invalid/legal',controller:'Synthetic Agency',publishedAt:'2026-11-25T12:00:00Z'};
  const data={versionId:randomUUID(),snapshot,intendedRecipient:false};
  const asset=(id:string):MediaAsset=>({id,workspaceId,name:'synthetic',originalName:'synthetic',folder:'synthetic',mimeType:id===docId?'application/pdf':'image/png',sizeBytes:png.length,url:'',relativePath:'synthetic',storageProvider:'local',storageAccess:'private',createdAt:'2026-11-25T12:00:00Z',hasActivePublicShare:false,isPublic:false});
  const fetched:string[]=[],readIds:string[]=[];
  const opts={origin:'https://example.invalid',lookup:async()=>data,asset:async(_token:string,id:string)=>{fetched.push(id);return asset(id);},read:async(a:MediaAsset)=>{readIds.push(a.id);return {body:Buffer.from(png),contentType:a.mimeType,sizeBytes:png.length};}};
  const {bytes}=await buildPublicWebExposePdf(token,opts);
  assert.equal(readIds.filter(id=>ids.includes(id)).length,20);
  assert.ok(readIds.includes(planId));
  assert.ok(!readIds.includes(docId));
  assert.ok(!fetched.includes(ids[20]));
  assert.ok(fetched.includes(docId));
  assert.ok((await PDFDocument.load(bytes)).getPageCount()>1);
  const task=getDocument({data:Uint8Array.from(bytes),useSystemFonts:false,disableFontFace:true});
  const pdf=await task.promise;
  let text='';for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);text+=(await page.getTextContent()).items.map(item=>'str'in item?item.str:'').join(' ');}
  await task.destroy();
  assert.match(text,/Weitere Bilder findest du im Online-Expos/);
});

test('revocation during a bounded PDF still prevents a response',async()=>{
  const data={versionId:randomUUID(),snapshot:{schemaVersion:1,language:'de',locale:'de-AT',countryCode:'AT',title:'Synthetic apartment',description:'',location:'Synthetic area',price:null,facts:[],media:[],units:[],contact:{name:'',email:'',phone:''},privacyUrl:'https://example.invalid/privacy',legalUrl:'https://example.invalid/legal',controller:'Synthetic Agency',publishedAt:'2026-11-25T12:00:00Z'} as WebExposeSnapshot,intendedRecipient:false};
  let calls=0;
  const response=await publicWebExposePdfResponse(token,{origin:'https://example.invalid',lookup:async()=>++calls===1?data:null});
  assert.equal(response.status,404);
  assert.notEqual(response.headers.get('content-type'),'application/pdf');
});
