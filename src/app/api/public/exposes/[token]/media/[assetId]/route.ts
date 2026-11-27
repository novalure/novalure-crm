import { queryOne } from "@/lib/db/client";
import { validWebExposeToken, webExposeHash } from "@/lib/db/web-expose-repository";
import { readMediaAssetContent, type MediaAsset } from "@/lib/media-store";

export async function GET(request: Request, context: { params: Promise<{ token: string; assetId: string }> }) {
  const { token, assetId } = await context.params;
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'" };
  if (!validWebExposeToken(token) || !/^[0-9a-f-]{36}$/i.test(assetId)) return new Response(null, { status: 404, headers });
  try {
    const row = await queryOne<{ data: MediaAsset | null }>(`select crm_web_expose_asset($1,$2::uuid) as data`, [webExposeHash(token), assetId]);
    if (!row?.data || !["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "application/pdf", "video/mp4", "video/webm"].includes(row.data.mimeType)) return new Response(null, { status: 404, headers });
    const content = await readMediaAssetContent(row.data);
    if (!content) return new Response(null, { status: 404, headers });
    const range=request.headers.get("range");
    const rangeHeaders={...headers,"Accept-Ranges":"bytes","Content-Type":content.contentType,"Content-Disposition":"inline"};
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{...headers,"Content-Range":`bytes */${content.sizeBytes}`}});
      const size=content.sizeBytes;
      const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
      const end=match[1]?match[2]?Math.min(size-1,Number(match[2])):size-1:size-1;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return new Response(null,{status:416,headers:{...headers,"Content-Range":`bytes */${size}`}});
      if(size>10*1024*1024)return new Response(null,{status:503,headers});
      const bytes=content.body instanceof Uint8Array?content.body:new Uint8Array(await new Response(content.body as BodyInit).arrayBuffer());
      return new Response(bytes.slice(start,end+1),{status:206,headers:{...rangeHeaders,"Content-Range":`bytes ${start}-${end}/${size}`,"Content-Length":String(end-start+1)}});
    }
    return new Response(content.body as BodyInit,{headers:{...rangeHeaders,"Content-Length":String(content.sizeBytes)}});
  } catch { return new Response(null, { status: 503, headers }); }
}
