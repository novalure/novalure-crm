import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContactMailboxReviewNotice, ContactProjectlessMailHints } from "../src/components/contact-projectless-mail-hints";

for(const language of ["de","en"] as const){
 for(const status of ["loading","unavailable"] as const){
  test(`${status} personal inbox hints never claim review or clearance (${language})`,()=>{
   const html=renderToStaticMarkup(<ContactMailboxReviewNotice status={status} language={language}/>);
   assert.match(html,/role="status"/);
   assert.match(html,language==="de"?/Postfach und mögliche Widersprüche separat/:/mailbox and possible objections separately/);
   assert.match(html,language==="de"?/keine Versandfreigabe/:/does not authorize sending/);
   assert.match(html,status==="loading"?(language==="de"?/werden geladen/:/are loading/):(language==="de"?/nicht verfügbar/:/are unavailable/));
   assert.doesNotMatch(html,language==="de"?/Keine passenden importierten Nachrichten|Adresse vorsorglich sperren|Gespeichert/:/No matching imported messages|Block address as a precaution|Saved/);
  });
 }
 test(`empty personal address hints never imply a complete or cleared inbox (${language})`,()=>{
  const html=renderToStaticMarkup(<ContactProjectlessMailHints items={[]} hasMore={false} language={language}/>);
  assert.match(html,language==="de"?/eine leere Liste ist keine Entwarnung/:/an empty list is not clearance/);
  assert.match(html,language==="de"?/Diese Hinweise ordnen keine Antwort zu und sperren keine Adresse/:/These suggestions do not associate a reply or block an address/);
  assert.doesNotMatch(html,language==="de"?/Nachricht prüfen/:/Review message/);
  assert.match(html,language==="de"?/nicht automatisch im CRM ein/:/does not automatically record them in the CRM/);
 });
 test(`a personal imported match opens the review path and signals a truncated list (${language})`,()=>{
  const html=renderToStaticMarkup(<ContactProjectlessMailHints items={[{id:"synthetic",subject:"Synthetic message",receivedAt:"2026-01-01T00:00:00Z"}]} hasMore language={language} onOpenCommunication={()=>{}}/>);
  assert.match(html,/Synthetic message/);assert.match(html,language==="de"?/Nachricht prüfen/:/Review message/);
  assert.match(html,language==="de"?/Weitere passende importierte Nachrichten/:/additional matching imported messages/);
  assert.doesNotMatch(html,language==="de"?/Adresse vorsorglich sperren/:/block its address as a precaution/);
 });
}
