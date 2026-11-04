import 'server-only';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import {PDFDocument as EditablePdf,PDFName,type PDFPage} from 'pdf-lib';
import sharp from 'sharp';
import {lookupWebExpose,validWebExposeToken,webExposeHash} from '@/lib/db/web-expose-repository';
import {queryOne} from '@/lib/db/client';
import {readMediaAssetContent,type MediaAsset} from '@/lib/media-store';
import {getTrustedAppOrigin} from '@/lib/auth/app-origin';
import {validatePropertyExposePdf} from '@/lib/property-expose-pdf-validation';
import {rasterUploadLimits} from '@/lib/media-raster-validation';
import {webExposeCopy,type WebExposePublic,type WebExposeSnapshot,type WebExposeLanguage} from '@/lib/web-expose';
import {webExposeSnapshotTemplate,webExposeTemplateSections} from '@/lib/web-expose-templates';

const PAGE={width:595.28,height:841.89,margin:44,top:88,bottom:778},WIDTH=507.28;
const COLOR={paper:'#faf9f7',ink:'#292a26',muted:'#66685f',line:'#e3e2db',accent:'#f5df79',white:'#ffffff',link:'#205c59'};
const MAX_ASSET_BYTES=10*1024*1024,MAX_INPUT_BYTES=80*1024*1024,MAX_OUTPUT_BYTES=30*1024*1024;
const copy={
 de:{eyebrow:'IMMOBILIENEXPOSÉ',energy:'Energie & Gebäude',contact:'Ihr Kontakt',documents:'Dokumente',videos:'Videos',links:'Weitere Informationen',number:'Einheit',area:'Fläche',rooms:'Zimmer',price:'Preis',status:'Status',date:'Veröffentlichter Stand',page:'Seite',open:'Online öffnen',map:'Lagekarte öffnen',enquire:'Zur Immobilie anfragen',note:'Angaben und Einheitenstatus entsprechen dem veröffentlichten Stand. Aktuelle Verfügbarkeit bitte beim Anbieter erfragen.',unknown:'Status auf Anfrage'},
 en:{eyebrow:'PROPERTY BROCHURE',energy:'Energy & building',contact:'Your contact',documents:'Documents',videos:'Videos',links:'Further information',number:'Unit',area:'Area',rooms:'Rooms',price:'Price',status:'Status',date:'Published information',page:'Page',open:'Open online',map:'Open location map',enquire:'Enquire about this property',note:'Information and unit status reflect the published version. Please ask the provider for current availability.',unknown:'Status on request'},
 es:{eyebrow:'DOSSIER DEL INMUEBLE',energy:'Energía y edificio',contact:'Su contacto',documents:'Documentos',videos:'Vídeos',links:'Más información',number:'Unidad',area:'Superficie',rooms:'Habitaciones',price:'Precio',status:'Estado',date:'Información publicada',page:'Página',open:'Abrir en línea',map:'Abrir mapa',enquire:'Consultar sobre este inmueble',note:'Los datos y el estado de las unidades corresponden a la versión publicada. Consulte la disponibilidad actual con el proveedor.',unknown:'Consultar estado'},
} as const;
const clean=(value:string)=>value.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'').replace(/[\u2010-\u2015]/gu,'-').replace(/\t/gu,' ').trim();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function externalUrl(value:string|null|undefined){try{const url=new URL(value??'');return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}}
export class WebExposePdfError extends Error {constructor(readonly status:404|503=503){super(status===404?'unavailable':'temporarily_unavailable');}}
export type WebExposePdfImage={id:string;kind:'image'|'floorplan'|'logo'|'letterhead';title:string;bytes:Uint8Array;width:number;height:number};
export type WebExposePdfPlan={id:string;title:string;bytes:Uint8Array;pageCount:number};
export type WebExposePdfLink={kind:'document'|'video'|'external_link'|'floorplan';title:string;url:string};
type RenderInput={snapshot:WebExposeSnapshot;images:WebExposePdfImage[];plans:WebExposePdfPlan[];links:WebExposePdfLink[];pageUrl:string};
type Options={origin?:string;lookup?:(token:string)=>Promise<WebExposePublic|null>;asset?:(token:string,id:string)=>Promise<MediaAsset|null>;read?:(asset:MediaAsset)=>ReturnType<typeof readMediaAssetContent>};
const defaults={lookup:lookupWebExpose,asset:async(token:string,id:string)=>(await queryOne<{data:MediaAsset|null}>('select crm_web_expose_asset($1,$2::uuid) as data',[webExposeHash(token),id]))?.data??null,read:readMediaAssetContent};

async function boundedBytes(asset:MediaAsset,read:NonNullable<Options['read']>){
 if(asset.sizeBytes<1||asset.sizeBytes>MAX_ASSET_BYTES)throw new WebExposePdfError();
 const content=await read(asset);if(!content||content.sizeBytes!==asset.sizeBytes)throw new WebExposePdfError();
 if(content.body instanceof Uint8Array){if(content.body.byteLength!==asset.sizeBytes)throw new WebExposePdfError();return content.body;}
 const reader=content.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 let timeout:ReturnType<typeof setTimeout>|undefined;
 const expired=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new WebExposePdfError()),15000);});
 try{for(;;){const item=await Promise.race([reader.read(),expired]);if(item.done)break;size+=item.value.byteLength;if(size>asset.sizeBytes||size>MAX_ASSET_BYTES)throw new WebExposePdfError();chunks.push(item.value);}}
 catch(error){void reader.cancel().catch(()=>undefined);throw error;}finally{clearTimeout(timeout);reader.releaseLock();}
 if(size!==asset.sizeBytes)throw new WebExposePdfError();return Buffer.concat(chunks,size);
}
function mediaSignature(data:WebExposePublic){return JSON.stringify({versionId:data.versionId,snapshot:data.snapshot},(key,value)=>key==='inventoryAsOf'?undefined:value);}
/** Only server-authorized snapshot content enters this document. No URL is fetched by the renderer. */
export async function renderWebExposePdf({snapshot,images,plans,links,pageUrl}:RenderInput):Promise<Uint8Array>{
 if(!['de','en','es'].includes(snapshot.language)||!clean(snapshot.title)||!Number.isFinite(Date.parse(snapshot.publishedAt))||snapshot.units.length>200||images.length>130||links.length>130)throw new WebExposePdfError();
 const language=snapshot.language as WebExposeLanguage,c=copy[language],web=webExposeCopy[language];
 const template=webExposeSnapshotTemplate(snapshot),companyName=template?.companyName??'novalure',accentColor=template?.accentColor??COLOR.accent,layout=template?.layout??'classic',grid=template?.imageGrid??1,logo=images.find(i=>i.kind==='logo'),letterhead=images.find(i=>i.kind==='letterhead');
 const [regular,semibold]=await Promise.all([readFile(path.join(process.cwd(),'src/lib/property-expose-assets/figtree-regular.ttf')),readFile(path.join(process.cwd(),'src/lib/property-expose-assets/figtree-semibold.ttf'))]);
 const date=new Intl.DateTimeFormat(snapshot.locale,{dateStyle:'medium',timeZone:'UTC'}).format(new Date(snapshot.publishedAt));
 const inventoryDate=snapshot.inventoryAsOf&&Number.isFinite(Date.parse(snapshot.inventoryAsOf))?new Intl.DateTimeFormat(snapshot.locale,{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(new Date(snapshot.inventoryAsOf))+' UTC':date;
 const showPrices=snapshot.priceVisibility!=='hide_price';
 const inventoryLabel=showPrices?(language==='de'?'Verfügbarkeit und Preise':language==='es'?'Disponibilidad y precios':'Availability and prices'):(language==='de'?'Verfügbarkeit':language==='es'?'Disponibilidad':'Availability');
 const inventoryNote=language==='de'?`Objektangaben entsprechen der veröffentlichten Version. ${showPrices?'Verfügbarkeit und Preise wurden':'Die Verfügbarkeit wurde'} zum angegebenen Zeitpunkt geprüft. Die verbindliche Bestätigung erfolgt durch den Anbieter.`:language==='es'?`Los datos del inmueble corresponden a la versión publicada. ${showPrices?'La disponibilidad y los precios se comprobaron':'La disponibilidad se comprobó'} en el momento indicado. La confirmación definitiva corresponde al proveedor.`:`Property details reflect the published version. ${showPrices?'Availability and prices were':'Availability was'} checked at the time shown. Final confirmation is provided by the provider.`;
 const sourcePlans:{page:PDFPage;title:string;width:number;height:number;rotation:number}[]=[];
 for(const plan of plans){const source=await EditablePdf.load(plan.bytes,{updateMetadata:false});if(source.getPageCount()!==plan.pageCount||source.getPageCount()>40)throw new WebExposePdfError();for(const [index,page] of source.getPages().entries()){const crop=page.getCropBox(),rotation=((page.getRotation().angle%360)+360)%360;if(![0,90,180,270].includes(rotation)||![crop.width,crop.height].every(v=>Number.isFinite(v)&&v>0&&v<=14400))throw new WebExposePdfError();sourcePlans.push({page,title:`${plan.title}${source.getPageCount()>1?` (${index+1}/${source.getPageCount()})`:''}`,width:crop.width,height:crop.height,rotation});}}
 if(sourcePlans.length>40)throw new WebExposePdfError();
 const placements:{outputPage:number;source:typeof sourcePlans[number];name:string}[]=[];
 const bytes=await new Promise<Uint8Array>((resolve,reject)=>{
  const pdf=new PDFDocument({autoFirstPage:false,bufferPages:true,size:'A4',margins:{top:0,bottom:0,left:0,right:0},pdfVersion:'1.7',tagged:true,displayTitle:true,lang:language,info:{Title:clean(snapshot.title),Author:clean(companyName),Subject:c.eyebrow,Creator:'Novalure CRM',CreationDate:new Date(snapshot.publishedAt)}}),chunks:Buffer[]=[];
  pdf.on('data',(chunk:Buffer)=>chunks.push(chunk));pdf.on('end',()=>resolve(new Uint8Array(Buffer.concat(chunks))));pdf.on('error',reject);
  try{
   pdf.registerFont('Regular',regular).registerFont('Semibold',semibold).font('Regular');
   const font=(pdf as unknown as {_font:{font:{hasGlyphForCodePoint:(point:number)=>boolean}}})._font.font;
   const visible=[companyName,snapshot.title,snapshot.description,snapshot.location,showPrices?snapshot.price??'':'',snapshot.controller,...snapshot.facts.flatMap(f=>[f.label,f.value]),...snapshot.units.flatMap(u=>[u.number,u.area,u.rooms,showPrices?u.price??'':'']),...Object.values(snapshot.contact),...images.map(i=>i.title),...sourcePlans.map(i=>i.title),...links.map(i=>i.title)];
   if(visible.reduce((n,value)=>n+value.length,0)>150000||Array.from(visible.map(clean).join(' ')).some(character=>!/\s/u.test(character)&&!font.hasGlyphForCodePoint(character.codePointAt(0)!)))throw new WebExposePdfError();
   const root=pdf.struct('Document');pdf.addStructure(root);let current=root,y=PAGE.top,pageCount=0;
   const artifact=(draw:()=>void)=>{pdf.markContent('Artifact',{type:'Layout'});draw();pdf.endMarkedContent();};
   const wrap=(value:string,size:number,width=WIDTH,bold=false)=>{pdf.font(bold?'Semibold':'Regular').fontSize(size);const lines:string[]=[];for(const paragraph of clean(value).split('\n')){if(!paragraph.trim()){lines.push('');continue;}let line='';for(const word of paragraph.trim().split(/\s+/u)){const candidate=line?`${line} ${word}`:word;if(pdf.widthOfString(candidate)<=width){line=candidate;continue;}if(line){lines.push(line);line='';}for(const char of Array.from(word)){if(line&&pdf.widthOfString(line+char)>width){lines.push(line);line='';}line+=char;}}if(line)lines.push(line);}return lines;};
   const draw=(value:string,x:number,top:number,size=10.5,width=WIDTH,tag='P',color=COLOR.ink,url?:string)=>{const lines=wrap(value,size,width,tag.startsWith('H'));current.add(pdf.struct(tag,{},()=>{pdf.font(tag.startsWith('H')?'Semibold':'Regular').fontSize(size).fillColor(color);lines.forEach((line,index)=>pdf.text(line+' ',x,top+index*size*1.45,{lineBreak:false,...(url?{link:url,underline:true}:{} )}));}));return lines.length*size*1.45;};
   const newPage=()=>{if(pageCount>=160)throw new WebExposePdfError();pdf.addPage();pageCount++;y=PAGE.top;artifact(()=>{pdf.rect(0,0,PAGE.width,PAGE.height).fill(COLOR.paper);if(letterhead){pdf.image(Buffer.from(letterhead.bytes),0,0,{fit:[PAGE.width,PAGE.height],align:'center',valign:'center'});pdf.rect(28,22,PAGE.width-56,50).fill(COLOR.paper);pdf.rect(28,76,PAGE.width-56,718).fill(COLOR.paper);pdf.rect(28,798,PAGE.width-56,26).fill(COLOR.paper);}if(logo)pdf.image(Buffer.from(logo.bytes),44,27,{fit:[100,28],valign:'center'});if(!logo)pdf.roundedRect(44,34,16,16,4).fill(accentColor);pdf.font('Semibold').fontSize(11);let brand=clean(companyName);while(pdf.widthOfString(brand)>(logo?135:220)&&brand.length>1)brand=brand.slice(0,-2)+'…';pdf.fillColor(COLOR.ink).text(brand,logo?156:68,33,{lineBreak:false});pdf.font('Regular').fontSize(8).fillColor(COLOR.muted).text(c.eyebrow,300,35,{lineBreak:false});pdf.moveTo(44,66).lineTo(551,66).lineWidth(.6).stroke(COLOR.line);});};
   const ensure=(height:number)=>{if(y+height>PAGE.bottom)newPage();};
   const heading=(value:string,followingHeight=60)=>{ensure(wrap(value,16,WIDTH,true).length*24+followingHeight);const section=pdf.struct('Sect');root.add(section);current=section;y+=draw(value,44,y,layout==='compact'?14:16,WIDTH,'H2')+(layout==='compact'?8:12);if(layout==='editorial'){artifact(()=>pdf.moveTo(44,y-6).lineTo(110,y-6).lineWidth(3).stroke(accentColor));y+=6;}};
   const paragraph=(value:string,size=10.5,color=COLOR.ink,url?:string)=>{const lines=wrap(value,size),lineHeight=size*1.45;while(lines.length){ensure(lineHeight*Math.min(2,lines.length));const block=lines.splice(0,Math.floor((PAGE.bottom-y)/lineHeight));current.add(pdf.struct('P',{},()=>{pdf.font('Regular').fontSize(size).fillColor(color);block.forEach((line,index)=>pdf.text(line+' ',44,y+index*lineHeight,{lineBreak:false,...(url?{link:url,underline:true}:{} )}));}));y+=block.length*lineHeight;if(lines.length)newPage();}y+=layout==='compact'?8:12;};
   const firstFactHeight=(facts:WebExposeSnapshot['facts'])=>Math.max(...facts.slice(0,2).map(f=>wrap(f.label,8.5,(WIDTH-12)/2-24).length*13+wrap(f.value,12,(WIDTH-12)/2-24).length*18+28))+12;
   const factRows=(facts:WebExposeSnapshot['facts'])=>{for(let index=0;index<facts.length;index+=2){const row=facts.slice(index,index+2),cell=(WIDTH-12)/2;const heights=row.map(f=>wrap(f.label,8.5,cell-24).length*13+wrap(f.value,12,cell-24).length*18+28),height=Math.max(...heights);if(height>600)throw new WebExposePdfError();ensure(height+12);row.forEach((f,i)=>{const x=44+i*(cell+12);artifact(()=>pdf.roundedRect(x,y,cell,height,8).fill(COLOR.white));const label=draw(f.label,x+12,y+10,8.5,cell-24,'P',COLOR.muted);draw(f.value,x+12,y+15+label,12,cell-24);});y+=height+12;}};
   const image=(item:WebExposePdfImage,hero=false)=>{const height=hero?(layout==='editorial'?300:layout==='compact'?190:250):item.kind==='floorplan'?500:300,captionHeight=wrap(item.title,9).length*14;if(captionHeight>100)throw new WebExposePdfError();ensure(height+captionHeight+28);artifact(()=>pdf.roundedRect(44,y,WIDTH,height,8).fill(COLOR.white));current.add(pdf.struct('Figure',{alt:clean(item.title)},()=>{pdf.image(Buffer.from(item.bytes),44,y,{fit:[WIDTH,height],align:'center',valign:'center'});}));y+=height+10;y+=draw(item.title,44,y,9,WIDTH,'Caption',COLOR.muted)+18;};
   const imageGrid=(items:WebExposePdfImage[])=>{if(grid===1){for(const item of items)image(item);return;}const gap=12,cell=(WIDTH-gap*(grid-1))/grid,height=grid===3?125:180;for(let at=0;at<items.length;at+=grid){const row=items.slice(at,at+grid),caption=Math.max(...row.map(item=>wrap(item.title,8.5,cell).length*13));ensure(height+caption+28);for(const[itemIndex,item]of row.entries()){const x=44+itemIndex*(cell+gap);artifact(()=>pdf.roundedRect(x,y,cell,height,6).fill(COLOR.white));current.add(pdf.struct('Figure',{alt:clean(item.title)},()=>pdf.image(Buffer.from(item.bytes),x,y,{fit:[cell,height],align:'center',valign:'center'})));draw(item.title,x,y+height+8,8.5,cell,'Caption',COLOR.muted);}y+=height+caption+28;}};
   newPage();if(template)paragraph(companyName,11,COLOR.muted);const titleSize=[28,24,20,18,16].find(size=>wrap(snapshot.title,size,WIDTH,true).length*size*1.45<=250);if(!titleSize)throw new WebExposePdfError();y+=draw(snapshot.title,44,y,titleSize,WIDTH,'H1')+12;
   if(snapshot.location)paragraph(snapshot.location,11,COLOR.muted);
   if(showPrices)paragraph(snapshot.price??web.priceRequest,18);
   if(snapshot.inventoryAsOf)paragraph(`${inventoryLabel}: ${inventoryDate}`,9,COLOR.muted);
   const hero=images.find(item=>item.kind==='image');if(hero)image(hero,true);
   paragraph(c.enquire,11,COLOR.link,pageUrl+'#contact');
   const energyPattern=/energie|energy|energía|energ[eé]tic|hwb|fgee|ber\b|ausweis|certif|rating|energieträger|gültig|valid|válido|ausgestellt|issued|registr|skala|scale|scheme|co2|emiss/i;
   const facts=snapshot.facts.filter(f=>!energyPattern.test(f.label)),energy=snapshot.facts.filter(f=>energyPattern.test(f.label));
   const renderLinks=(kind:WebExposePdfLink['kind'])=>{const items=links.filter(link=>link.kind===kind);if(items.length){heading(kind==='document'?c.documents:kind==='video'?c.videos:c.links);for(const link of items)paragraph(`${link.title} - ${c.open}`,10.5,COLOR.link,link.url);}};
   const sections={hero:()=>{},facts:()=>{if(facts.length){heading(web.facts,firstFactHeight(facts));factRows(facts);}if(energy.length){heading(c.energy,firstFactHeight(energy));factRows(energy);}},description:()=>{if(snapshot.description){heading(web.description);paragraph(snapshot.description);}},
   gallery:()=>{if(images.some(item=>item.kind==='image'&&item!==hero)){heading(web.gallery,grid===1?360:230);imageGrid(images.filter(item=>item.kind==='image'&&item!==hero));}},
   floorplans:()=>{if(images.some(item=>item.kind==='floorplan')||sourcePlans.length||links.some(link=>link.kind==='floorplan')){
    const firstImage=images.find(item=>item.kind==='floorplan'),firstPlan=sourcePlans[0];
    heading(web.floorplans,firstImage?500+wrap(firstImage.title,9).length*14+40:firstPlan?480+wrap(firstPlan.title,9).length*14+40:60);for(const item of images.filter(item=>item.kind==='floorplan'))image(item);
    for(const source of sourcePlans){const height=480;ensure(height+wrap(source.title,9).length*14+30);const top=y,name=`PublicFloorplan${placements.length+1}`,scale=Math.min(WIDTH/(source.rotation%180?source.height:source.width),height/(source.rotation%180?source.width:source.height));
     const width=(source.rotation%180?source.height:source.width)*scale,h=(source.rotation%180?source.width:source.height)*scale,left=44+(WIDTH-width)/2,upper=top+(height-h)/2;
     artifact(()=>pdf.roundedRect(44,top,WIDTH,height,8).fill(COLOR.white));current.add(pdf.struct('Figure',{alt:clean(source.title)},()=>{pdf.save();if(source.rotation===90)pdf.transform(0,scale,scale,0,left,upper);else if(source.rotation===180)pdf.transform(-scale,0,0,scale,left+source.width*scale,upper);else if(source.rotation===270)pdf.transform(0,-scale,-scale,0,left+source.height*scale,upper+source.width*scale);else pdf.transform(scale,0,0,-scale,left,upper+source.height*scale);pdf.addContent(`/${name} Do`);pdf.restore();}));placements.push({outputPage:pageCount-1,source,name});y+=height+10;y+=draw(source.title,44,y,9,WIDTH,'Caption',COLOR.muted)+18;
    }
    for(const link of links.filter(link=>link.kind==='floorplan'))paragraph(`${link.title} - ${c.open}`,10.5,COLOR.link,link.url);
   }},documents:()=>renderLinks('document'),videos:()=>renderLinks('video'),links:()=>renderLinks('external_link'),
   units:()=>{if(snapshot.units.length){heading(web.units);paragraph(`${inventoryLabel}: ${inventoryDate}`,9,COLOR.muted);for(const unit of snapshot.units){const status=unit.status==='available'?web.available:unit.status==='reserved'?web.reserved:unit.status==='sold'?web.sold:c.unknown;const detail=`${c.area}: ${unit.area} m²   |   ${c.rooms}: ${unit.rooms||'-'}`;const price=showPrices?unit.price??web.priceRequest:'',line=`${price?price+' | ':''}${status}`;const height=wrap(`${c.number} ${unit.number}`,12,WIDTH-24,true).length*18+wrap(detail,9,WIDTH-24).length*14+wrap(line,10,WIDTH-24).length*15+34;if(height>600)throw new WebExposePdfError();ensure(height+10);artifact(()=>pdf.roundedRect(44,y,WIDTH,height,8).fill(COLOR.white));let top=y+10;top+=draw(`${c.number} ${unit.number}`,56,top,12,WIDTH-24,'H3')+4;top+=draw(detail,56,top,9,WIDTH-24,'P',COLOR.muted)+5;draw(line,56,top,10,WIDTH-24);y+=height+10;}}},
   location:()=>{if(snapshot.location){heading(web.location);paragraph(snapshot.location);paragraph(c.map,10.5,COLOR.link,'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(snapshot.location));}},
   contact:()=>{heading(c.contact);if(snapshot.contact.name)paragraph(snapshot.contact.name,13);if(snapshot.contact.email)paragraph(snapshot.contact.email,10.5,COLOR.link,/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(snapshot.contact.email)?'mailto:'+encodeURIComponent(snapshot.contact.email):undefined);if(snapshot.contact.phone)paragraph(snapshot.contact.phone,10.5,COLOR.link,/^[+()0-9 .-]+$/.test(snapshot.contact.phone)?'tel:'+snapshot.contact.phone.replace(/[^+0-9]/g,''):undefined);paragraph(c.enquire,11,COLOR.link,pageUrl+'#contact');}};
   for(const section of template?.sectionOrder??webExposeTemplateSections)sections[section]();
   const closing=[snapshot.controller,snapshot.inventoryAsOf?inventoryNote:c.note,externalUrl(snapshot.privacyUrl)?web.privacy:'',externalUrl(snapshot.legalUrl)?web.legal:''].filter(Boolean);ensure(closing.reduce((height,text)=>height+wrap(text,9).length*9*1.45+(layout==='compact'?8:12),0));if(snapshot.controller)paragraph(snapshot.controller,9,COLOR.muted);paragraph(snapshot.inventoryAsOf?inventoryNote:c.note,9,COLOR.muted);if(externalUrl(snapshot.privacyUrl))paragraph(web.privacy,9,COLOR.link,snapshot.privacyUrl);if(externalUrl(snapshot.legalUrl))paragraph(web.legal,9,COLOR.link,snapshot.legalUrl);
   for(let index=0;index<pageCount;index++){pdf.switchToPage(index);artifact(()=>{pdf.moveTo(44,799).lineTo(551,799).lineWidth(.6).stroke(COLOR.line);pdf.font('Regular').fontSize(8).fillColor(COLOR.muted).text(`${c.date}: ${date}`,44,809,{lineBreak:false});const label=`${c.page} ${index+1} / ${pageCount}`;pdf.text(label,551-pdf.widthOfString(label),809,{lineBreak:false});});}
   root.end();pdf.end();
  }catch(error){pdf.destroy();reject(error);}
 });
 if(!placements.length)return bytes;
 const result=await EditablePdf.load(bytes,{updateMetadata:false});
 for(const placement of placements){const allowed=new Set(['/Type','/Parent','/Contents','/Resources','/MediaBox','/CropBox','/Rotate','/UserUnit']);for(const key of placement.source.page.node.keys())if(!allowed.has(key.toString()))placement.source.page.node.delete(key);const crop=placement.source.page.getCropBox(),embedded=await result.embedPage(placement.source.page,{left:crop.x,bottom:crop.y,right:crop.x+crop.width,top:crop.y+crop.height});result.getPage(placement.outputPage).node.normalizedEntries().XObject.set(PDFName.of(placement.name),embedded.ref);}
 return result.save({useObjectStreams:false,addDefaultPage:false,updateFieldAppearances:false});
}

export async function buildPublicWebExposePdf(token:string,options:Options={}){
 if(!validWebExposeToken(token))throw new WebExposePdfError(404);
 const lookup=options.lookup??defaults.lookup,assetLookup=options.asset??defaults.asset,read=options.read??defaults.read;
 const data=await lookup(token);if(!data)throw new WebExposePdfError(404);
 const origin=new URL(options.origin??getTrustedAppOrigin());if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password)throw new WebExposePdfError();
 const pageUrl=new URL('/expose/'+token,origin).href,snapshot=data.snapshot,images:WebExposePdfImage[]=[],plans:WebExposePdfPlan[]=[],links:WebExposePdfLink[]=[],usedAssets=new Map<string,string>();let inputBytes=0,artworkBytes=0;const deadline=Date.now()+35000;
 const assetSignature=(asset:MediaAsset)=>JSON.stringify([asset.id,asset.workspaceId,asset.folder,asset.mimeType,asset.sizeBytes,asset.relativePath,asset.storageProvider,asset.storageAccess]);
 const candidates=[...snapshot.media.map(item=>({...item,mimeType:null,url:null})),...(snapshot.resources??[]),...(snapshot.template?.brandAssets??[]).map(item=>({id:item.assetId,assetId:item.assetId,kind:item.purpose,title:snapshot.template?.companyName??'Company artwork',url:null}))];
 const seen=new Set<string>();
 for(const item of candidates){
  if(Date.now()>deadline)throw new WebExposePdfError();
  if(!item.assetId){const url=externalUrl(item.url);if(url&&['document','video','external_link','floorplan'].includes(item.kind))links.push({kind:item.kind as WebExposePdfLink['kind'],title:item.title,url});continue;}
  if(!uuid.test(item.assetId))continue;
  const asset=await assetLookup(token,item.assetId);if(!asset)continue;
  if(asset.id!==item.assetId||asset.storageAccess!=='private'||asset.isPublic||asset.publicToken||asset.hasActivePublicShare)continue;
  const url=new URL(`/api/public/exposes/${token}/media/${asset.id}`,origin).href;
  if(['document','video'].includes(item.kind)){links.push({kind:item.kind as 'document'|'video',title:item.title,url});usedAssets.set(asset.id,assetSignature(asset));continue;}
  if(!['image','floorplan','logo','letterhead'].includes(item.kind)||seen.has(asset.id))continue;seen.add(asset.id);
  if(!['image/png','image/jpeg','image/webp','image/gif','image/avif','application/pdf'].includes(asset.mimeType)||(asset.mimeType==='application/pdf'&&item.kind!=='floorplan'))continue;
  inputBytes+=asset.sizeBytes;if(inputBytes>MAX_INPUT_BYTES)throw new WebExposePdfError();
  const bytes=await boundedBytes(asset,read);usedAssets.set(asset.id,assetSignature(asset));
  if(asset.mimeType==='application/pdf'){const {pageCount}=await validatePropertyExposePdf(bytes);if(pageCount>40||plans.reduce((n,p)=>n+p.pageCount,0)+pageCount>40)throw new WebExposePdfError();plans.push({id:item.id,title:item.title,bytes,pageCount});links.push({kind:'floorplan',title:item.title,url});}
  else{const image=await sharp(bytes,{failOn:'warning',limitInputPixels:rasterUploadLimits.maxPixels,page:0,pages:1}).timeout({seconds:rasterUploadLimits.timeoutSeconds}).rotate().resize({width:1800,height:1800,fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toBuffer({resolveWithObject:true});artworkBytes+=image.data.byteLength;if(artworkBytes>24*1024*1024)throw new WebExposePdfError();images.push({id:item.id,kind:item.kind as WebExposePdfImage['kind'],title:item.title,bytes:image.data,width:image.info.width,height:image.info.height});}
 }
 if(Date.now()>deadline)throw new WebExposePdfError();
 const bytes=await renderWebExposePdf({snapshot,images,plans,links,pageUrl});if(bytes.byteLength>MAX_OUTPUT_BYTES)throw new WebExposePdfError();
 // Capability and media approval can change while a large PDF is being built. Never return an obsolete authorization result.
 const current=await lookup(token);if(!current||mediaSignature(current)!==mediaSignature(data))throw new WebExposePdfError(404);
 for(const [id,signature] of usedAssets){const asset=await assetLookup(token,id);if(!asset||asset.storageAccess!=='private'||asset.isPublic||asset.publicToken||asset.hasActivePublicShare||assetSignature(asset)!==signature)throw new WebExposePdfError(404);}
 return {bytes,fileName:`expose-${snapshot.language}.pdf`};
}
export async function publicWebExposePdfResponse(token:string,options:Options={}){
 const headers={'Cache-Control':'private, no-store, max-age=0','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
 try{const {bytes,fileName}=await buildPublicWebExposePdf(token,options);return new Response(Buffer.from(bytes),{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${fileName}"`,'Content-Length':String(bytes.byteLength)}});}catch(error){return Response.json({error:error instanceof WebExposePdfError&&error.status===404?'unavailable':'temporarily_unavailable'},{status:error instanceof WebExposePdfError?error.status:503,headers});}
}
