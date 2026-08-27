-- ─────────────────────────────────────────────────────────────────────────────
-- Fix activity_log.entity_id / notifications.entity_id: declared INTEGER, but
-- several modules (Sample, Installation) log activity against non-numeric
-- string ids (e.g. "SAMPLE-001", "INSTALL-001"). Every logActivity() insert
-- for those silently failed (caught and only console.error'd — the request
-- itself always succeeded) and never got recorded, so history for those
-- entities was silently empty. Mirrors the earlier TEXT migration already
-- done for inventory_movements.source_id / inventory_history.source_id for
-- the same reason.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE activity_log   ALTER COLUMN entity_id TYPE TEXT USING entity_id::TEXT;
ALTER TABLE notifications  ALTER COLUMN entity_id TYPE TEXT USING entity_id::TEXT;
