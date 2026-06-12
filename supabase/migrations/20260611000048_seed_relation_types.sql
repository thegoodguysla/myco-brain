-- Seed the relation_types catalog with the canonical predicates the
-- extraction prompt teaches (extraction.ts). Upstream Hyperscope ships 25+
-- typed relations; the OSS catalog shipped empty, which made every extracted
-- predicate look "novel" to the dynamic-schema proposer and left the
-- known-predicate filter vacuous.
--
-- Idempotent and convention-tolerant: the existence check normalizes
-- underscores/hyphens and case, so a cloud-seeded 'ASSIGNED_TO' style row
-- already counts as 'assigned to' and is not duplicated. IDs are allocated
-- past the current max to coexist with any prior seeds.

DO $$
DECLARE
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY[
    'acquired',
    'founded',
    'works for',
    'reports to',
    'manages',
    'owns',
    'hired',
    'located in'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM relation_types
       WHERE lower(regexp_replace(name, '[_-]+', ' ', 'g')) = p
    ) THEN
      INSERT INTO relation_types (relation_type_id, name)
      VALUES ((SELECT coalesce(max(relation_type_id), 0) + 1 FROM relation_types), p);
    END IF;
  END LOOP;
END $$;
