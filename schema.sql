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

CREATE TABLE IF NOT EXISTS public.market_history (
  provider text NOT NULL,
  product text NOT NULL,
  cadence text NOT NULL,
  observed_at timestamptz NOT NULL,
  open double precision NOT NULL,
  high double precision NOT NULL,
  low double precision NOT NULL,
  close double precision NOT NULL,
  volume double precision NOT NULL DEFAULT 0,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, product, cadence, observed_at)
);

CREATE INDEX IF NOT EXISTS market_history_lookup_idx
  ON public.market_history (provider, product, cadence, observed_at DESC);
