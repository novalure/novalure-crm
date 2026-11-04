import {getRolePermissions} from '@/lib/auth/permissions';
import {hasProductCapability,type ProductRole,type TechnicalAppRole} from '@/lib/product-model';
/** Preview existing grants; this does not derive permissions from a navigation preset. */
export function RoleActionExplanation({role,productRole,language}:{role:TechnicalAppRole;productRole:ProductRole;language:string}){
 const de=language==='de',permissions=getRolePermissions(role),write=permissions.includes('crm:write');
 const rows=[
  [de?'CRM bearbeiten':'Edit CRM',write&&hasProductCapability(productRole,'workspace:operate')],
  [de?'Pipeline bearbeiten':'Edit pipeline',write&&hasProductCapability(productRole,'pipeline:write')],
  [de?'Reservierungsaktionen':'Reservation actions',write&&hasProductCapability(productRole,'reservations:write')],
  [de?'Firmenvorlagen verwalten':'Manage company templates',write&&hasProductCapability(productRole,'settings:manage')],
  [de?'Kundenzugriffe verwalten':'Manage customer access',write&&hasProductCapability(productRole,'customer-access:manage')],
  [de?'Newsletter versenden':'Send newsletters',permissions.includes('newsletter:send')&&hasProductCapability(productRole,'newsletter:send')],
 ] as const;
 return <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 text-sm"><p className="font-semibold">{de?'Was diese Rollenkombination ermöglicht':'What this role combination enables'}</p><dl className="mt-3 grid gap-2">{rows.map(([label,enabled])=><div key={label} className="flex justify-between gap-3"><dt>{label}</dt><dd className="font-semibold">{enabled?(de?'Grundsätzlich möglich':'Available in principle'):(de?'Nicht freigegeben':'Not granted')}</dd></div>)}</dl><p className="mt-3 text-xs leading-5 text-stone-600">{productRole==='external_partner'?(de?'Externe Partner erhalten ausschließlich ausdrücklich freigegebene Objekte und pseudonyme Anfragen. Die Partnerrolle allein eröffnet keine allgemeine CRM-Akte.':'External partners receive only explicitly shared properties and pseudonymous enquiries. The partner role alone does not open general CRM records.'):(de?'Projektfreigaben und Zuständigkeiten begrenzen jede einzelne Aktion zusätzlich. Ein anderes Ansichtsprofil ändert keine Berechtigungen.':'Project grants and ownership further restrict each action. A different view profile does not change permissions.')}</p></div>;
}
