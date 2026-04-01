-- PR Email Logs and Attachments
CREATE TABLE IF NOT EXISTS pr_email_attachments (
    attachment_id SERIAL PRIMARY KEY,
    pr_id INTEGER REFERENCES purchase_requisitions(pr_id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes BIGINT,
    uploaded_by_user_id UUID,
    uploaded_by_name TEXT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pr_email_logs (
    log_id SERIAL PRIMARY KEY,
    pr_id INTEGER REFERENCES purchase_requisitions(pr_id) ON DELETE CASCADE,
    sent_to TEXT NOT NULL,
    cc_addresses TEXT[],
    subject TEXT,
    custom_message TEXT,
    attachment_names TEXT[],
    status TEXT, -- 'sent', 'failed'
    error_message TEXT,
    nodemailer_msg_id TEXT,
    sent_by_user_id UUID,
    sent_by_name TEXT,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PO Email Logs and Attachments
CREATE TABLE IF NOT EXISTS po_email_attachments (
    attachment_id SERIAL PRIMARY KEY,
    po_id INTEGER REFERENCES pos(po_id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes BIGINT,
    uploaded_by_user_id UUID,
    uploaded_by_name TEXT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS po_email_logs (
    log_id SERIAL PRIMARY KEY,
    po_id INTEGER REFERENCES pos(po_id) ON DELETE CASCADE,
    sent_to TEXT NOT NULL,
    cc_addresses TEXT[],
    subject TEXT,
    custom_message TEXT,
    attachment_names TEXT[],
    status TEXT, -- 'sent', 'failed'
    error_message TEXT,
    nodemailer_msg_id TEXT,
    sent_by_user_id UUID,
    sent_by_name TEXT,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_pr_email_logs_pr_id ON pr_email_logs(pr_id);
CREATE INDEX IF NOT EXISTS idx_pr_email_logs_user_id ON pr_email_logs(sent_by_user_id);
CREATE INDEX IF NOT EXISTS idx_po_email_logs_po_id ON po_email_logs(po_id);
CREATE INDEX IF NOT EXISTS idx_po_email_logs_user_id ON po_email_logs(sent_by_user_id);

-- MIR Email Logs and Attachments
CREATE TABLE IF NOT EXISTS mir_email_attachments (
    attachment_id SERIAL PRIMARY KEY,
    mir_id INTEGER REFERENCES mirs(mir_id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes BIGINT,
    uploaded_by_user_id UUID,
    uploaded_by_name TEXT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mir_email_logs (
    log_id SERIAL PRIMARY KEY,
    mir_id INTEGER REFERENCES mirs(mir_id) ON DELETE CASCADE,
    sent_to TEXT NOT NULL,
    cc_addresses TEXT[],
    subject TEXT,
    custom_message TEXT,
    attachment_names TEXT[],
    status TEXT, -- 'sent', 'failed'
    error_message TEXT,
    nodemailer_msg_id TEXT,
    sent_by_user_id UUID,
    sent_by_name TEXT,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mir_email_logs_mir_id ON mir_email_logs(mir_id);
CREATE INDEX IF NOT EXISTS idx_mir_email_logs_user_id ON mir_email_logs(sent_by_user_id);
