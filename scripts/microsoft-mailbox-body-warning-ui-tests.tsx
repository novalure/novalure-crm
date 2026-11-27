import assert from 'node:assert/strict';
import {test} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MessageDetail} from '../src/components/connected-communication-workspace';

const detail={id:'synthetic-message',revision:1,subject:'Synthetic',fromLabel:'Synthetic',fromAddress:'sender@example.invalid',receivedAt:'2026-11-25T12:00:00Z',bodyText:'Synthetic preview',bodyTruncated:true,attachments:[],linkId:null,confirmedReply:null,reviewReason:null};
const props={detail,leads:[],disabled:false,canAssign:false,canSuppress:false,onSuppress:async()=>{},onAssociate:async()=>{},onErase:async()=>{}};

test('incomplete imported message content displays a warning in both languages',()=>{
 const german=renderToStaticMarkup(<MessageDetail {...props} de={true}/>);
 assert.match(german,/ein vollständiger sicherer Textinhalt war nicht verfügbar/);
 const english=renderToStaticMarkup(<MessageDetail {...props} de={false}/>);
 assert.match(english,/complete safe text content was unavailable/);
 const complete=renderToStaticMarkup(<MessageDetail {...props} detail={{...detail,bodyTruncated:false}} de={false}/>);
 assert.doesNotMatch(complete,/complete safe text content was unavailable/);
});

test('untrusted preview markup remains inert text in the message detail',()=>{
 const markup='<script>alert("synthetic")</script><img src=x onerror=alert(1)>';
 const html=renderToStaticMarkup(<MessageDetail {...props} detail={{...detail,bodyText:markup}} de={false}/>);
 assert.doesNotMatch(html,/<script>|<img /);
 assert.match(html,/&lt;script&gt;alert\(&quot;synthetic&quot;\)&lt;\/script&gt;/);
 assert.match(html,/complete safe text content was unavailable/);
});
