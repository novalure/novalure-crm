"use client";
import { useState } from "react";
import { webExposeVideoEmbed } from "@/lib/web-expose-video";
import type { WebExposeLanguage, WebExposePublicResource } from "@/lib/web-expose";

function Video({resource,source,language,preview}:{resource:WebExposePublicResource;source:string;language:WebExposeLanguage;preview:boolean}){
  const [loaded,setLoaded]=useState(false),de=language==="de",es=language==="es";
  const embed=resource.url?webExposeVideoEmbed(resource.url):null;
  const native=Boolean(resource.assetId)||Boolean(resource.url&&/\.(mp4|webm)(?:$|[?#])/i.test(resource.url));
  const target=`resource:${resource.id}`;
  return <article className="overflow-hidden rounded-xl border border-stone-200 bg-white"><div className="p-5"><h3 className="text-lg font-semibold">{resource.title}</h3>{resource.url?<p className="mt-2 text-sm leading-6 text-stone-600">{de?"Dieser Inhalt wird erst nach deinem Klick vom externen Anbieter geladen. Dabei erhält dieser deine Verbindungsdaten.":es?"El contenido solo se carga desde el proveedor externo al hacer clic. El proveedor recibirá los datos de conexión.":"This content loads from its external provider only after your click. The provider will receive connection data."}</p>:null}
    {!loaded?<button type="button" disabled={preview&&!source} onClick={()=>setLoaded(true)} data-expose-event="video" data-expose-target={target+":load"} className="mt-4 rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white">{de?"Video laden":es?"Cargar vídeo":"Load video"} ▶</button>:null}</div>
    {loaded&&native?<video controls playsInline preload="none" src={source} className="aspect-video w-full bg-slate-950" data-expose-target={target} aria-label={resource.title}><a href={source}>{de?"Video öffnen":es?"Abrir vídeo":"Open video"}</a></video>:loaded&&embed?<iframe className="aspect-video w-full border-0" src={embed} title={resource.title} allow="fullscreen; picture-in-picture" sandbox="allow-scripts allow-same-origin allow-presentation" referrerPolicy="no-referrer" allowFullScreen/>:loaded?<div className="px-5 pb-5"><a className="font-semibold text-blue-900 underline" href={source} target="_blank" rel="noreferrer" data-expose-event="video" data-expose-target={target+":open"}>{de?"Video beim Anbieter öffnen":es?"Abrir vídeo en el proveedor":"Open video at provider"} ↗</a></div>:null}
  </article>;
}
export function WebExposeResourceSections({resources,language,mediaUrl,preview=false,onlySection}:{resources:WebExposePublicResource[];language:WebExposeLanguage;mediaUrl:(id:string)=>string;preview?:boolean;onlySection?:"documents"|"videos"|"links"}){
  const de=language==="de",es=language==="es",section="mx-auto max-w-6xl scroll-mt-24 px-5 py-14 sm:px-8";
  const source=(resource:WebExposePublicResource)=>resource.assetId?mediaUrl(resource.assetId):resource.url||"";
  const documents=resources.filter(r=>r.kind==="document"&&(!onlySection||onlySection==="documents")),videos=resources.filter(r=>r.kind==="video"&&(!onlySection||onlySection==="videos")),links=resources.filter(r=>r.kind==="external_link"&&(!onlySection||onlySection==="links"));
  return <>
    {documents.length?<section id="documents" data-expose-section="documents" className={section}><h2 className="mb-6 text-2xl font-semibold">{de?"Unterlagen & Downloads":es?"Documentos y descargas":"Documents & downloads"}</h2><div className="grid gap-4 sm:grid-cols-2">{documents.map(resource=><a className="flex min-h-24 items-center justify-between gap-4 rounded-xl border border-stone-200 bg-white p-5" href={source(resource)} target="_blank" rel="noreferrer" key={resource.id} data-expose-event="document" data-expose-target={`resource:${resource.id}`}><span><strong>{resource.title}</strong><span className="mt-2 block text-sm text-stone-500">{resource.mimeType==="application/pdf"?"PDF":de?"Dokument":es?"Documento":"Document"}</span></span><span aria-hidden="true">↗</span></a>)}</div></section>:null}
    {videos.length?<section id="videos" data-expose-section="videos" className={section}><h2 className="mb-6 text-2xl font-semibold">{de?"Videos & Einblicke":es?"Vídeos del inmueble":"Property videos"}</h2><div className="grid gap-5 lg:grid-cols-2">{videos.map(resource=><Video key={resource.id} resource={resource} source={source(resource)} language={language} preview={preview}/>)}</div></section>:null}
    {links.length?<section id="links" data-expose-section="links" className={section}><h2 className="mb-6 text-2xl font-semibold">{de?"Weitere Einblicke & Links":es?"Más información y enlaces":"More information & links"}</h2><div className="grid gap-4 sm:grid-cols-2">{links.map(resource=><a className="rounded-xl border border-stone-200 bg-white p-5 font-semibold text-blue-900" href={source(resource)} target="_blank" rel="noreferrer" key={resource.id} data-expose-event="external_link" data-expose-target={`resource:${resource.id}`}>{resource.title} ↗</a>)}</div></section>:null}
  </>;
}
