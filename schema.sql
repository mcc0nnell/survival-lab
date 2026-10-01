CREATE TABLE IF NOT EXISTS public.survival_events (
  run_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  tick integer NOT NULL CHECK (tick >= 0),
  kind text NOT NULL CHECK (
    kind IN ('run_start','run_end','decision','trade','hold','control','system')
  ),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  PRIMARY KEY (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS survival_events_received
  ON public.survival_events (received_at DESC);
