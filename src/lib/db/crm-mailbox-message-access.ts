import 'server-only';
import type {AppSession} from '../auth/session';
import {assertCrmUuid,assertProjectGrant,CrmCommandError,type TenantTransaction} from '../crm-command';

/**
 * An unassociated personal copy belongs to its authenticated owner. Once the
 * server records a reviewed CRM association, private bytes and their metadata
 * additionally require the current project's read grant. Never infer scope
 * from a browser-supplied project or the existence of a previous send job.
 */
export async function assertPersonalMailboxMessageAccess(tx:TenantTransaction,session:AppSession,messageId:string){
 const own=await tx.queryOne('select id from crm_mailbox_messages where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid and deleted_at is null for share',[assertCrmUuid(messageId),session.workspaceId,session.userId]);
 if(!own)throw new CrmCommandError('NOT_FOUND','Eigene Nachricht nicht verfügbar.',404);
 const manual=await tx.query<{projectId:string}>('select project_id as "projectId" from crm_mailbox_links where workspace_id=$1::uuid and user_id=$2::uuid and message_id=$3::uuid for share',[session.workspaceId,session.userId,messageId]);
 const filed=await tx.query<{projectId:string}>("select project_id as \"projectId\" from crm_mailbox_private_decisions where workspace_id=$1::uuid and user_id=$2::uuid and message_id=$3::uuid and status='filed' for share",[session.workspaceId,session.userId,messageId]);
 // If two recorded associations disagree, both scopes must be readable.
 for(const projectId of new Set([...manual,...filed].map(value=>value.projectId)))await assertProjectGrant(tx,session,projectId,false);
}
