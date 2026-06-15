-- Add is_blocked column to auth_users table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'auth_users'
    AND column_name = 'is_blocked'
  ) THEN
    ALTER TABLE auth_users ADD COLUMN is_blocked BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

-- Create user_block_history table
CREATE TABLE IF NOT EXISTS user_block_history (
  history_id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth_users(user_id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('block', 'unblock')),
  reason TEXT,
  performed_by UUID REFERENCES auth_users(user_id),
  performed_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_block_history_user_id ON user_block_history(user_id);
CREATE INDEX IF NOT EXISTS idx_user_block_history_created_at ON user_block_history(created_at);
