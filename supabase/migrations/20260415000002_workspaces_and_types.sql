-- Migration 002: Workspaces and Type System

-- ============================================================
-- WORKSPACES (multi-tenancy root)
-- ============================================================
CREATE TABLE workspaces (
  workspace_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  slug             text UNIQUE NOT NULL,
  plan             text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  settings         jsonb NOT NULL DEFAULT '{}'
);

-- ============================================================
-- TYPE SYSTEM (Hyperscope-style)
-- ============================================================
CREATE TABLE hyobject_types (
  type_id          int PRIMARY KEY,
  name             text UNIQUE NOT NULL,
  description      text
);

CREATE TABLE hyobject_subtypes (
  subtype_id       int PRIMARY KEY,
  name             text UNIQUE NOT NULL,
  description      text
);

CREATE TABLE relation_types (
  relation_type_id int PRIMARY KEY,
  name             text UNIQUE NOT NULL,
  is_symmetric     boolean NOT NULL DEFAULT false,
  inverse_of       int REFERENCES relation_types(relation_type_id)
);

CREATE TABLE sharing_types (
  sharing_type_id  int PRIMARY KEY,
  name             text UNIQUE NOT NULL CHECK (name IN ('private','workspace','org','public','llm_readable'))
);
