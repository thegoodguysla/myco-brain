-- Migration 007: Audit trail (vc table + generic trigger)

-- ============================================================
-- VC — Version Control / Audit Trail
-- ============================================================
CREATE TABLE vc (
  vc_id        bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  table_name   text NOT NULL,
  row_id       uuid NOT NULL,
  column_name  text NOT NULL,
  old_value    jsonb,
  new_value    jsonb,
  operation    text NOT NULL CHECK (operation IN ('insert','update','delete')),
  actor_kind   text NOT NULL CHECK (actor_kind IN ('human','program','llm','agent')),
  actor_id     text NOT NULL,
  reason       text,             -- 'ingest'|'promotion'|'manual_edit'|'rollback'
  changed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON vc (workspace_id, table_name, row_id, changed_at DESC);
CREATE INDEX ON vc (workspace_id, changed_at DESC);

-- ============================================================
-- Generic audit trigger function
-- Usage:
--   CREATE TRIGGER audit_<table>
--     AFTER INSERT OR UPDATE OR DELETE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION audit_row_changes();
--
-- Caller sets session locals before any write:
--   SET LOCAL app.actor_kind = 'program';
--   SET LOCAL app.actor_id   = 'ingest-worker-v1';
--   SET LOCAL app.reason     = 'ingest';
-- ============================================================
CREATE OR REPLACE FUNCTION audit_row_changes()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  _actor_kind text := coalesce(current_setting('app.actor_kind', true), 'program');
  _actor_id   text := coalesce(current_setting('app.actor_id',   true), 'unknown');
  _reason     text := current_setting('app.reason', true);
  _workspace  uuid;
  _row_id     uuid;
  _col        text;
  _old_val    jsonb;
  _new_val    jsonb;
  _old_rec    jsonb;
  _new_rec    jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    _old_rec := row_to_json(OLD)::jsonb;
    _new_rec := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    _old_rec := NULL;
    _new_rec := row_to_json(NEW)::jsonb;
  ELSE
    _old_rec := row_to_json(OLD)::jsonb;
    _new_rec := row_to_json(NEW)::jsonb;
  END IF;

  -- Extract workspace_id and primary key (assumed column name pattern)
  _workspace := COALESCE(
    (_new_rec->>'workspace_id')::uuid,
    (_old_rec->>'workspace_id')::uuid
  );

  -- Find the first uuid column that ends in _id as the row identifier
  SELECT (COALESCE(_new_rec, _old_rec)->>col_name)::uuid
  INTO _row_id
  FROM (
    SELECT key AS col_name
    FROM jsonb_object_keys(COALESCE(_new_rec, _old_rec)) AS t(key)
    WHERE key LIKE '%_id'
    ORDER BY key
    LIMIT 1
  ) id_col;

  -- For INSERT: log each non-null new column
  IF TG_OP = 'INSERT' THEN
    FOR _col IN SELECT key FROM jsonb_object_keys(_new_rec) AS t(key) LOOP
      _new_val := _new_rec->_col;
      IF _new_val IS NOT NULL AND _new_val != 'null'::jsonb THEN
        INSERT INTO vc(workspace_id, table_name, row_id, column_name,
                       old_value, new_value, operation, actor_kind, actor_id, reason)
        VALUES(_workspace, TG_TABLE_NAME, _row_id, _col,
               NULL, _new_val, 'insert', _actor_kind, _actor_id, _reason);
      END IF;
    END LOOP;

  -- For UPDATE: log only changed columns
  ELSIF TG_OP = 'UPDATE' THEN
    FOR _col IN SELECT key FROM jsonb_object_keys(_new_rec) AS t(key) LOOP
      _old_val := _old_rec->_col;
      _new_val := _new_rec->_col;
      IF _old_val IS DISTINCT FROM _new_val THEN
        INSERT INTO vc(workspace_id, table_name, row_id, column_name,
                       old_value, new_value, operation, actor_kind, actor_id, reason)
        VALUES(_workspace, TG_TABLE_NAME, _row_id, _col,
               _old_val, _new_val, 'update', _actor_kind, _actor_id, _reason);
      END IF;
    END LOOP;

  -- For DELETE: log a single tombstone row
  ELSE
    INSERT INTO vc(workspace_id, table_name, row_id, column_name,
                   old_value, new_value, operation, actor_kind, actor_id, reason)
    VALUES(_workspace, TG_TABLE_NAME, _row_id, '*',
           _old_rec, NULL, 'delete', _actor_kind, _actor_id, _reason);
  END IF;

  RETURN NULL;
END;
$$;

-- Attach audit triggers to key tables
CREATE TRIGGER audit_hyobjects
  AFTER INSERT OR UPDATE OR DELETE ON hyobjects
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes();

CREATE TRIGGER audit_people
  AFTER INSERT OR UPDATE OR DELETE ON people
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes();

CREATE TRIGGER audit_entities
  AFTER INSERT OR UPDATE OR DELETE ON entities
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes();

CREATE TRIGGER audit_hypeoplerelations
  AFTER INSERT OR UPDATE OR DELETE ON hypeoplerelations
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes();

CREATE TRIGGER audit_entity_relations
  AFTER INSERT OR UPDATE OR DELETE ON entity_relations
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes();
