"use client";
import { useId } from "react";
import type { TenantId } from "./types";
import { TENANTS } from "./types";

const paths: Record<string, React.ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  users: <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5"/></>,
  layers: <><path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/></>,
  sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4"/></>,
  book: <><path d="M12 5C9 2 5 3 2 4v16c3-1 7-2 10 1 3-3 7-2 10-1V4c-3-1-7-2-10 1v16Z"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  chevron: <path d="m8 10 4 4 4-4"/>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  plus: <path d="M12 4v16M4 12h16"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>,
  file: <><path d="M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 13h8M8 17h6"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6M17 2v6M3 11h18M7 15h2m4 0h2"/></>,
  settings: <><path d="m10 3-1 3-3 1-3 3 2 2-1 4 3 1 2 4 3-1 3 1 2-4 3-1-1-4 2-2-3-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></>,
  chat: <><path d="M21 11a9 9 0 0 1-9 9H3l1-5A9 9 0 1 1 21 11Z"/><path d="M8 10h8M8 14h5"/></>,
  phone: <path d="m5 3 4 3-2 4 7 7 4-2 3 4c-4 8-23-11-16-16Z"/>,
  chart: <><path d="M3 3v18h18M7 16l4-5 4 2 6-8"/></>,
  building: <><path d="M4 21V5l8-3 8 3v16M2 21h20M9 21v-4h6v4M8 7h1m6 0h1M8 11h1m6 0h1"/></>,
  wallet: <><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 8V4l14-2v3M16 11h5v5h-5z"/></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  bell: <><path d="M5 16h14l-2-4V9a5 5 0 0 0-10 0v3l-2 4ZM10 20h4"/></>,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/></>,
  shield: <><path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z"/><path d="m8 12 3 3 5-6"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/></>,
  monitor: <><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4M7 21h10"/></>,
  mobile: <><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/></>,
};
export function Icon({name,size=20,className=""}:{name:string;size?:number;className?:string}) {return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name]||paths.sparkles}</svg>;}
export function Brand(){return <span className="brand"><span className="brand-mark">e<span>✳</span></span><span>evelyn<span className="brand-dot">.</span></span></span>;}
export function Avatar({name="MS",color}:{name?:string;color?:string}){return <span className="avatar" style={color?{background:color,color:"white"}:undefined}>{name}</span>;}
export function Status({children,tone="green"}:{children:React.ReactNode;tone?:string}){return <span className={`status status-${tone}`}><span/>{children}</span>;}
export function TenantSelect({tenant,onChange}:{tenant:TenantId;onChange:(t:TenantId)=>void}){const id=useId();return <label className="tenant-picker" htmlFor={id}><span className="tenant-monogram">{TENANTS[tenant].short}</span><span className="tenant-label"><small>DEMO-MANDANT</small><select id={id} value={tenant} onChange={e=>onChange(e.target.value as TenantId)} aria-label="Demo-Mandant wechseln"><option value="atelier">Atelier Nord</option><option value="haven">Haven Estates</option></select></span><Icon name="chevron" size={15}/></label>;}
export function LineChart({color="currentColor",compact=false}:{color?:string;compact?:boolean}){const id=useId().replace(/:/g,"");return <svg className={compact?"line-chart compact":"line-chart"} viewBox="0 0 640 200" role="img" aria-label="Demo-Umsatz steigt von Mai bis Oktober von 18.000 auf 48.250 Euro"><defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".16"/><stop offset="100%" stopColor={color} stopOpacity="0"/></linearGradient></defs>{[30,80,130,180].map(y=><line key={y} x1="0" y1={y} x2="640" y2={y} stroke="currentColor" opacity=".09" strokeDasharray="3 5"/>)}<path d="M0 160C40 160 55 125 90 135S140 155 185 110 235 130 280 86 330 110 380 60 435 85 480 42 530 70 575 25 610 35 640 15V200H0Z" fill={`url(#${id})`}/><path d="M0 160C40 160 55 125 90 135S140 155 185 110 235 130 280 86 330 110 380 60 435 85 480 42 530 70 575 25 610 35 640 15" stroke={color} strokeWidth="3" fill="none"/>{!compact&&["Mai","Jun","Jul","Aug","Sep","Okt"].map((m,i)=><text key={m} x={i*120+10} y="197" fill="currentColor" fontSize="11" opacity=".5">{m}</text>)}</svg>;}
