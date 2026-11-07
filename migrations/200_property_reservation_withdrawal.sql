-- Add a distinct terminal business state without changing deadlines or historical rows.
-- Application withdrawal stays a current-authority, versioned command under existing RLS and audit.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table property_reservations drop constraint property_reservations_status_check;
alter table property_reservations add constraint property_reservations_status_check
  check(status in ('requested','hold','reserved','expired','converted','withdrawn'));
