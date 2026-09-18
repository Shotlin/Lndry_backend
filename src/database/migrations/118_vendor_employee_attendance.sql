-- 118_vendor_employee_attendance.sql
--
-- Daily staff attendance, ported from epic-laundry-desktop's
-- management.ts#markLaundryAttendance/laundryWorkforceDashboard. One mark
-- per employee per day — marking the same status twice is a harmless no-op
-- (epic returns `{duplicate: true}`), marking a *different* status the same
-- day is rejected (WORKFORCE_ATTENDANCE_ALREADY_MARKED in epic; same rule
-- enforced in the service layer here via the unique index below plus an
-- application-level check, since Postgres can't express "same value is ok,
-- different value is not" as a single constraint).

CREATE TABLE IF NOT EXISTS vendor_employee_attendance (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id      UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  employee_id    UUID NOT NULL REFERENCES vendor_employees(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  status         VARCHAR(10) NOT NULL CHECK (status IN ('PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'HOLIDAY')),
  shift          VARCHAR(40),
  in_time        VARCHAR(10),
  out_time       VARCHAR(10),
  working_hours  NUMERIC(5,2),
  note           VARCHAR(500),
  marked_by      UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_employee_attendance_day
  ON vendor_employee_attendance (employee_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_vendor_employee_attendance_vendor
  ON vendor_employee_attendance(vendor_id, attendance_date DESC);
