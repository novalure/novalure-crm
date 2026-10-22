import "server-only";
import { randomUUID } from "node:crypto";
import { hasDatabaseUrl, queryRows } from "@/lib/db/client";

type Admission = { bucketAt: string; jobIds: string[]; leaseOwner: string };
type AdmissionOptions = { now?: number; query?: typeof queryRows };
export async function canReadLegacyMeetingReminderQueue(options: AdmissionOptions = {}) {
  if (!options.query && !hasDatabaseUrl()) return false;
  const rows = await (options.query ?? queryRows)<{ allowed: boolean }>(`select has_table_privilege(current_user,'public.meeting_notification_jobs','SELECT') as allowed`);
  return rows[0]?.allowed === true;
}
/** The most recent original hourly tick, including delayed invocations. */
export function meetingReminderBucket(now: number) {
  return Math.floor((now - 2 * 60_000) / 3_600_000) * 3_600_000 + 2 * 60_000;
}
export async function claimMeetingReminderAdmission(options: AdmissionOptions = {}): Promise<Admission | null> {
  // The existing cutover deliberately retired the broad legacy runtime grant.
  // A faster booking tick must not restore it or adopt that historical queue.
  if (!await canReadLegacyMeetingReminderQueue(options)) return null;
  const now = options.now ?? Date.now(), bucket = meetingReminderBucket(now), leaseOwner = randomUUID();
  const rows = await (options.query ?? queryRows)<Admission>(`with mutex as (
      select pg_try_advisory_xact_lock(hashtextextended('meeting-notifications-hourly-admission',0)) as acquired
    ), candidates as (
      select id from meeting_notification_jobs where (
        status in ('queued','retry') and available_at<=to_timestamp($1::double precision/1000)
          and scheduled_for<=to_timestamp($1::double precision/1000) and attempt_count<max_attempts
      ) or (status='sending' and lease_expires_at<=to_timestamp($1::double precision/1000) and attempt_count<max_attempts)
      order by available_at,scheduled_for,id limit 25
    ) insert into meeting_reminder_admission(worker_key,bucket_at,job_ids,lease_owner,lease_until)
      select 'meeting-notifications-hourly',to_timestamp($2::double precision/1000),array(select id from candidates),$3::uuid,to_timestamp($4::double precision/1000)
      from mutex where acquired
    on conflict(worker_key) do update set
      bucket_at=excluded.bucket_at,
      job_ids=case when meeting_reminder_admission.bucket_at<excluded.bucket_at then excluded.job_ids else meeting_reminder_admission.job_ids end,
      lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,completed_at=null,updated_at=now()
    where meeting_reminder_admission.bucket_at<excluded.bucket_at or (
      meeting_reminder_admission.bucket_at=excluded.bucket_at and meeting_reminder_admission.completed_at is null
        and meeting_reminder_admission.lease_until<=to_timestamp($1::double precision/1000))
    returning bucket_at as "bucketAt",job_ids as "jobIds",lease_owner as "leaseOwner"`, [now,bucket,leaseOwner,now+90_000]);
  return rows[0] ?? null;
}
export async function completeMeetingReminderAdmission(admission: Admission, options: AdmissionOptions = {}) {
  await (options.query ?? queryRows)(`update meeting_reminder_admission set completed_at=to_timestamp($3::double precision/1000),lease_owner=null,lease_until=null,updated_at=now()
    where worker_key='meeting-notifications-hourly' and bucket_at=$1::timestamptz and lease_owner=$2::uuid`,
  [admission.bucketAt,admission.leaseOwner,options.now ?? Date.now()]);
}
