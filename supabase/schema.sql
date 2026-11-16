-- Timber Stack (3D Multiplayer Jenga) — Supabase Postgres + Realtime Schema
-- Run this entire script in your Supabase Dashboard -> SQL Editor -> New Query.

CREATE TABLE IF NOT EXISTS public.jenga_rooms (
  room_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'WAITING',
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jenga_rooms_updated_at
  ON public.jenga_rooms (updated_at DESC);

ALTER TABLE public.jenga_rooms ENABLE ROW LEVEL SECURITY;

-- Guest-friendly policies (no user login required)
DROP POLICY IF EXISTS "Allow guest read jenga_rooms" ON public.jenga_rooms;
CREATE POLICY "Allow guest read jenga_rooms"
  ON public.jenga_rooms
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "Allow guest insert jenga_rooms" ON public.jenga_rooms;
CREATE POLICY "Allow guest insert jenga_rooms"
  ON public.jenga_rooms
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Allow guest update jenga_rooms" ON public.jenga_rooms;
CREATE POLICY "Allow guest update jenga_rooms"
  ON public.jenga_rooms
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Allow guest delete jenga_rooms" ON public.jenga_rooms;
CREATE POLICY "Allow guest delete jenga_rooms"
  ON public.jenga_rooms
  FOR DELETE
  TO anon, authenticated
  USING (true);

-- Enable Realtime Postgres Changes for jenga_rooms safely (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'jenga_rooms'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.jenga_rooms;
  END IF;
END $$;

-- Helper function to prune stale rooms older than 24 hours
CREATE OR REPLACE FUNCTION public.cleanup_stale_jenga_rooms()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.jenga_rooms
  WHERE updated_at < now() - INTERVAL '24 hours';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
