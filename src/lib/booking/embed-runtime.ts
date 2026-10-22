export type BookingEmbedMode = "inline" | "popup";

function html(value: string) { return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
export function buildBookingEmbedCode(input: { origin: string; publicId: string; mode: BookingEmbedMode; language: "auto" | "de" | "en" }): string {
  const origin = new URL(input.origin).origin;
  return `<div data-novalure-booking="${html(input.publicId)}" data-novalure-mode="${input.mode}" data-novalure-language="${input.language}"></div>\n<script src="${html(origin)}/appointments/embed.js" defer></script>`;
}

/** No credentials, dynamic code evaluation, cookies or access to the iframe document. */
export const bookingEmbedScript = String.raw`(function(){
  "use strict";
  var loader=document.currentScript;
  if(!loader||!loader.src)return;
  var bookingOrigin;
  try{bookingOrigin=new URL(loader.src).origin;}catch(_){return;}
  function mount(root){
    Array.prototype.forEach.call(root.querySelectorAll("[data-novalure-booking]"),function(host){
      if(host.getAttribute("data-novalure-booking-mounted")==="1")return;
      var publicId=host.getAttribute("data-novalure-booking")||"";
      if(!/^[a-zA-Z0-9_-]{10,100}$/.test(publicId))return;
      var mode=host.getAttribute("data-novalure-mode")==="popup"?"popup":"inline";
      var language=host.getAttribute("data-novalure-language");
      var resolvedLanguage=language==="de"||language==="en"?language:/^de(?:-|$)/i.test(document.documentElement.lang||"")?"de":/^en(?:-|$)/i.test(document.documentElement.lang||"")?"en":null;
      var de=resolvedLanguage==="de";
      var instanceId=typeof crypto.randomUUID==="function"?crypto.randomUUID():String(Date.now())+"-"+Math.random().toString(36).slice(2);
      var url=new URL("/appointments/"+encodeURIComponent(publicId),bookingOrigin);
      url.searchParams.set("channel",mode);url.searchParams.set("embed","1");url.searchParams.set("parentOrigin",location.origin);url.searchParams.set("instanceId",instanceId);
      if(resolvedLanguage)url.searchParams.set("lang",resolvedLanguage);
      var frame=document.createElement("iframe");
      frame.title=de?"Terminbuchung":"Appointment booking";
      frame.src=url.toString();frame.referrerPolicy="no-referrer";
      frame.setAttribute("sandbox","allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
      frame.setAttribute("data-novalure-booking-frame",instanceId);
      frame.style.width="100%";frame.style.minHeight="420px";frame.style.height="680px";frame.style.border="0";frame.style.display="block";
      var status=document.createElement("p");status.setAttribute("role","status");status.textContent=de?"Terminbuchung wird geladen …":"Loading appointment booking …";
      var fallback=document.createElement("a");fallback.href=url.toString();fallback.target="_blank";fallback.rel="noopener noreferrer";fallback.textContent=de?"Buchung in einem neuen Fenster öffnen":"Open booking in a new window";
      fallback.style.display="inline-block";fallback.style.padding="12px 0";
      var dialog=null;var trigger=null;
      if(mode==="popup"){
        trigger=document.createElement("button");trigger.type="button";trigger.textContent=de?"Termin buchen":"Book an appointment";trigger.style.minHeight="44px";trigger.style.padding="10px 18px";
        dialog=document.createElement("dialog");dialog.setAttribute("aria-label",de?"Termin buchen":"Book an appointment");
        dialog.style.width="min(720px,calc(100vw - 32px))";dialog.style.maxHeight="calc(100vh - 32px)";dialog.style.padding="16px";dialog.style.border="1px solid #cbd5e1";dialog.style.borderRadius="12px";
        var close=document.createElement("button");close.type="button";close.textContent=de?"Schließen":"Close";close.style.minHeight="44px";close.style.display="block";close.style.marginLeft="auto";
        close.addEventListener("click",function(){dialog.close();});
        dialog.addEventListener("click",function(event){if(event.target===dialog)dialog.close();});
        dialog.addEventListener("close",function(){trigger.focus();});
        dialog.appendChild(close);dialog.appendChild(status);dialog.appendChild(frame);dialog.appendChild(fallback);host.appendChild(trigger);host.appendChild(dialog);
        trigger.addEventListener("click",function(){if(typeof dialog.showModal==="function")dialog.showModal();else window.open(url.toString(),"_blank","noopener,noreferrer");});
      }else{host.appendChild(status);host.appendChild(frame);host.appendChild(fallback);}
      host.setAttribute("data-novalure-booking-mounted","1");
      function receive(event){
        if(event.origin!==bookingOrigin||event.source!==frame.contentWindow||!event.data||typeof event.data!=="object")return;
        var data=event.data;
        if(data.version!==1||data.instanceId!==instanceId)return;
        if(data.type==="novalure.booking.hello"){
          frame.contentWindow.postMessage({type:"novalure.booking.initialize",version:1,instanceId:instanceId},bookingOrigin);
        }else if(data.type==="novalure.booking.ready"){
          status.textContent="";host.setAttribute("data-novalure-booking-ready","1");
        }else if(data.type==="novalure.booking.resize"&&Number.isInteger(data.height)&&data.height>=320&&data.height<=1800){
          frame.style.height=data.height+"px";
        }else if(data.type==="novalure.booking.close"&&dialog){dialog.close();}
      }
      window.addEventListener("message",receive);
    });
  }
  if(!window.NovalureBooking)window.NovalureBooking={mount:mount};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){mount(document);},{once:true});else mount(document);
})();`;
