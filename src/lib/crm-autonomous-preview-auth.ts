import "server-only";
import {createHash} from "node:crypto";
import {verifyVercelOidcToken} from "@vercel/oidc";
import {CrmMachineAuthError,CRM_MACHINE_ISSUER,CRM_MACHINE_OWNER_ID,CRM_MACHINE_PROJECT_ID,CRM_MACHINE_WORKSPACE_ID,type CrmMachineAuthOptions} from "./crm-machine-auth";
import {resolveDatabaseUrl} from "./db/client";
import {studioEnquiryProject} from "./studio-enquiry-contract";
import {isWebsiteSalesPreviewTarget} from "./website-sales-preview-auth";
import type {AutonomousReceiverPins} from "./crm-autonomous-receiver";

export const autonomousPreviewIdentity="EVELYN_CRM_AUTONOMOUS_QA_IDENTITY";
export const autonomousPreviewAudience=`urn:novalure:crm:autonomous-access-v2:preview:${studioEnquiryProject}`;
export const autonomousPreviewSubject="owner:novalure:project:evelyn:environment:preview";
export type AutonomousPreviewReceiver=Readonly<{deploymentId:string;revision:string;origin:string}>;
function denied():never{throw new CrmMachineAuthError("AUTONOMOUS_PREVIEW_DENIED",403);}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Server-owned opt-in and platform origin select this profile; the body cannot. */
export function resolveAutonomousPreview(request:Request,env:NodeJS.ProcessEnv):AutonomousPreviewReceiver|null {
 if(env.VERCEL_ENV!=="preview")return null;
 const url=new URL(request.url),target={deploymentId:env.VERCEL_DEPLOYMENT_ID??"",revision:env.VERCEL_GIT_COMMIT_SHA??""};
 if(env.CRM_AUTONOMOUS_PREVIEW_ENABLED!=="1"||env.CRM_MACHINE_AUTH_ENABLED!=="1"||env.VERCEL!=="1"||env.VERCEL_PROJECT_ID!==studioEnquiryProject||
  (env.VERCEL_TARGET_ENV&&env.VERCEL_TARGET_ENV!=="preview")||!isWebsiteSalesPreviewTarget(target)||
  url.protocol!=="https:"||url.hostname!==env.VERCEL_URL||!url.hostname.endsWith(".vercel.app")||url.port||url.username||url.password||url.hash)denied();
 let db:URL;try{db=new URL(resolveDatabaseUrl(env));}catch{return denied();}
 if(db.protocol!=="postgresql:"||(db.port&&db.port!=="5432")||!/^ep-summer-dew-bht4t903-pooler\.[a-z0-9.-]+\.neon\.tech$/.test(db.hostname)||
  db.pathname!=="/neondb"||db.username!=="novalure_app"||!['require','verify-full'].includes(db.searchParams.get('sslmode')??'')||
  db.searchParams.getAll('sslmode').length!==1||db.searchParams.getAll('channel_binding').length>1||
  (db.searchParams.has('channel_binding')&&db.searchParams.get('channel_binding')!=='require')||[...db.searchParams.keys()].some(k=>!['sslmode','channel_binding'].includes(k)))denied();
 return Object.freeze({...target,origin:url.origin});
}
export function assertAutonomousPreviewReceiver(pins:AutonomousReceiverPins|null,receiver:AutonomousPreviewReceiver,request:Request,env:NodeJS.ProcessEnv) {
 const current=resolveAutonomousPreview(request,env);
 if(!pins||!current||current.deploymentId!==receiver.deploymentId||current.revision!==receiver.revision||current.origin!==receiver.origin||
  pins.receiverDeploymentId!==receiver.deploymentId||pins.receiverRevision!==receiver.revision)denied();
}
/** Separate Preview claims and audience; the Production and personal verifiers stay strict. */
export async function verifyAutonomousPreviewToken(token:string,options:CrmMachineAuthOptions={}) {
 const now=options.now??new Date(),seconds=Math.floor(now.valueOf()/1000);
 const v=await(options.verifier??verifyVercelOidcToken)(token,{algorithms:['RS256'],typ:'JWT',issuer:CRM_MACHINE_ISSUER,audience:autonomousPreviewAudience,
  ownerId:CRM_MACHINE_OWNER_ID,projectId:CRM_MACHINE_PROJECT_ID,environment:'preview',currentDate:now,maxTokenAge:'5m',clockTolerance:0,
  requiredClaims:['iss','aud','sub','iat','nbf','exp','jti']}).catch(denied);
 const p=v.payload,h=v.protectedHeader;
 if(h.alg!=='RS256'||h.typ!=='JWT'||typeof h.kid!=='string'||!h.kid||p.iss!==CRM_MACHINE_ISSUER||p.aud!==autonomousPreviewAudience||
  p.sub!==autonomousPreviewSubject||p.owner_id!==CRM_MACHINE_OWNER_ID||p.project_id!==CRM_MACHINE_PROJECT_ID||p.environment!=='preview'||
  typeof p.jti!=='string'||!uuid.test(p.jti)||typeof p.iat!=='number'||!Number.isSafeInteger(p.iat)||typeof p.nbf!=='number'||!Number.isSafeInteger(p.nbf)||
  typeof p.exp!=='number'||!Number.isSafeInteger(p.exp)||p.iat>seconds||p.iat<=seconds-300||p.nbf>seconds||p.exp<=seconds||p.exp<=p.iat)denied();
 return Object.freeze({identityId:autonomousPreviewIdentity,issuer:CRM_MACHINE_ISSUER,audience:autonomousPreviewAudience,projectId:CRM_MACHINE_PROJECT_ID,
  ownerId:CRM_MACHINE_OWNER_ID,subject:autonomousPreviewSubject,workspaceId:CRM_MACHINE_WORKSPACE_ID,environment:'preview' as const,role:'Evelyn.QA' as const,
  consumer:'EVELYN' as const,jtiHash:createHash('sha256').update(p.jti).digest('hex'),expiresAt:Math.min(p.exp,p.iat+300)});
}
