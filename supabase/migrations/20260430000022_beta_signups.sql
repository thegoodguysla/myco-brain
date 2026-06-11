-- Migration 022: Beta Signup Waiting List
-- Collects email+name from the Myco landing page #beta section

CREATE TABLE beta_signups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text,
  source        text NOT NULL DEFAULT 'myco-landing',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX beta_signups_email_idx ON beta_signups (LOWER(email));
