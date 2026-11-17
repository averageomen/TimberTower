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

-- ============================================================================
-- Server-Side Clock & Authoritative Timer Trigger (Windows + macOS Sync)
-- ============================================================================

-- 1. RPC to fetch exact Supabase Postgres server epoch time in milliseconds
CREATE OR REPLACE FUNCTION public.get_server_time_ms()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
$$;

GRANT EXECUTE ON FUNCTION public.get_server_time_ms() TO anon, authenticated;

-- 2. Trigger function that stamps authoritative server timestamps for all room timers
CREATE OR REPLACE FUNCTION public.sync_jenga_room_timers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  server_ms BIGINT := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
  new_status TEXT := COALESCE(NEW.state->>'status', NEW.status, 'WAITING');
  old_status TEXT := CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.state->>'status', OLD.status, '') ELSE '' END;
BEGIN
  NEW.updated_at := clock_timestamp();
  NEW.status := new_status;

  -- Always stamp the authoritative Postgres server time, canonical durations, and power-up toggle default
  NEW.state := jsonb_set(NEW.state, '{serverTimestampMs}', to_jsonb(server_ms), true);
  NEW.state := jsonb_set(NEW.state, '{turnDurationMs}', to_jsonb(45000), true);
  NEW.state := jsonb_set(NEW.state, '{settlingDurationMs}', to_jsonb(3000), true);
  IF (NEW.state->'powerUpsEnabled') IS NULL OR jsonb_typeof(NEW.state->'powerUpsEnabled') <> 'boolean' THEN
    NEW.state := jsonb_set(NEW.state, '{powerUpsEnabled}', 'true'::jsonb, true);
  END IF;

  -- Authoritative 3.0s SETTLING timer start
  IF new_status = 'SETTLING' THEN
    IF TG_OP = 'INSERT' OR old_status IS DISTINCT FROM 'SETTLING' THEN
      NEW.state := jsonb_set(NEW.state, '{settlingStartedAt}', to_jsonb(server_ms), true);
    END IF;
  ELSE
    NEW.state := jsonb_set(NEW.state, '{settlingStartedAt}', 'null'::jsonb, true);
  END IF;

  -- Authoritative 45s PLAYING turn timer start
  IF new_status = 'PLAYING' THEN
    IF TG_OP = 'INSERT'
       OR old_status IS DISTINCT FROM 'PLAYING'
       OR (NEW.state->>'currentTurnIndex') IS DISTINCT FROM (OLD.state->>'currentTurnIndex')
       OR (NEW.state->>'blocksMovedCount') IS DISTINCT FROM (OLD.state->>'blocksMovedCount')
       OR (NEW.state->>'towerRestoreVersion') IS DISTINCT FROM (OLD.state->>'towerRestoreVersion')
    THEN
      NEW.state := jsonb_set(NEW.state, '{turnStartedAt}', to_jsonb(server_ms), true);
    END IF;
  END IF;

  -- Authoritative elimination timestamp for synchronized banner & audio (never re-stamp on grabs/placements)
  IF (NEW.state->>'lastEliminatedPlayerId') IS NOT NULL
     AND (NEW.state->>'lastEliminatedPlayerId') <> 'null'
     AND (
       TG_OP = 'INSERT'
       OR (CASE WHEN TG_OP = 'UPDATE' THEN NEW.state->>'towerRestoreVersion' ELSE NULL END)
          IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.state->>'towerRestoreVersion' ELSE NULL END)
       OR (
         old_status IS DISTINCT FROM 'GAME_OVER'
         AND new_status = 'GAME_OVER'
       )
     )
  THEN
    NEW.state := jsonb_set(NEW.state, '{lastEliminatedAt}', to_jsonb(server_ms), true);
  END IF;

  -- Authoritative 10s Burning Hand countdown timer start (disabled when powerUpsEnabled = false)
  IF COALESCE((NEW.state->>'powerUpsEnabled')::boolean, true) = false THEN
    NEW.state := jsonb_set(NEW.state, '{burningBlock}', 'null'::jsonb, true);
  ELSIF jsonb_typeof(NEW.state->'burningBlock') = 'object' THEN
    IF TG_OP = 'INSERT'
       OR (CASE WHEN TG_OP = 'UPDATE' THEN jsonb_typeof(OLD.state->'burningBlock') ELSE NULL END) IS DISTINCT FROM 'object'
       OR (NEW.state->'burningBlock'->>'blockId') IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.state->'burningBlock'->>'blockId' ELSE NULL END)
    THEN
      NEW.state := jsonb_set(NEW.state, '{burningBlock,startedAt}', to_jsonb(server_ms), true);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_jenga_room_timers ON public.jenga_rooms;
CREATE TRIGGER trg_sync_jenga_room_timers
  BEFORE INSERT OR UPDATE ON public.jenga_rooms
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_jenga_room_timers();
