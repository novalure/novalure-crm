export type StudioEnquiryAnalysisView = { status: "read" | "partial"; summary: string; extractedText: string; limitations: string[] };
export type StudioEnquiryView = {
  operationId: string; revision: number; confirmedAt: string; summary: string; openQuestions: string[];
  values: Record<string,string>;
  files: { id: string; name: string; originalAssetId: string; analysisAssetId: string; analysis: StudioEnquiryAnalysisView }[];
  websites: (StudioEnquiryAnalysisView & { id: string; domain: string; sources: string[] })[];
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const record = (v: unknown): v is Record<string,unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const text = (v: unknown, limit: number): v is string => typeof v === "string" && v.length <= limit && !v.includes("\0");
const list = (v: unknown, count: number, limit: number): v is string[] => Array.isArray(v) && v.length <= count && v.every(x=>text(x,limit));
const limits: Record<string,number> = {goals:800,projectType:40,existingUrl:300,company:300,industry:300,audience:300,pages:300,functions:300,languages:300,assets:300,timeline:300,budget:300,name:300,email:254,phone:100,contactMethod:20,appointmentKind:20};
function analysis(v: unknown, summaryLimit: number, extractionLimit: number): StudioEnquiryAnalysisView | null {
  if (!record(v) || !["read","partial"].includes(String(v.status)) || !text(v.summary,summaryLimit) ||
      !text(v.extractedText,extractionLimit) || !list(v.limitations,30,1200)) return null;
  return {status:v.status as "read"|"partial",summary:v.summary,extractedText:v.extractedText,limitations:v.limitations};
}
function safeSource(v: unknown): v is string {
  if (!text(v,2048)) return false;
  try {const u=new URL(v);return u.protocol==="https:"&&!u.username&&!u.password&&!u.port&&Boolean(u.hostname);}
  catch{return false;}
}
/** A bounded read projection; never exposes Blob URLs, storage paths, tokens or authority. */
export function parseStudioEnquiryView(value: unknown): StudioEnquiryView | null {
  if (!record(value) || !text(value.operationId,36) || !uuid.test(value.operationId) || !Number.isSafeInteger(value.revision) || Number(value.revision)<1 ||
      !text(value.payloadHash,64) || !digest.test(value.payloadHash) || !record(value.snapshot) || !Array.isArray(value.attachments)) return null;
  const s=value.snapshot;
  if (s.schemaVersion!=="studio-enquiry-snapshot-v1" || s.syntheticTest!==true || !text(s.conversationId,36) || !uuid.test(s.conversationId) ||
      !text(s.confirmedAt,32) || !Number.isFinite(Date.parse(s.confirmedAt)) || !record(s.consent) || s.consent.privacy!==true ||
      s.consent.policyVersion!=="studio-enquiry-2026-10-18" || !record(s.brief) || !record(s.brief.values) ||
      !text(s.brief.summary,10000) || !list(s.brief.openQuestions,8,500) || !Array.isArray(s.files) || s.files.length>3 ||
      !Array.isArray(s.websites) || s.websites.length>2 || value.attachments.length!==s.files.length*2) return null;
  const values: Record<string,string>={};
  for(const [key,v] of Object.entries(s.brief.values)){if(!Object.hasOwn(limits,key)||!text(v,limits[key]))return null;values[key]=v;}
  const files: StudioEnquiryView["files"]=[], seen=new Set<string>();
  for(const f of s.files){
    if(!record(f)||!text(f.id,36)||!uuid.test(f.id)||seen.has(f.id)||f.conversationId!==s.conversationId||!text(f.name,120)||
      !text(f.sha256,64)||!digest.test(f.sha256)||!record(f.original)||!text(f.original.sha256,64)||!digest.test(f.original.sha256))return null;
    const read=analysis(f.analysis,1600,6000);if(!read)return null;seen.add(f.id);
    const links=value.attachments.filter((a:unknown)=>record(a)&&a.sourceId===f.id);
    const find=(variant:string,sha:unknown)=>links.filter((a:Record<string,unknown>)=>a.variant===variant&&a.sha256===sha&&text(a.assetId,36)&&uuid.test(a.assetId));
    const original=find("original",f.original.sha256),normalized=find("analysis",f.sha256);
    if(links.length!==2||original.length!==1||normalized.length!==1)return null;
    if(original[0].assetId===normalized[0].assetId&&(f.original.sha256!==f.sha256||f.original.mime!==f.mime||f.original.bytes!==f.bytes))return null;
    files.push({id:f.id,name:f.name,originalAssetId:String(original[0].assetId),analysisAssetId:String(normalized[0].assetId),analysis:read});
  }
  const websites: StudioEnquiryView["websites"]=[];
  for(const w of s.websites){
    if(!record(w)||!text(w.id,36)||!uuid.test(w.id)||seen.has(w.id)||w.conversationId!==s.conversationId||!text(w.domain,253)||!safeSource(w.url)||
      new URL(w.url).hostname!==w.domain||!Array.isArray(w.sources)||w.sources.length<1||w.sources.length>2||
      w.sources.some((u:unknown)=>!safeSource(u)||new URL(u).origin!==new URL(String(w.url)).origin))return null;
    const read=analysis(w,1200,10000);if(!read)return null;seen.add(w.id);
    websites.push({id:w.id,domain:w.domain,sources:w.sources as string[],...read});
  }
  return {operationId:value.operationId,revision:Number(value.revision),confirmedAt:s.confirmedAt,summary:s.brief.summary,
    openQuestions:s.brief.openQuestions,values,files,websites};
}
