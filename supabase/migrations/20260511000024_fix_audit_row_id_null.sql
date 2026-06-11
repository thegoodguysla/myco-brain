-- Migration 024: Fix null row_id in vc audit trail when table PK is not alphabetically-first _id column
--
-- Problem: audit_row_changes() used ORDER BY key to pick the first _id column
-- alphabetically. For ingestion_sources, composio_conn_id (nullable) sorts before
-- source_id (PK), causing null row_id constraint violations.
--
-- Fix: look up the actual primary key column from pg_catalog; fall back to the
-- alphabetical heuristic only when no PK exists; use gen_random_uuid() as last
-- resort to avoid null row_id entirely.

CREATE OR REPLACE FUNCTION audit_row_changes()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  _actor_kind text := coalesce(current_setting('app.actor_kind', true), 'program');
  _actor_id   text := coalesce(current_setting('app.actor_id',   true), 'unknown');
  _reason     text := current_setting('app.reason', true);
  _workspace  uuid;
  _row_id     uuid;
  _pk_col     text;
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

  -- Extract workspace_id
  _workspace := COALESCE(
    (_new_rec->>'workspace_id')::uuid,
    (_old_rec->>'workspace_id')::uuid
  );

  -- Find the actual primary key column via pg_catalog
  SELECT a.attname INTO _pk_col
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
  WHERE i.indrelid = TG_RELID AND i.indisprimary
  LIMIT 1;

  IF _pk_col IS NOT NULL THEN
    _row_id := (COALESCE(_new_rec, _old_rec)->>_pk_col)::uuid;
  END IF;

  -- Fallback: alphabetical-first _id column (original heuristic)
  IF _row_id IS NULL THEN
    SELECT (COALESCE(_new_rec, _old_rec)->>col_name)::uuid
    INTO _row_id
    FROM (
      SELECT key AS col_name
      FROM jsonb_object_keys(COALESCE(_new_rec, _old_rec)) AS t(key)
      WHERE key LIKE '%_id'
      ORDER BY key
      LIMIT 1
    ) id_col;
  END IF;

  -- Ultimate fallback: generate a synthetic row_id rather than inserting null
  IF _row_id IS NULL THEN
    _row_id := gen_random_uuid();
  END IF;

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
