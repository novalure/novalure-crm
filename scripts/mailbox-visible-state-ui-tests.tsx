import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MailboxAutoImportPanel,type MailboxAutoState} from '../src/components/mailbox-auto-import-panel';
import {MailboxRecoveryControls, mailboxAutoSyncReadback} from '../src/components/connected-communication-workspace';

const state:MailboxAutoState={ready:true,contactReviewReady:false,settings:[{connectionId:'synthetic',enabled:true,autoFile:false,revision:1,status:'current',lastSuccessAt:null,nextRunAt:'2099-01-01',lastError:null}],decisions:[],moreDecisions:null};
const noop=async()=>{};
test('automatic panel does not display a current result when scopes need review or a check is unconfirmed',()=>{
 for(const [presentation,label] of [['scope_review','Mail-Berechtigungen prüfen'],['check_unconfirmed','Abgleich nicht bestätigt']] as const){
  const html=renderToStaticMarkup(<MailboxAutoImportPanel state={state} connections={[{id:'synthetic',accountLabel:'SYNTHETIC',status:'connected',presentation}]} de disabled={false} onCommand={noop} onOpen={()=>{}} onDecisionsPage={()=>{}}/>);
  assert.match(html,new RegExp(label));assert.doesNotMatch(html,/Eingang abgeglichen/);
 }
});
test('legacy extra permissions are visible but do not disable the existing automatic sync',()=>{
 const html=renderToStaticMarkup(<MailboxAutoImportPanel state={state} connections={[{id:'synthetic',accountLabel:'SYNTHETIC',status:'connected',presentation:'extra_permissions'}]} de disabled={false} onCommand={noop} onOpen={()=>{}} onDecisionsPage={()=>{}}/>);
 assert.match(html,/Weitergehende Berechtigungen prüfen/);
 const sync=html.match(/<button[^>]*>Jetzt abgleichen \/ nachholen<\/button>/)?.[0];assert.ok(sync);assert.doesNotMatch(sync,/\sdisabled(?:=|\s|>)/);
});
test('disconnected active automatic checking can be unchecked and an old current value is not presented as fresh',()=>{
 const disconnected=renderToStaticMarkup(<MailboxAutoImportPanel state={state} connections={[{id:'synthetic',accountLabel:'SYNTHETIC',status:'reauthorization_required',presentation:'not_connected'}]} de disabled={false} onCommand={noop} onOpen={()=>{}} onDecisionsPage={()=>{}}/>);
 const checkbox=disconnected.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];assert.ok(checkbox);assert.doesNotMatch(checkbox,/disabled/);
 const connected=renderToStaticMarkup(<MailboxAutoImportPanel state={{...state,hostConnectionIds:[]}} connections={[{id:'synthetic',accountLabel:'SYNTHETIC',status:'connected',presentation:'configured'}]} de disabled={false} onCommand={noop} onOpen={()=>{}} onDecisionsPage={()=>{}}/>);
 assert.match(connected,/Aktualität des Abgleichs nicht bestätigt/);assert.doesNotMatch(connected,/Eingang abgeglichen/);
});

const attemptedAutoSync = { connectionId: 'synthetic', connectionRevision: 6, policyRevision: 5 };
const savedAutoSync = {
  connections: [{ id: 'synthetic', revision: 10, checkPending: false, lastError: 'MAIL_SYNC_FAILED' }],
  auto: { ready: true, settings: [{ connectionId: 'synthetic', revision: 6, lastError: 'MAIL_SYNC_FAILED' }] },
};

test('after an unconfirmed auto-sync, saved state can be checked without offering a POST retry', () => {
  const html = renderToStaticMarkup(<MailboxRecoveryControls busy={false} de retryAvailable={false} onRetry={noop} onReload={noop} />);
  assert.match(html, /<button[^>]*>Gespeicherten Stand prüfen<\/button>/);
  assert.doesNotMatch(html, /Gleichen Vorgang erneut prüfen|\sdisabled(?:=|\s|>)/);
  assert.equal(mailboxAutoSyncReadback(savedAutoSync, attemptedAutoSync), 'interrupted');

  const legacy = renderToStaticMarkup(<MailboxRecoveryControls busy={false} de retryAvailable onRetry={noop} onReload={noop} />);
  assert.match(legacy, /Gleichen Vorgang erneut prüfen/);
});

test('a 503 readback stays unconfirmed until the same connection and policy advance with no pending lease', () => {
  const [connection] = savedAutoSync.connections;
  const [policy] = savedAutoSync.auto.settings;
  assert.equal(mailboxAutoSyncReadback({ ...savedAutoSync, connections: [{ ...connection, checkPending: true }] }, attemptedAutoSync), 'pending');
  for (const snapshot of [
    { ...savedAutoSync, connections: [] },
    { ...savedAutoSync, connections: [{ ...connection, id: 'different' }] },
    { ...savedAutoSync, connections: [{ ...connection, revision: 6 }] },
    { ...savedAutoSync, auto: { ...savedAutoSync.auto, settings: [] } },
    { ...savedAutoSync, auto: { ...savedAutoSync.auto, settings: [{ ...policy, revision: 5 }] } },
  ]) assert.equal(mailboxAutoSyncReadback(snapshot, attemptedAutoSync), 'unconfirmed');

  assert.equal(mailboxAutoSyncReadback({
    connections: [{ ...connection, lastError: null }],
    auto: { ready: true, settings: [{ ...policy, lastError: null }] },
  }, attemptedAutoSync), 'refreshed');
});
