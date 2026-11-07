import { randomUUID } from "node:crypto";
/** Synthetic fixture for a disposable loopback database only. Never consumes provider credentials. */
export async function seedLivelistedBrowser(db, fixture, encryptionKey) {
  const propertyId=randomUUID(), unitId=randomUUID(), contactId=randomUUID(), leadId=randomUUID();
  const geography={version:1,countryCode:"AT",region:"Wien",displayLocale:"de-AT",contentLanguage:"de",currency:"EUR",bookingTimezone:"Europe/Vienna",source:"explicit"};
  const energyCertificate={version:1,countryCode:"AT",heatingDemandKwhM2:35,finalEnergyDemandKwhM2:58,energyClass:"A",issuedAt:"2026-09-01",validUntil:"2036-08-31"};
  await db.admin.query("update projects set type='Makler',customer_type='real_estate_broker' where id=$1",[fixture.projectId]);
  await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,city,region,object_type,area_sqm,rooms,year_built,market_value_cents,target_price_cents,public_price_cents,price_visibility,usage_type,marketing_type,canonical_payload,data_classification,data_purpose) values($1,$2,$3,'SYNTHETIC Seeblick Residences','Beispielstraße 1, 1010 Wien','Wien','Wien','Wohnung',92,3,2026,49500000,49500000,49500000,'publish_price','residential','sale',$4::jsonb,'NOVALURE_INTERNAL','crm_sales')",[propertyId,fixture.workspaceId,fixture.projectId,JSON.stringify({geography,energyCertificate})]);
  await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,rooms,area_sqm,price_cents,status,metadata,data_classification,data_purpose) values($1,$2,$3,'A-11',3,92,49500000,'available',$4::jsonb,'NOVALURE_INTERNAL','crm_sales')",[unitId,fixture.workspaceId,fixture.projectId,JSON.stringify({sellerListingId:propertyId})]);
  await db.admin.query("update seller_listings set unit_id=$2 where id=$1",[propertyId,unitId]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,owner_user_id,name,email,role,data_classification,data_purpose) values($1,$2,$3,$4,'SYNTHETIC Interessent','synthetic-expose@example.invalid','Käufer','NOVALURE_INTERNAL','crm_sales')",[contactId,fixture.workspaceId,fixture.projectId,fixture.userId]);
  await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status,intent,region,object_type,data_classification,data_purpose) values($1,$2,$3,$4,$5,'Website','Käufer','Neu','SYNTHETIC Exposé-Anfrage','Wien','Wohnung','NOVALURE_INTERNAL','crm_sales')",[leadId,fixture.workspaceId,fixture.projectId,contactId,fixture.userId]);
  // The server-side repository is loaded through the same explicit local test transport.
  const old={...process.env};
  Object.assign(process.env,{NODE_ENV:"test",CRM_LOCAL_TEST_DATABASE:"1",NOVALURE_AUTH_ENCRYPTION_KEY:encryptionKey,DATABASE_URL:`postgresql://${db.role}@127.0.0.1:${db.port}/postgres`});
  try {
    const {withCrmRead}=await import("../../src/lib/crm-command.ts");
    const {buildWebExposeSnapshot,publishWebExpose,createWebExposeLink}=await import("../../src/lib/db/web-expose-repository.ts");
    const {closeLocalTestPool}=await import("../../src/lib/db/local-test-transport.ts");
    const session={authenticated:true,source:"database",workspaceId:fixture.workspaceId,userId:fixture.userId,role:"owner",productRole:"novalureAdmin",workspaceName:"SYNTHETIC QA",name:"Synthetic owner",email:fixture.email,permissions:[],productPermissions:[]};
    const input={propertyId,language:"de",title:"Seeblick Residences · Beispiel",description:"Eine helle Wohnung mit großzügigem Wohnbereich. Dieses Objekt und sämtliche Kontakte sind fiktive Prüfdaten.\n\nDie Veröffentlichung, Anfrage und Nutzungsanalyse werden ausschließlich in einer lokalen Testumgebung geprüft.",controller:"SYNTHETIC Immobilien",privacyUrl:"https://example.invalid/privacy",legalUrl:"https://example.invalid/legal",showAddress:false,showContact:false,reviewed:true};
    const publication=await withCrmRead(session,async(tx,s)=>{
      const built=await buildWebExposeSnapshot(tx,s,input);
      return publishWebExpose(tx,s,{...input,expectedSourceFingerprint:built.sourceFingerprint});
    });
    const personal=await withCrmRead(session,(tx,s)=>createWebExposeLink(tx,s,{versionId:publication.id,label:"SYNTHETIC persönlicher Link",leadId,expiresAt:null}));
    await closeLocalTestPool();
    return {propertyId,unitId,contactId,leadId,versionId:publication.id,exposePath:publication.path,personalExposePath:personal.path};
  } finally {
    for(const key of Object.keys(process.env)) if(!(key in old)) delete process.env[key];
    Object.assign(process.env,old);
  }
}
