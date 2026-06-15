-- Add 'half_day' to the status CHECK constraint for attendance table
ALTER TABLE attendance 
DROP CONSTRAINT IF EXISTS attendance_status_check;

ALTER TABLE attendance 
ADD CONSTRAINT attendance_status_check CHECK (status IN ('pending', 'present', 'absent', 'half_day'));
