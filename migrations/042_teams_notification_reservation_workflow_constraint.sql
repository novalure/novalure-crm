alter table teams_notification_jobs
  drop constraint if exists teams_notification_jobs_alert_type_check;

alter table teams_notification_jobs
  add constraint teams_notification_jobs_alert_type_check
  check (
    alert_type in (
      'lead_sla_overdue',
      'lead_sla_due_soon',
      'meeting_booked',
      'customer_access_risk',
      'deal_stage_changed',
      'reservation_workflow'
    )
  );
