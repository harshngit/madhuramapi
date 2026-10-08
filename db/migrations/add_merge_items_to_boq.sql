-- Track which OTHER BOQ items (by boq_id) have been merged into this one
ALTER TABLE boqs
ADD COLUMN IF NOT EXISTS merge_items INTEGER[] DEFAULT '{}';
