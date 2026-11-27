import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ExposeActiveClock } from "../src/lib/web-expose-tracker";
import { parseWebExposeEvents, parseWebExposeInquiry } from "../src/lib/web-expose";
import { isWebExposeOriginAllowed } from "../src/lib/web-expose-http";
import { webExposeVideoEmbed } from "../src/lib/web-expose-video";

test("active clock excludes hidden, unfocused, idle and suspended intervals", () => {
  const clock = new ExposeActiveClock(0);
  assert.equal(clock.sample(1000,true,true),1000);
  assert.equal(clock.sample(2000,false,true),0);
  assert.equal(clock.sample(3000,true,false),0);
  assert.equal(clock.sample(31000,true,true),0);
  clock.activity(31000);
  assert.equal(clock.sample(32000,true,true),1000);
  assert.equal(clock.sample(120000,true,true),0);
  clock.activity(120000);
  assert.equal(clock.sample(121000,true,true),1000);
  assert.equal(clock.sample(120500,true,true),0);
});
test("event contract rejects free-text data, invalid time credits and unknown sections", () => {
  const valid = {id:randomUUID(),sequence:1,type:"heartbeat",section:"facts",activeMs:5000,depth:70};
  assert.equal(parseWebExposeEvents([valid])[0].activeMs,5000);
  for (const value of [{...valid,activeMs:10001},{...valid,activeMs:-1},{...valid,depth:101},{...valid,section:"password"},{...valid,typedText:"private"},{...valid,target:"customer@example.com"},{...valid,sequence:0}]) assert.throws(()=>parseWebExposeEvents([value]));
  assert.throws(()=>parseWebExposeEvents(Array(31).fill(valid)));
});
test("ordinary inquiry needs no analytics permission and accepts only its explicit fields", () => {
  const input={name:" María Müller ",email:" MARIA@example.invalid ",phone:"",message:"Una consulta",privacyRead:true,unitId:null};
  const result=parseWebExposeInquiry(input);
  assert.equal(result.name,"María Müller"); assert.equal(result.email,"maria@example.invalid");
  for(const value of [{...input,privacyRead:false},{...input,workspaceId:randomUUID()},{...input,email:"not-email"},{...input,unitId:"forged"},{...input,message:"\u0000"}]) assert.throws(()=>parseWebExposeInquiry(value));
});
test("configured same origin works behind host rewriting and rejects cross-site requests",()=>{
  const request=(origin:string,site="same-origin")=>new Request("http://localhost:3000/api/public/exposes/token",{method:"POST",headers:{origin,"sec-fetch-site":site}});
  assert.equal(isWebExposeOriginAllowed(request("http://127.0.0.1:3190"),"http://127.0.0.1:3190"),true);
  assert.equal(isWebExposeOriginAllowed(request("https://evil.invalid"),"https://crm.example.invalid"),false);
  assert.equal(isWebExposeOriginAllowed(request("https://crm.example.invalid","cross-site"),"https://crm.example.invalid"),false);
  assert.equal(isWebExposeOriginAllowed(new Request("http://localhost:3000"),"https://crm.example.invalid"),false);
});
test("external video embeds accept only known HTTPS player hosts and strip arbitrary player parameters",()=>{
  assert.equal(webExposeVideoEmbed("https://www.youtube.com/watch?v=abcdefghijk&autoplay=1"),"https://www.youtube-nocookie.com/embed/abcdefghijk");
  assert.equal(webExposeVideoEmbed("https://vimeo.com/12345678"),"https://player.vimeo.com/video/12345678?dnt=1");
  for(const value of ["javascript:alert(1)","http://youtube.com/watch?v=abcdefghijk","https://youtube.com.evil.invalid/watch?v=abcdefghijk","https://user:password@youtube.com/watch?v=abcdefghijk","https://youtube.com/watch?v=../secret","https://example.invalid/video.mp4"]) assert.equal(webExposeVideoEmbed(value),null);
});
