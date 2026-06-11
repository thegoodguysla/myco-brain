-- Migration 043: THE-604 — Automated First 7 Days onboarding email sequence

CREATE TABLE IF NOT EXISTS onboarding_email_events (
  event_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_email    text NOT NULL,
  source_kind        text NOT NULL CHECK (source_kind IN ('user')),
  source_id          uuid NOT NULL,
  day_number         integer NOT NULL CHECK (day_number BETWEEN 1 AND 7),
  template_key       text NOT NULL,
  send_status        text NOT NULL DEFAULT 'sent' CHECK (send_status IN ('sent', 'failed')),
  resend_message_id  text,
  error_message      text,
  sent_at            timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS onboarding_email_events_once_per_day_idx
  ON onboarding_email_events (LOWER(recipient_email), day_number);

CREATE INDEX IF NOT EXISTS onboarding_email_events_source_idx
  ON onboarding_email_events (source_kind, source_id);

CREATE INDEX IF NOT EXISTS onboarding_email_events_sent_at_idx
  ON onboarding_email_events (sent_at DESC);
