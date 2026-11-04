import assert from "node:assert/strict";
import {test} from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {PropertyDetailsEditor} from "../src/components/property-details-editor";
import {readPropertyDetails} from "../src/lib/property-details";
import {PropertyEnergyFields} from "../src/components/property-energy-fields";
import {createPropertyGeography} from "../src/lib/property-country";

test("full detail controls expose explicit unknown choices, native numeric inputs and unique associated labels",()=>{
 const details=readPropertyDetails({fieldValues:{"equipment.fahrstuhl":"SYNTHETIC legacy lift","rooms.schlafzimmer":"uncertain historic count"}});
 const html=renderToStaticMarkup(createElement(PropertyDetailsEditor,{details,language:"de",countryCode:"DE",onChange:()=>{}}));
 assert.match(html,/Nicht angegeben \/ unbekannt/);assert.match(html,/Schlafzimmer<\/label><input[^>]*type="number"/);assert.match(html,/Frühere Freitextangabe \(privat\)/);assert.match(html,/SYNTHETIC legacy lift/);
 const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
 for(const match of html.matchAll(/\sfor="([^"]+)"/g))assert.ok(ids.includes(match[1]),"Every field label targets its own control");
 assert.doesNotMatch(html,/<label[^>]*>[^<]*<input[^>]*>[^]*?<input[^>]*>[^]*?<\/label>/);
});
test("Spanish cadastre labels retain translated general features while foreign cadastre values stay hidden",()=>{
 const details=readPropertyDetails({fieldValues:{}});details.values["cadastre.de_grundbuchblatt"]="SYNTHETIC retained prior country";const before=JSON.stringify(details);
 const html=renderToStaticMarkup(createElement(PropertyDetailsEditor,{details,language:"es",countryCode:"ES",onChange:()=>{}}));
 assert.match(html,/Referencia catastral/);assert.match(html,/Finca registral/);assert.match(html,/Ascensor/);assert.doesNotMatch(html,/SYNTHETIC retained prior country/);assert.doesNotMatch(html,/Irische Folionummer|Irish folio number/);assert.equal(JSON.stringify(details),before);
});
test("AT DE ES IE show only selected-country fields even when all other countries have saved values; switching retains the DTO",()=>{
 const details=readPropertyDetails({fieldValues:{}}),countries=["AT","DE","ES","IE"] as const;
 const privateMarkers={AT:["cadastre.einlagezahl","SYNTHETIC-AT-REGISTER"],DE:["cadastre.de_grundbuchblatt","SYNTHETIC-DE-REGISTER"],ES:["cadastre.es_referencia_catastral","SYNTHETIC-ES-REGISTER"],IE:["cadastre.ie_folio","SYNTHETIC-IE-REGISTER"]} as const;
 for(const country of countries){const[id,value]=privateMarkers[country];details.values[id]=value;details.legacy[id]=value;}
 details.values["energy.hwb"]=70;details.values["energy.fgee"]=1.2;details.values["energy.hwb_klasse"]="B";details.values["energy.fgee_klasse"]="A";
 const before=JSON.stringify(details);
 for(const country of [...countries,"DE","ES","IE","AT"]){
  const html=renderToStaticMarkup(createElement(PropertyDetailsEditor,{details,language:"de",countryCode:country,onChange:()=>{}}));
  for(const c of countries)assert.equal(html.includes(privateMarkers[c][1]),c===country,`${country} must show only its own saved cadastre values`);
  assert.match(html,/Schlafzimmer/);assert.match(html,/Fahrstuhl/);
  assert.equal(/-energy\.hwb"/.test(html),country==="AT");assert.equal(/-energy\.fgee"/.test(html),country==="AT");assert.equal(/-energy\.hwb_klasse"/.test(html),country==="AT");assert.equal(/-energy\.fgee_klasse"/.test(html),country==="AT");
  assert.equal(JSON.stringify(details),before,"Rendering and country switching never erase hidden values");
  const energy=renderToStaticMarkup(createElement(PropertyEnergyFields,{geography:createPropertyGeography(country,"SYNTHETIC"),energy:{version:1,countryCode:country},usageType:"residential",yearBuilt:2020,language:"de",onChange:()=>{}}));
  assert.equal(energy.includes('name="heatingDemandKwhM2"'),country==="AT");assert.equal(energy.includes('name="energySource"'),country==="DE");assert.equal(energy.includes('name="registration"'),country==="ES");assert.equal(energy.includes("BER scale"),country==="IE");
 }
});
