-- Migration 034: THE-446 — Add updated_at trigger on tenants table
--
-- The tenants table has updated_at but no BEFORE UPDATE trigger,
-- so any update to tenants.status or tenants.settings leaves
-- updated_at stuck at creation time.
-- Reuses the existing set_updated_at() function from migration 0003.

CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
