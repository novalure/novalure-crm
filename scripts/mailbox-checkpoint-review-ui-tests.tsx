import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MailboxAutoImportPanel, type MailboxAutoState } from "../src/components/mailbox-auto-import-panel";

test("an invalid Outlook checkpoint displays a clear review notice in both languages", () => {
  const state: MailboxAutoState = { ready: true, settings: [{ connectionId: "synthetic", enabled: false, autoFile: false, revision: 1, status: "review", lastSuccessAt: null, nextRunAt: "", lastError: "MAIL_CHECKPOINT_REVIEW_REQUIRED" }], decisions: [], moreDecisions: null };
  for (const [de, expected] of [[true, /Abgleichsstand ist unvollständig oder ungültig/], [false, /sync state is incomplete or invalid/]] as const) {
    const html = renderToStaticMarkup(<MailboxAutoImportPanel state={state} connections={[{ id: "synthetic", accountLabel: "Synthetic", status: "connected" }]} de={de} disabled={false} onCommand={async()=>{}} onOpen={()=>{}} onDecisionsPage={()=>{}} />);
    assert.match(html, expected);
    assert.match(html, /role="alert"/);
    assert.doesNotMatch(html, /MAIL_CHECKPOINT_REVIEW_REQUIRED/);
  }
});
