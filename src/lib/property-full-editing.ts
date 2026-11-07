import type { SellerListing } from "./crm-types";
import {readPropertyDetails,type PropertyDetails} from "./property-details";

const editable = ["title","address","region","objectType","areaSqm","rooms","yearBuilt","targetPrice","publicPrice","marketingType","usageType","objectNumber","internalReference","postalCode","city","street","contactName","contactEmail","contactPhone","subObjectType","availableFrom","availableFromText","availabilityNote","rentNet","rentPrice","monthlyCostsGross","purchaseAncillaryCosts","priceVisibility","gdprStatus","portalMappingStatus","internalNotes"] as const;
export const fullPropertyInputKeys = ["title","address","region","objectType","areaSqm","rooms","yearBuilt","price","publicPrice","marketingType","usageType","objectNumber","internalReference","postalCode","city","street","contactName","contactEmail","contactPhone","subObjectType","availableFrom","availableFromText","availabilityNote","rentNet","rentPrice","monthlyCostsGross","purchaseAncillaryCosts","priceVisibility","gdprStatus","portalMappingStatus","internalNotes","geography","energyCertificate","propertyDetails","fieldValues","expectedFullSnapshot","expectedCore","expectedGeography","expectedEnergyCertificate","expectedUsageType","purchaseAncillaryCalculation","expectedAncillaryCosts"] as const;
/** The current private property content is compared under the original row lock.
 * Links and publication authority cannot be changed by this editor. */
export function propertyFullSnapshot(listing:SellerListing,details:PropertyDetails=readPropertyDetails(listing)):Record<string,unknown> {
  const row=listing as unknown as Record<string,unknown>;
  return {id:listing.id,workspaceId:listing.workspaceId,projectId:listing.projectId||null,...Object.fromEntries(editable.map(key=>[key,row[key]??null])),canonicalPayload:listing.canonicalPayload??null,details};
}
function stable(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(stable).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value)??"null";
}
export function samePropertySnapshot(left:unknown,right:unknown){return stable(left)===stable(right);}
