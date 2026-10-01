CREATE TABLE IF NOT EXISTS survival_events (
  run_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  ts timestamptz NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS survival_events_type_ts_idx
  ON survival_events (event_type, ts DESC);
