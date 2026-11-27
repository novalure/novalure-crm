import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MailboxAutoImportPanel, type MailboxAutoState } from "../src/components/mailbox-auto-import-panel";

const base: MailboxAutoState = { ready: false, settings: [], decisions: [], moreDecisions: null };
const noop = async () => {};

test("the German warning is visible whether or not automatic inbox is installed", () => {
  for (const ready of [false, true]) {
    const html = renderToStaticMarkup(<MailboxAutoImportPanel state={{...base,ready}} connections={[]} de disabled={false} onCommand={noop} onOpen={()=>{}} onDecisionsPage={()=>{}} />);
    assert.match(html,/Kontakte ohne Projekt werden in der automatischen Kontaktprüfung nicht erfasst/);
    assert.match(html,/Versand außerhalb des CRM, zum Beispiel direkt aus Outlook oder Gmail, wird nicht automatisch auf Widersprüche geprüft/);
  }
});

test("the English warning is visible whether or not automatic inbox is installed", () => {
  for (const ready of [false, true]) {
    const html = renderToStaticMarkup(<MailboxAutoImportPanel state={{...base,ready}} connections={[]} de={false} disabled={false} onCommand={noop} onOpen={()=>{}} onDecisionsPage={()=>{}} />);
    assert.match(html,/Automatic contact review does not cover contacts without a project/);
    assert.match(html,/sent outside the CRM, for example directly from Outlook or Gmail, are not automatically checked for objections/);
  }
});

test("a successful automatic fetch is not labeled as a complete mailbox reconciliation", () => {
  const state: MailboxAutoState = { ...base, ready:true, settings:[{connectionId:"synthetic",enabled:true,autoFile:false,revision:1,status:"current",lastSuccessAt:"2026-11-25T12:00:00.000Z",nextRunAt:"2026-11-25T12:02:00.000Z",lastError:null}] };
  const html = renderToStaticMarkup(<MailboxAutoImportPanel state={state} connections={[{id:"synthetic",accountLabel:"Synthetic",status:"connected"}]} de disabled={false} onCommand={noop} onOpen={()=>{}} onDecisionsPage={()=>{}} />);
  assert.match(html,/Letzter abgeschlossener automatischer Abruf/);
  assert.doesNotMatch(html,/>Vollständiger Abgleich:/);
});
