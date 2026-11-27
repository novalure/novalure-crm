import assert from 'node:assert/strict';
import { before, mock, test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const url=(path:string)=>pathToFileURL(resolve(process.cwd(),path)).href;
const workspaceId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pageId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bookingId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let provider='microsoft',available=false,writes=0,externalWrites=0,busyReads=0;
const page=()=>({id:pageId,workspaceId,slug:'synthetic',title:'Synthetic',workspacePublicKey:'synthetic',calendarIntegrations:{defaultProvider:provider,availability:{timeZone:'UTC'}},automation:{allowReschedule:true},shareConfig:{}});
const booking=()=>({id:bookingId,workspaceId,meetingPageId:pageId,pageSlug:'synthetic',pageTitle:'Synthetic',slug:'synthetic',title:'Synthetic',startsAt:'2099-01-01T12:00:00Z',endsAt:'2099-01-01T12:30:00Z',status:'confirmed',contactName:'Synthetic',contactEmail:'a@example.invalid',calendarProvider:'microsoft',meetingProvider:'manual-link',metadata:{publicToken:'synthetic'},calendarIntegrations:page().calendarIntegrations,automation:page().automation,workspacePublicKey:'synthetic'});
mock.module(url('src/lib/booking/legacy-routing.ts'),{namedExports:{getLegacyBookingReplacement:async()=>null,replacementBookingPath:()=>''}});
mock.module(url('src/lib/db/client.ts'),{namedExports:{hasDatabaseUrl:()=>true,queryRows:async(sql:string)=>{if(/^\s*(insert|update|delete)\b/i.test(sql))writes++;return [];},queryOne:async(sql:string)=>{
 if(/^\s*(insert|update|delete)\b/i.test(sql)){writes++;throw Error('unexpected write');}
 if(sql.includes('crm_property_booking_action_lookup')&&sql.includes('to_regprocedure'))return {ready:true,legacyRead:false};
 if(sql.includes('crm_property_booking_action_lookup'))return {result:booking()};
 if(sql.includes('from meeting_pages mp'))return page();
 throw Error('unexpected query');
}}});
mock.module(url('src/lib/integrations/microsoft-calendar.ts'),{namedExports:{listMicrosoftBusyTimes:async()=>{busyReads++;if(!available)throw Error('calendar_availability_unavailable');return [];},syncMicrosoftCalendarEvent:async()=>{externalWrites++;throw Error('unexpected provider write');},updateMicrosoftCalendarEvent:async()=>{externalWrites++;throw Error('unexpected provider write');},deleteMicrosoftCalendarEvent:async()=>{externalWrites++;throw Error('unexpected provider write');}}});
mock.module(url('src/lib/integrations/google-calendar.ts'),{namedExports:{listGoogleBusyTimes:async()=>[],syncGoogleCalendarEvent:async()=>{externalWrites++;},updateGoogleCalendarEvent:async()=>{externalWrites++;},deleteGoogleCalendarEvent:async()=>{externalWrites++;}}});
let meetings:typeof import('../src/lib/db/meeting-repositories');
before(async()=>{meetings=await import('../src/lib/db/meeting-repositories');});
function nextWeekday(){const d=new Date();d.setUTCDate(d.getUTCDate()+2);while([0,6].includes(d.getUTCDay()))d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);}
test('unavailable Microsoft calendar offers no slots and prevents create and reschedule writes',async()=>{
 provider='microsoft';available=false;writes=externalWrites=busyReads=0;const date=nextWeekday();
 assert.equal(await meetings.getPublicMeetingAvailability({slug:'synthetic',workspacePublicKey:'synthetic',date}),null);
 const created=await meetings.createMeetingBookingWithNotifications({calendarProvider:'microsoft',meetingProvider:'manual-link',contactEmail:'a@example.invalid',contactName:'Synthetic',selectedDate:date,slot:'10:00',slug:'synthetic',workspacePublicKey:'synthetic',requestUrl:'https://crm.example.invalid'});
 assert.equal(created.persisted,false);assert.equal(created.reason,'slot_unavailable');
 const rescheduled=await meetings.reschedulePublicMeetingBooking({bookingId,token:'synthetic',selectedDate:date,slot:'10:00',requestUrl:'https://crm.example.invalid'});
 assert.equal(rescheduled.ok,false);assert.equal(rescheduled.error,'slot_unavailable');assert.equal(busyReads,3);assert.equal(writes,0);assert.equal(externalWrites,0);
});
test('configured empty Microsoft calendar, local-only pages and Gmail keep available slots',async()=>{
 const date=nextWeekday();for(const choice of ['microsoft','none','google']){provider=choice;available=true;const result=await meetings.getPublicMeetingAvailability({slug:'synthetic',workspacePublicKey:'synthetic',date});assert.ok(result?.slots.some(slot=>slot.available),choice);}
});
