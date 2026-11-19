// Private, resource-bounded structural inspection. This is not an antivirus claim.
/* eslint-disable @typescript-eslint/no-require-imports -- Isolated private CommonJS worker. */
const {parentPort,workerData}=require('node:worker_threads');
globalThis.fetch=async()=>{throw new Error('external fetch denied');};
(async()=>{
 const bytes=Buffer.from(workerData.bytes),type=workerData.mimeType;
 if(type==='application/pdf'){
  const {preflightPdf,assertNoPdfOpenAction}=require('./crm-mailbox-pdf-preflight.cjs');
  await preflightPdf(bytes);
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=pdfjs.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,disableFontFace:true,useSystemFonts:false,disableAutoFetch:true,disableStream:true,stopAtErrors:true});
  const pdf=await task.promise;
  try{
   if(pdf.numPages<1||pdf.numPages>50||await pdf.getJSActions()||await pdf.getAttachments())throw new Error('active');
   assertNoPdfOpenAction(await pdf.getOpenAction());
   for(let i=1;i<=pdf.numPages;i++){
    const page=await pdf.getPage(i);if(await page.getJSActions()||(await page.getAnnotations()).length)throw new Error('active');
    page.cleanup();
   }
   parentPort.postMessage({ok:true,bytes:new Uint8Array(bytes),mimeType:type});
  }finally{await pdf.destroy();}
 }else if(type==='image/png'||type==='image/jpeg'){
  const sharp=require('sharp');const image=sharp(bytes,{limitInputPixels:12000000,failOn:'warning'});
  const metadata=await image.metadata();if(metadata.pages&&metadata.pages!==1||metadata.format!==(type==='image/png'?'png':'jpeg'))throw new Error('format');
  const clean=await(type==='image/png'?image.png():image.jpeg({quality:90})).toBuffer();
  if(clean.length>2097152)throw new Error('large');parentPort.postMessage({ok:true,bytes:new Uint8Array(clean),mimeType:type});
 }else throw new Error('unsupported');
})().catch(()=>parentPort.postMessage({ok:false}));
