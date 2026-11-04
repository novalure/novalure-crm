import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { bookingBody, bookingFailure, bookingJson, bookingProvider } from "@/app/api/booking/_http";
import { listPersonalCalendarEvents, mutatePersonalCalendar } from "@/lib/db/personal-calendar-repository";
import { BookingConnectionError, listBookingConnections, refreshBookingCalendars, selectBookingCalendars } from "@/lib/booking/connections";
import { withBookingTransaction } from "@/lib/booking/repository";
import { CrmCommandError, crmCommandErrorResponse } from "@/lib/crm-command";
import { BookingError } from "@/lib/booking/types";
export const maxDuration = 60;
function failure(error:unknown) {
  if(error instanceof CrmCommandError)return crmCommandErrorResponse(error);
  if(error instanceof BookingConnectionError)return bookingJson({error:error.code},error.status);
  if(error instanceof BookingError){
    const notStarted=["invalid_json","body_too_large","personal_calendar_actor_changed","personal_calendar_unknown_field","personal_calendar_duplicate_attendee","personal_calendar_version_conflict","personal_calendar_snapshot_changed","personal_calendar_project_immutable","personal_calendar_unresolved_operation","personal_calendar_reconcile_required"].includes(error.code)||error.code.startsWith("personal_calendar_invalid_");
    // A fresh permission failure can occur after provider transmission. Only
    // enumerated pre-write validation errors prove that a new intent is editable.
    return bookingJson({error:error.code,notStarted},error.status);
  }
  return bookingFailure(error);
}
export async function GET(request:Request) {
  const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:write",capability:"calendar:manage"});
  if(!auth.ok)return auth.response;
  try{
    const events=await listPersonalCalendarEvents(auth.session);
    const connections=await listBookingConnections({workspaceId:auth.session.workspaceId,actorId:auth.session.userId});
    return bookingJson({workspaceId:auth.session.workspaceId,actorId:auth.session.userId,events,connections,recurrence:{creationSupported:false,busyInstancesRead:true}});
  }catch(error){return failure(error);}
}
export async function POST(request:Request) {
  const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:write",capability:"calendar:manage"});
  if(!auth.ok)return auth.response;
  try{
    const body=await bookingBody(request,32768);
    if(body.expectedActorId!==auth.session.userId)throw new BookingError("personal_calendar_actor_changed",403);
    if(body.action==="refresh_calendars"||body.action==="select_calendar"){
      await withBookingTransaction(auth.session,async()=>undefined);
      const provider=bookingProvider(body),scope={workspaceId:auth.session.workspaceId,actorId:auth.session.userId};
      const connection=body.action==="refresh_calendars"?(await refreshBookingCalendars(scope,provider)).connection
        :await selectBookingCalendars(scope,provider,{writeCalendarId:body.writeCalendarId as string,conflictCalendarIds:body.conflictCalendarIds as string[]});
      return bookingJson({connection});
    }
    const event=await mutatePersonalCalendar(auth.session,body);
    return bookingJson({event,confirmed:event.state==="synced"||event.state==="cancelled"},["processing","uncertain"].includes(event.state)?202:200);
  }catch(error){return failure(error);}
}
