import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseMicrosoftMailboxMessage} from '../src/lib/integrations/mailbox-provider';

const base={id:'synthetic-message',receivedDateTime:'2026-11-25T12:00:00Z',bodyPreview:'Synthetic preview'};

test('missing and malformed Outlook text bodies remain visibly incomplete',()=>{
 for(const content of [undefined,null,0,false,{},[]]){
  const message=parseMicrosoftMailboxMessage({...base,body:{contentType:'text',content}},[]);
  assert.equal(message.bodyTruncated,true);
  assert.equal(message.bodyText,'Synthetic preview');
 }
 const missing=parseMicrosoftMailboxMessage({...base,body:undefined,bodyPreview:undefined},[]);
 assert.equal(missing.bodyTruncated,true);
 assert.equal(missing.bodyText,'');
});

test('valid Outlook text bodies preserve emptiness, normal text and size warnings',()=>{
 for(const content of ['', 'A complete synthetic reply']){
  const message=parseMicrosoftMailboxMessage({...base,bodyPreview:'',body:{contentType:'text',content}},[]);
  assert.equal(message.bodyTruncated,false);
  assert.equal(message.bodyText,content);
 }
 const oversized=parseMicrosoftMailboxMessage({...base,body:{contentType:'text',content:'x'.repeat(65537)}},[]);
 assert.equal(oversized.bodyTruncated,true);
 assert.equal(oversized.bodyText.length,65536);
 const html=parseMicrosoftMailboxMessage({...base,body:{contentType:'html',content:'<script>unsafe</script>'}},[]);
 assert.equal(html.bodyTruncated,true);
 assert.equal(html.bodyText,'Synthetic preview');
});

test('an empty text body contradicting a nonempty preview remains incomplete',()=>{
 const message=parseMicrosoftMailboxMessage({...base,body:{contentType:'text',content:''}},[]);
 assert.equal(message.bodyTruncated,true);
 assert.equal(message.bodyText,'Synthetic preview');
 const empty=parseMicrosoftMailboxMessage({...base,bodyPreview:undefined,body:{contentType:'text',content:''}},[]);
 assert.equal(empty.bodyTruncated,false);
 assert.equal(empty.bodyText,'');
});

test('body content without visible characters does not hide a meaningful preview',()=>{
 for(const content of [' \t\r\n', '\u0000\u0001', '\u200b\ufeff', '\u00a0\u2009']){
  const message=parseMicrosoftMailboxMessage({...base,body:{contentType:'text',content}},[]);
  assert.equal(message.bodyTruncated,true);
  assert.equal(message.bodyText,'Synthetic preview');
 }
 const genuinelyEmpty=parseMicrosoftMailboxMessage({...base,bodyPreview:' \u200b\n',body:{contentType:'text',content:''}},[]);
 assert.equal(genuinelyEmpty.bodyTruncated,false);
 assert.equal(genuinelyEmpty.bodyText,'');
 const visible=parseMicrosoftMailboxMessage({...base,body:{contentType:'text',content:'\u200bHello 🌍'}},[]);
 assert.equal(visible.bodyTruncated,false);
 assert.equal(visible.bodyText,'\u200bHello 🌍');
});
