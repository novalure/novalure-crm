/** Pure validation for persistent Flow B commands. */
export class PropertySalesValidationError extends Error {}
export const salesActions = ['authority.assign','qualification.save','handover.create','viewing.save','reservation.request','reservation.confirm','reservation.extend','reservation.expire','sale.confirm','unit.price.confirm'] as const;
export type PropertySalesAction = typeof salesActions[number];
export type SalesPriority = 'high' | 'medium' | 'low';
export type BuyerQualification = {budgetFrom:number;budgetTo:number;financingStatus:string;purchaseTimeline:string;useCase:'Eigennutzung'|'Anlage';desiredUnitId:string;priority:SalesPriority;sourceReference:string};
export function salesText(value:unknown,label:string,max=2000):string {
 if(typeof value!=='string'||!value.trim()||value.trim().length>max) throw new PropertySalesValidationError(label+' is required');
 return value.trim();
}
export function salesUuid(value:unknown,label:string):string {
 const result=salesText(value,label,36);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new PropertySalesValidationError(label+' must be a UUID');
 return result;
}
export function salesVersion(value:unknown):number {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1) throw new PropertySalesValidationError('expectedVersion is required');
 return value;
}
export function validateQualification(value:Record<string,unknown>):BuyerQualification {
 const budgetFrom=value.budgetFrom,budgetTo=value.budgetTo;
 if(typeof budgetFrom!=='number'||typeof budgetTo!=='number'||!Number.isSafeInteger(budgetFrom*100)||!Number.isSafeInteger(budgetTo*100)||budgetFrom<0||budgetTo<=0||budgetTo<budgetFrom) throw new PropertySalesValidationError('A complete valid budget range is required');
 const financingStatus=salesText(value.financingStatus,'financingStatus');
 if(!['offen','vorqualifiziert','Eigenmittel','Finanzierungszusage'].includes(financingStatus)) throw new PropertySalesValidationError('Invalid financing status');
 const purchaseTimeline=salesText(value.purchaseTimeline,'purchaseTimeline',200);
 if(value.useCase!=='Eigennutzung'&&value.useCase!=='Anlage') throw new PropertySalesValidationError('useCase is required');
 if(value.priority!=='high'&&value.priority!=='medium'&&value.priority!=='low') throw new PropertySalesValidationError('priority is required');
 return {budgetFrom,budgetTo,financingStatus,purchaseTimeline,useCase:value.useCase,priority:value.priority,desiredUnitId:salesUuid(value.desiredUnitId,'desiredUnitId'),sourceReference:salesText(value.sourceReference,'sourceReference')};
}
export function validateViewing(value:Record<string,unknown>,previous?:string) {
 const startsAt=salesText(value.startsAt,'startsAt'),endsAt=salesText(value.endsAt,'endsAt'),timeZone=salesText(value.timeZone,'timeZone',100);
 if(!/(Z|[+-]\d{2}:\d{2})$/.test(startsAt)||!/(Z|[+-]\d{2}:\d{2})$/.test(endsAt)||!Number.isFinite(Date.parse(startsAt))||!Number.isFinite(Date.parse(endsAt))||Date.parse(endsAt)<=Date.parse(startsAt)) throw new PropertySalesValidationError('Explicit valid start/end with offset are required');
 try{new Intl.DateTimeFormat('en',{timeZone}).format()}catch{throw new PropertySalesValidationError('Invalid IANA time zone')}
 const status=salesText(value.status,'status');
 const allowed:Record<string,string[]>={new:['planned'],planned:['planned','confirmed','cancelled'],confirmed:['confirmed','completed','cancelled','no_show'],completed:[],cancelled:[],no_show:[]};
 if(!(allowed[previous??'new']??[]).includes(status)) throw new PropertySalesValidationError('Invalid viewing transition');
 return {startsAt,endsAt,timeZone,status};
}
export function assertReservationTransition(action:string,status:string,unitStatus:string) {
 const allowed=action==='reservation.request'?status==='new'&&unitStatus==='available'
 :action==='reservation.confirm'?status==='requested'&&unitStatus==='available'
 :action==='reservation.extend'?status==='reserved'&&unitStatus==='reserved'
 :action==='reservation.expire'?['requested','reserved'].includes(status)&&['available','reserved'].includes(unitStatus)
 :action==='sale.confirm'?status==='reserved'&&unitStatus==='reserved':false;
 if(!allowed) throw new PropertySalesValidationError('Invalid reservation/unit transition');
}
