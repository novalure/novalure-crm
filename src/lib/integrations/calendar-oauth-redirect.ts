import { resolveSafeLocalRedirect } from "@/lib/security/redirects";
/** Only the latest callback result survives. Preserve its signed safe scope. */
export function calendarOAuthResultRedirect(returnTo:string, trustedOrigin:string, result:{connected?:"microsoft"|"google";error?:string}) {
  const safe=resolveSafeLocalRedirect(returnTo,{blockedPathPrefixes:["/api","/login"],fallback:"/#calendar",trustedOrigin});
  const url=new URL(safe,trustedOrigin);
  url.searchParams.delete("calendar_error");url.searchParams.delete("calendar_connected");
  if(result.error)url.searchParams.set("calendar_error",result.error.slice(0,200));
  else if(result.connected)url.searchParams.set("calendar_connected",result.connected);
  return url;
}
