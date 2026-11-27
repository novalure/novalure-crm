import type { LanguageCode } from "@/lib/i18n";

type Item = { id: string; subject: string; receivedAt: string };

/** Loading or failed personal review is not evidence about the inbox. */
export function ContactMailboxReviewNotice({status,language}:{status:"loading"|"unavailable";language:LanguageCode}) {
  const de=language==="de";
  return <p role="status" className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-stone-700">
    {status==="loading"?(de?"Persönliche Postfachhinweise werden geladen.":"Personal mailbox suggestions are loading."):(de?"Persönliche Postfachhinweise sind nicht verfügbar.":"Personal mailbox suggestions are unavailable.")} {de?"Prüfe das Postfach und mögliche Widersprüche separat. Dies ist keine Versandfreigabe.":"Check the mailbox and possible objections separately. This does not authorize sending."}
  </p>;
}

/** Same-address personal copies are suggestions, never proof of a reply. */
export function ContactProjectlessMailHints({items,hasMore,language,onOpenCommunication}:{items:Item[];hasMore:boolean;language:LanguageCode;onOpenCommunication?:(messageId:string)=>void}) {
  const de=language==="de";
  return <section className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4" aria-label={de?"Persönliche Postfachhinweise":"Personal mailbox suggestions"}>
    <h5 className="text-sm font-semibold">{de?"Persönliche Postfachhinweise":"Personal mailbox suggestions"}</h5>
    <p className="mt-1 text-sm text-stone-700">{de?"Nur bereits in dein persönliches CRM-Postfach importierte Nachrichten mit gleicher Absenderadresse, höchstens zehn. Die Adresse bestätigt weder Identität noch Kontaktbezug. Prüfe dein Postfach persönlich; eine leere Liste ist keine Entwarnung.":"Only messages already imported into your personal CRM inbox with the same sender address are shown, at most ten. The address does not confirm identity or a relationship. Review your mailbox personally; an empty list is not clearance."}</p>
    <p className="mt-1 text-sm text-stone-700">{de?"Diese Hinweise ordnen keine Antwort zu und sperren keine Adresse.":"These suggestions do not associate a reply or block an address."} {de?"Widersprüche müssen separat zuverlässig dokumentiert werden. Dieser Pilot trägt sie nicht automatisch im CRM ein.":"Objections must be recorded reliably outside this pilot. This pilot does not automatically record them in the CRM."}</p>
    {hasMore&&<p className="mt-1 text-sm text-stone-700">{de?"Weitere passende importierte Nachrichten sind im persönlichen Postfach zu prüfen.":"Review additional matching imported messages in your personal mailbox."}</p>}
    {!items.length&&<p className="mt-2 text-sm">{de?"Keine passenden importierten Nachrichten angezeigt.":"No matching imported messages shown."}</p>}
    <ul className="mt-2 space-y-2 text-sm">{items.map(item=><li key={item.id} className="break-words"><span>{item.subject||(de?"Nachricht ohne Betreff":"Message without subject")} · {new Date(item.receivedAt).toLocaleDateString(de?"de-IE":"en-IE")}</span>{onOpenCommunication&&<button type="button" className="ml-2 min-h-11 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={()=>onOpenCommunication(item.id)}>{de?"Nachricht prüfen":"Review message"}</button>}</li>)}</ul>
  </section>;
}
