import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MailboxAutoImportPanel,type MailboxAutoState} from '../src/components/mailbox-auto-import-panel';

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
