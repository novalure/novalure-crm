import path from 'node:path';
/** Explicit synthetic replica of the observed94sqm/3room/null-unit browser case.
 * This is not a claim that an earlier browser-created DB row was retained.
 */
export async function seedPropertyAssignmentRegression(db,fixture){
 const directory=typeof db.directory==='string'?path.resolve(db.directory):'',prefix=path.resolve('.npm-cache','qa')+path.sep+'sales-pg-';
 if(!directory.startsWith(prefix)||db.admin?.options?.host!=='127.0.0.1'||!/^sales_qa_[a-f0-9]{12}$/.test(db.role)||fixture.email!==`synthetic-sales-${String(fixture.userId).replaceAll('-','')}@example.invalid`)throw new Error('Property regression requires the owned disposable synthetic fixture');
 const id='2c88cb22-97ba-405a-b505-31758401656c';
 const geography={version:1,countryCode:'DE',region:'Berlin',displayLocale:'de-DE',contentLanguage:'de',currency:'EUR',bookingTimezone:'Europe/Berlin',source:'explicit'};
 const marker={synthetic:true,mode:'replica_of_browser_observed_fields',observedPropertyId:id};
 const row=await db.admin.query(`insert into seller_listings(id,workspace_id,project_id,title,address,city,region,object_type,area_sqm,rooms,year_built,target_price_cents,public_price_cents,unit_id,property_status,price_visibility,canonical_payload,data_classification,data_purpose)
  select $1::uuid,$2::uuid,$3::uuid,'SYNTHETIC Berlin · Zuordnungsprüfung','Beispielstraße 94, Berlin','Berlin','Berlin','Wohnung',94,3,2026,0,0,null,'draft','publish_price',$4::jsonb,'NOVALURE_INTERNAL','crm_sales'
  from workspaces w join workspace_users u on u.workspace_id=w.id where w.id=$2::uuid and u.id=$5::uuid and w.name='SYNTHETIC SALES QA' and u.email=$6 and u.name='Synthetic sales owner' and exists(select 1 from projects p where p.id=$3::uuid and p.workspace_id=w.id) returning id`,[id,fixture.workspaceId,fixture.projectId,JSON.stringify({geography,qaAssignmentRegression:marker}),fixture.userId,fixture.email]);
 if(row.rowCount!==1)throw new Error('Synthetic property regression source not found');
 return{assignmentRegressionPropertyId:id,assignmentRegressionState:'synthetic_replica_94sqm_3rooms_price0_no_unit'};
}
