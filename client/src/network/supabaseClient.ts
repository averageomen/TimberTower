import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { customAlphabet, nanoid } from 'nanoid';
import { GlobalSoundEvent } from '../audio/soundEngine';
import {
  advanceBurningBlocksOnTurn,
  BURN_DURATION_MS,
  BURN_MAX_TURNS,
  ChatMessage,
  clearAllPowerUpsOnBlocks,
  cloneBlocks,
  CompactBlockTuple,
  createInitialBlocks,
  GameRulesMode,
  getValidTopPlacements,
  isBlockSelectable,
  maybeSpawnMysteryBlock,
  Player,
  PowerUpType,
  Quat,
  RoomState,
  sanitizeStableBlocks,
  SETTLING_DURATION_MS,
  TURN_DURATION_MS,
  Vec3,
} from '../types';

const STORAGE_URL_KEY = 'jenga_supabase_url';
const STORAGE_ANON_KEY = 'jenga_supabase_anon_key';
const SESSION_CLIENT_ID_KEY = 'jenga_client_id';
const MAX_PLAYERS_PER_ROOM = 6;
const DISCONNECT_GRACE_MS = 12_000;

const generateRoomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  isConfigured: boolean;
}

export interface SupabaseRoomCallbacks {
  onConnectionChange: (connected: boolean) => void;
  onClientIdChange: (clientId: string) => void;
  onRoomState: (state: RoomState) => void;
  onPhysicsState: (blocks: CompactBlockTuple[]) => void;
  onBlockHovered: (payload: { blockId: number | null; playerId: string }) => void;
  onBlockGrabbed: (payload: { blockId: number; playerId: string; committed: boolean }) => void;
  onSoundEvent: (event: GlobalSoundEvent) => void;
  onChatMessage: (message: ChatMessage) => void;
  onError: (message: string) => void;
}

function getOrCreateClientId(): string {
  if (typeof window !== 'undefined') {
    try {
      const existing = window.sessionStorage.getItem(SESSION_CLIENT_ID_KEY);
      if (existing && existing.trim().length > 0) {
        return existing;
      }
      const fresh = `player-${nanoid(10)}`;
      window.sessionStorage.setItem(SESSION_CLIENT_ID_KEY, fresh);
      return fresh;
    } catch {
      // Fallback if sessionStorage is unavailable
    }
  }
  return `player-${nanoid(10)}`;
}

export function normalizeSupabaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function loadSupabaseConfig(): SupabaseConfig {
  let storedUrl = '';
  let storedKey = '';

  if (typeof window !== 'undefined') {
    try {
      storedUrl = window.localStorage.getItem(STORAGE_URL_KEY) ?? '';
      storedKey = window.localStorage.getItem(STORAGE_ANON_KEY) ?? '';
    } catch {
      // Ignore storage access restrictions
    }
  }

  const envUrl =
    typeof import.meta.env.VITE_SUPABASE_URL === 'string'
      ? import.meta.env.VITE_SUPABASE_URL
      : '';
  const envKey =
    typeof import.meta.env.VITE_SUPABASE_ANON_KEY === 'string'
      ? import.meta.env.VITE_SUPABASE_ANON_KEY
      : '';

  const url = normalizeSupabaseUrl(storedUrl || envUrl);
  const anonKey = (storedKey || envKey).trim();
  const isConfigured = /^https?:\/\/.+/.test(url) && anonKey.length > 16;

  return { url, anonKey, isConfigured };
}

export function saveSupabaseConfig(rawUrl: string, rawAnonKey: string): SupabaseConfig {
  const url = normalizeSupabaseUrl(rawUrl);
  const anonKey = rawAnonKey.trim();

  if (typeof window !== 'undefined') {
    try {
      if (url) {
        window.localStorage.setItem(STORAGE_URL_KEY, url);
      } else {
        window.localStorage.removeItem(STORAGE_URL_KEY);
      }
      if (anonKey) {
        window.localStorage.setItem(STORAGE_ANON_KEY, anonKey);
      } else {
        window.localStorage.removeItem(STORAGE_ANON_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }

  return {
    url,
    anonKey,
    isConfigured: /^https?:\/\/.+/.test(url) && anonKey.length > 16,
  };
}

function sanitizePlayerName(rawName: string): string {
  const trimmed = rawName.trim().slice(0, 20);
  return trimmed.length > 0 ? trimmed : 'Player';
}

interface RoomRow {
  room_id: string;
  status: string;
  state: RoomState;
  updated_at: string;
}

class SupabaseRoomController {
  private client: SupabaseClient | null = null;
  private config: SupabaseConfig = loadSupabaseConfig();
  private clientId: string = getOrCreateClientId();
  private channel: RealtimeChannel | null = null;
  private roomState: RoomState | null = null;
  private callbacks: SupabaseRoomCallbacks | null = null;

  private turnTimeoutId: number | null = null;
  private settlingTimeoutId: number | null = null;
  private burnTimeoutId: number | null = null;
  private disconnectTimers = new Map<string, number>();
  private lastRestoreOrCollapseAt = 0;
  private serverTimeOffsetMs = 0;
  private hasSyncedServerClock = false;

  public getClientId(): string {
    return this.clientId;
  }

  public getConfig(): SupabaseConfig {
    return this.config;
  }

  public getServerNow(): number {
    return Math.round(Date.now() + this.serverTimeOffsetMs);
  }

  private calibrateServerClock(
    serverMs?: number | null,
    updatedAtIso?: string | null,
    referenceLocalMs = Date.now()
  ): void {
    let resolvedServerMs: number | null = null;
    if (typeof serverMs === 'number' && Number.isFinite(serverMs) && serverMs > 0) {
      resolvedServerMs = serverMs;
    } else if (typeof updatedAtIso === 'string' && updatedAtIso.length > 0) {
      const parsed = Date.parse(updatedAtIso);
      if (Number.isFinite(parsed) && parsed > 0) {
        resolvedServerMs = parsed;
      }
    }

    if (resolvedServerMs === null) return;
    const candidateOffset = resolvedServerMs - referenceLocalMs;
    if (!this.hasSyncedServerClock) {
      this.serverTimeOffsetMs = candidateOffset;
      this.hasSyncedServerClock = true;
    } else {
      // Smoothly blend clock offset to filter out transient network jitter
      this.serverTimeOffsetMs = this.serverTimeOffsetMs * 0.7 + candidateOffset * 0.3;
    }
  }

  public async syncServerClock(): Promise<void> {
    if (!this.client) return;
    try {
      const t0 = Date.now();
      const { data, error } = await this.client.rpc('get_server_time_ms');
      const t1 = Date.now();
      if (!error && (typeof data === 'number' || typeof data === 'string')) {
        const serverMs = Number(data);
        if (Number.isFinite(serverMs) && serverMs > 0) {
          const midpointLocalMs = t0 + (t1 - t0) / 2;
          this.serverTimeOffsetMs = serverMs - midpointLocalMs;
          this.hasSyncedServerClock = true;
        }
      }
    } catch {
      // Ignore if RPC has not been installed yet; row updated_at/serverTimestampMs will still calibrate
    }
  }

  public initialize(callbacks: SupabaseRoomCallbacks): void {
    this.callbacks = callbacks;
    callbacks.onClientIdChange(this.clientId);
    this.rebuildClient();
  }

  public updateConfig(rawUrl: string, rawAnonKey: string): SupabaseConfig {
    this.config = saveSupabaseConfig(rawUrl, rawAnonKey);
    void this.leaveRoom();
    this.rebuildClient();
    return this.config;
  }

  private rebuildClient(): void {
    if (this.client) {
      void this.client.removeAllChannels();
      this.client = null;
    }

    if (!this.config.isConfigured) {
      this.callbacks?.onConnectionChange(false);
      return;
    }

    this.client = createClient(this.config.url, this.config.anonKey, {
      realtime: {
        params: {
          eventsPerSecond: 30,
        },
      },
    });

    void this.verifyConnection();
  }

  private async verifyConnection(): Promise<void> {
    if (!this.client) {
      this.callbacks?.onConnectionChange(false);
      return;
    }
    const { error } = await this.client.from('jenga_rooms').select('room_id').limit(1);
    if (error) {
      this.callbacks?.onConnectionChange(false);
      this.callbacks?.onError(`Supabase connection check failed: ${error.message}`);
      return;
    }
    void this.syncServerClock();
    this.callbacks?.onConnectionChange(true);
  }

  private clearTimers(): void {
    if (this.turnTimeoutId !== null) {
      window.clearTimeout(this.turnTimeoutId);
      this.turnTimeoutId = null;
    }
    if (this.settlingTimeoutId !== null) {
      window.clearTimeout(this.settlingTimeoutId);
      this.settlingTimeoutId = null;
    }
    if (this.burnTimeoutId !== null) {
      window.clearTimeout(this.burnTimeoutId);
      this.burnTimeoutId = null;
    }
    for (const timer of this.disconnectTimers.values()) {
      window.clearTimeout(timer);
    }
    this.disconnectTimers.clear();
  }

  private isCoordinator(): boolean {
    if (!this.roomState) return false;
    const myPlayer = this.roomState.players.find((p) => p.id === this.clientId);
    if (myPlayer?.isHost && myPlayer.connected) return true;
    const firstConnected = this.roomState.players.find((p) => p.connected);
    return firstConnected?.id === this.clientId;
  }

  private syncCoordinatorTimers(state: RoomState): void {
    if (this.turnTimeoutId !== null) {
      window.clearTimeout(this.turnTimeoutId);
      this.turnTimeoutId = null;
    }
    if (this.settlingTimeoutId !== null) {
      window.clearTimeout(this.settlingTimeoutId);
      this.settlingTimeoutId = null;
    }
    if (this.burnTimeoutId !== null) {
      window.clearTimeout(this.burnTimeoutId);
      this.burnTimeoutId = null;
    }

    const isCoord = this.isCoordinator();
    const activePlayer = state.players[state.currentTurnIndex];
    const isActiveTurnPlayer = activePlayer?.id === this.clientId;

    // Coordinator runs primary timer; active player runs a +650ms backup timer in case coordinator tab is throttled
    if (!isCoord && !isActiveTurnPlayer) return;
    const backupDelayMs = isCoord ? 0 : 650;
    const serverNow = this.getServerNow();

    if (state.status === 'PLAYING') {
      const elapsed = Math.max(0, serverNow - state.turnStartedAt);
      const remaining = Math.min(
        state.turnDurationMs,
        Math.max(0, state.turnDurationMs - elapsed)
      );
      this.turnTimeoutId = window.setTimeout(() => {
        void this.handleTurnTimeout(!isCoord);
      }, remaining + backupDelayMs);

      if (state.burningBlock) {
        const burnElapsed = Math.max(0, serverNow - state.burningBlock.startedAt);
        const burnRemaining = Math.min(
          state.burningBlock.durationMs,
          Math.max(0, state.burningBlock.durationMs - burnElapsed)
        );
        this.burnTimeoutId = window.setTimeout(() => {
          void this.handleBurnTimeout(!isCoord);
        }, burnRemaining + backupDelayMs);
      }
    } else if (state.status === 'SETTLING' && state.settlingStartedAt) {
      const elapsed = Math.max(0, serverNow - state.settlingStartedAt);
      const remaining = Math.min(
        state.settlingDurationMs,
        Math.max(0, state.settlingDurationMs - elapsed)
      );
      this.settlingTimeoutId = window.setTimeout(() => {
        void this.completeSettlingPhase(!isCoord);
      }, remaining + backupDelayMs);
    }
  }

  private async handleBurnTimeout(allowBackup = false): Promise<void> {
    if (
      !this.roomState ||
      this.roomState.status !== 'PLAYING' ||
      !this.roomState.burningBlock ||
      (!this.isCoordinator() && !allowBackup)
    ) {
      return;
    }

    const burnBlockId = this.roomState.burningBlock.blockId;
    const active = this.roomState.players[this.roomState.currentTurnIndex];
    const loserId = active?.id ?? this.roomState.burningBlock.playerId ?? null;

    const updatedBlocks = this.roomState.blocks.map((b) =>
      b.id === burnBlockId
        ? {
            ...b,
            isRemoved: true,
            effect: null,
            burnTurnsRemaining: null,
            hasMysteryPowerUp: false,
          }
        : b
    );
    const updatedStableBlocks = this.roomState.lastStableBlocks.map((b) =>
      b.id === burnBlockId
        ? { ...b, effect: null, burnTurnsRemaining: null, hasMysteryPowerUp: false }
        : b
    );

    this.roomState = {
      ...this.roomState,
      blocks: updatedBlocks,
      lastStableBlocks: updatedStableBlocks,
      burningBlock: null,
    };

    if (this.roomState.rulesMode === 'ELIMINATION' && loserId) {
      await this.eliminatePlayerAndRestore(
        loserId,
        `${active?.name ?? 'Active player'}'s block burned away after 10s and they were ELIMINATED!`
      );
      return;
    }

    const ended = this.buildEndedState(this.roomState, loserId, 'TOWER_COLLAPSED');
    await this.commitAndBroadcastState(ended);
    await this.broadcastSystemChat(
      `🔥 ${active?.name ?? 'Active player'}'s block burned to ash! Game Over!`,
      '🔥'
    );
  }

  private async handleTurnTimeout(allowBackup = false): Promise<void> {
    if (
      !this.roomState ||
      this.roomState.status !== 'PLAYING' ||
      (!this.isCoordinator() && !allowBackup)
    ) {
      return;
    }
    const timedOutPlayer = this.roomState.players[this.roomState.currentTurnIndex];
    const loserId = timedOutPlayer?.id ?? null;

    if (this.roomState.rulesMode === 'ELIMINATION' && loserId) {
      await this.eliminatePlayerAndRestore(
        loserId,
        `${timedOutPlayer?.name ?? 'Active player'} ran out of time and was ELIMINATED!`
      );
      return;
    }

    const nextState = this.buildEndedState(this.roomState, loserId, 'TIMEOUT');
    await this.commitAndBroadcastState(nextState);
    await this.broadcastSystemChat(
      `${timedOutPlayer?.name ?? 'Active player'} ran out of time!`,
      '⏰'
    );
  }

  private async completeSettlingPhase(allowBackup = false): Promise<void> {
    if (
      !this.roomState ||
      this.roomState.status !== 'SETTLING' ||
      (!this.isCoordinator() && !allowBackup)
    ) {
      return;
    }
    const nextTurnIndex = this.findNextConnectedPlayerIndex(
      this.roomState,
      this.roomState.currentTurnIndex
    );
    const sanitized = sanitizeStableBlocks(
      this.roomState.blocks,
      this.roomState.lastStableBlocks
    );
    const powerUpsOn = this.roomState.powerUpsEnabled !== false;
    const burnStep = powerUpsOn
      ? advanceBurningBlocksOnTurn(sanitized)
      : { blocks: sanitized, spreadCount: 0, extinguishedCount: 0 };
    const stableBlocks = powerUpsOn
      ? maybeSpawnMysteryBlock(burnStep.blocks)
      : burnStep.blocks;
    const nextState: RoomState = {
      ...this.roomState,
      status: 'PLAYING',
      settlingStartedAt: null,
      turnStartedAt: this.getServerNow(),
      currentTurnIndex: nextTurnIndex,
      burningBlock: null,
      lastEliminatedPlayerId: null,
      lastEliminatedAt: null,
      blocks: cloneBlocks(stableBlocks),
      lastStableBlocks: cloneBlocks(stableBlocks),
    };
    await this.commitAndBroadcastState(nextState);
    if (burnStep.spreadCount > 0) {
      await this.broadcastSystemChat(
        `🔥 Fire spread to ${burnStep.spreadCount} nearby block${burnStep.spreadCount > 1 ? 's' : ''}!`,
        '🔥'
      );
    } else if (burnStep.extinguishedCount > 0) {
      await this.broadcastSystemChat(
        `💨 ${burnStep.extinguishedCount} burning block${burnStep.extinguishedCount > 1 ? 's' : ''} burned out!`,
        '💨'
      );
    }
  }

  private findNextConnectedPlayerIndex(
    state: RoomState,
    fromIndex: number,
    playersOverride?: Player[]
  ): number {
    const list = playersOverride ?? state.players;
    const count = list.length;
    if (count === 0) return 0;
    for (let offset = 1; offset <= count; offset++) {
      const idx = (fromIndex + offset) % count;
      if (list[idx]?.connected && !list[idx]?.eliminated) return idx;
    }
    for (let offset = 1; offset <= count; offset++) {
      const idx = (fromIndex + offset) % count;
      if (!list[idx]?.eliminated) return idx;
    }
    return (fromIndex + 1) % count;
  }

  private async eliminatePlayerAndRestore(
    loserId: string,
    reasonMessage: string
  ): Promise<void> {
    if (!this.roomState) return;
    this.lastRestoreOrCollapseAt = Date.now();
    const updatedPlayers = this.roomState.players.map((p) =>
      p.id === loserId ? { ...p, eliminated: true } : p
    );
    const alivePlayers = updatedPlayers.filter((p) => !p.eliminated && p.connected);
    const now = this.getServerNow();

    if (alivePlayers.length <= 1) {
      const winner = alivePlayers[0] ?? updatedPlayers.find((p) => !p.eliminated) ?? null;
      const ended: RoomState = {
        ...this.roomState,
        status: 'GAME_OVER',
        players: updatedPlayers.map((p) => ({ ...p, powerUp: null })),
        settlingStartedAt: null,
        activeBlockId: null,
        burningBlock: null,
        blocks: clearAllPowerUpsOnBlocks(this.roomState.blocks),
        lastStableBlocks: clearAllPowerUpsOnBlocks(this.roomState.lastStableBlocks),
        lastEliminatedPlayerId: loserId,
        lastEliminatedAt: now,
        loserId,
        winnerId: winner?.id ?? null,
        gameOverReason: 'TOWER_COLLAPSED',
      };
      await this.commitAndBroadcastState(ended);
      await this.broadcastSystemChat(
        `${reasonMessage} ${winner ? `${winner.name} is the last survivor!` : ''}`,
        '💥'
      );
      return;
    }

    const powerUpsOn = this.roomState.powerUpsEnabled !== false;
    const sanitizedRestore = sanitizeStableBlocks(
      this.roomState.lastStableBlocks.length > 0
        ? this.roomState.lastStableBlocks
        : createInitialBlocks(powerUpsOn),
      createInitialBlocks(powerUpsOn)
    );
    const burnStep = powerUpsOn
      ? advanceBurningBlocksOnTurn(sanitizedRestore)
      : { blocks: sanitizedRestore, spreadCount: 0, extinguishedCount: 0 };
    const restoredBlocks = powerUpsOn
      ? maybeSpawnMysteryBlock(burnStep.blocks)
      : burnStep.blocks;
    const nextTurnIndex = this.findNextConnectedPlayerIndex(
      this.roomState,
      this.roomState.currentTurnIndex,
      updatedPlayers
    );

    const restoredState: RoomState = {
      ...this.roomState,
      status: 'PLAYING',
      players: updatedPlayers,
      currentTurnIndex: nextTurnIndex,
      turnStartedAt: now,
      settlingStartedAt: null,
      activeBlockId: null,
      burningBlock: null,
      blocks: restoredBlocks,
      lastStableBlocks: cloneBlocks(restoredBlocks),
      towerRestoreVersion: (this.roomState.towerRestoreVersion ?? 1) + 1,
      lastEliminatedPlayerId: loserId,
      lastEliminatedAt: now,
    };

    await this.commitAndBroadcastState(restoredState);
    await this.broadcastSystemChat(
      `${reasonMessage} Tower restored (${alivePlayers.length} players left)!`,
      '💥'
    );
  }

  private buildEndedState(
    state: RoomState,
    loserId: string | null,
    reason: RoomState['gameOverReason']
  ): RoomState {
    const candidates = state.players.filter((p) => p.id !== loserId && p.connected);
    const fallback = state.players.filter((p) => p.id !== loserId);
    const pool = candidates.length > 0 ? candidates : fallback;
    const winner =
      pool.length > 0 ? [...pool].sort((a, b) => b.score - a.score)[0] : null;

    return {
      ...state,
      status: 'GAME_OVER',
      players: state.players.map((p) => ({ ...p, powerUp: null })),
      blocks: clearAllPowerUpsOnBlocks(state.blocks),
      lastStableBlocks: clearAllPowerUpsOnBlocks(state.lastStableBlocks),
      settlingStartedAt: null,
      activeBlockId: null,
      burningBlock: null,
      loserId,
      winnerId: winner?.id ?? null,
      gameOverReason: reason,
    };
  }

  private applyLocalRoomState(nextState: RoomState): void {
    const prev = this.roomState;
    const normalized: RoomState = { ...nextState };
    const serverNow = this.getServerNow();

    // Ensure freshly transitioned timers never have future start timestamps due to residual clock skew
    const isFreshSettling =
      normalized.status === 'SETTLING' &&
      (!prev || prev.status !== 'SETTLING' || prev.blocksMovedCount !== normalized.blocksMovedCount);
    if (normalized.status === 'SETTLING' && normalized.settlingStartedAt) {
      if (isFreshSettling && Math.abs(serverNow - normalized.settlingStartedAt) > 600) {
        normalized.settlingStartedAt = serverNow;
      } else if (normalized.settlingStartedAt > serverNow) {
        normalized.settlingStartedAt = serverNow;
      }
    }

    const isFreshTurn =
      normalized.status === 'PLAYING' &&
      (!prev ||
        prev.status !== 'PLAYING' ||
        prev.currentTurnIndex !== normalized.currentTurnIndex ||
        prev.blocksMovedCount !== normalized.blocksMovedCount ||
        prev.towerRestoreVersion !== normalized.towerRestoreVersion);
    if (normalized.status === 'PLAYING') {
      if (isFreshTurn && Math.abs(serverNow - normalized.turnStartedAt) > 900) {
        normalized.turnStartedAt = serverNow;
      } else if (normalized.turnStartedAt > serverNow) {
        normalized.turnStartedAt = serverNow;
      }
    }

    if (normalized.burningBlock) {
      const isFreshBurn =
        !prev?.burningBlock ||
        prev.burningBlock.blockId !== normalized.burningBlock.blockId;
      if (isFreshBurn && Math.abs(serverNow - normalized.burningBlock.startedAt) > 600) {
        normalized.burningBlock = {
          ...normalized.burningBlock,
          startedAt: serverNow,
        };
      } else if (normalized.burningBlock.startedAt > serverNow) {
        normalized.burningBlock = {
          ...normalized.burningBlock,
          startedAt: serverNow,
        };
      }
    }

    if (
      prev &&
      ((normalized.towerRestoreVersion ?? 1) > (prev.towerRestoreVersion ?? 1) ||
        (normalized.lastEliminatedAt &&
          normalized.lastEliminatedAt !== prev.lastEliminatedAt) ||
        (normalized.status === 'GAME_OVER' && prev.status !== 'GAME_OVER'))
    ) {
      this.lastRestoreOrCollapseAt = Date.now();
    }
    this.roomState = normalized;
    this.callbacks?.onRoomState(normalized);
    this.syncCoordinatorTimers(normalized);
  }

  private async persistState(state: RoomState): Promise<RoomState> {
    if (!this.client) return state;
    const t0 = Date.now();
    const { data, error } = await this.client
      .from('jenga_rooms')
      .upsert(
        {
          room_id: state.roomId,
          status: state.status,
          state,
          updated_at: new Date(this.getServerNow()).toISOString(),
        },
        { onConflict: 'room_id' }
      )
      .select('state, updated_at')
      .single();
    const t1 = Date.now();

    if (error) {
      this.callbacks?.onError(`Failed to sync room state: ${error.message}`);
      return state;
    }

    const row = data as { state?: RoomState; updated_at?: string } | null;
    if (row?.state) {
      const midpoint = t0 + (t1 - t0) / 2;
      if (
        typeof row.state.serverTimestampMs === 'number' &&
        row.state.serverTimestampMs !== state.serverTimestampMs
      ) {
        this.calibrateServerClock(row.state.serverTimestampMs, null, midpoint);
      }
      return row.state;
    }
    return state;
  }

  private async commitAndBroadcastState(state: RoomState): Promise<void> {
    // Persist to Supabase Postgres first so the DB trigger stamps authoritative server timestamps
    const authoritativeState = await this.persistState(state);
    this.applyLocalRoomState(authoritativeState);
    if (this.channel) {
      await this.channel.send({
        type: 'broadcast',
        event: 'room:state',
        payload: authoritativeState,
      });
    }
  }

  private async broadcastSystemChat(message: string, emoji?: string): Promise<void> {
    const chat: ChatMessage = {
      id: `sys-${Date.now()}-${nanoid(5)}`,
      senderId: 'system',
      senderName: 'Jenga Referee',
      message,
      emoji,
      system: true,
      timestamp: this.getServerNow(),
    };
    this.callbacks?.onChatMessage(chat);
    if (this.channel) {
      await this.channel.send({
        type: 'broadcast',
        event: 'chat:system',
        payload: chat,
      });
    }
  }

  private async subscribeToRoomChannel(roomId: string): Promise<void> {
    if (!this.client) return;

    if (this.channel) {
      await this.client.removeChannel(this.channel);
      this.channel = null;
    }

    const channel = this.client.channel(`jenga:room:${roomId}`, {
      config: {
        broadcast: { self: false },
        presence: { key: this.clientId },
      },
    });

    channel
      .on('broadcast', { event: 'room:state' }, ({ payload }) => {
        if (payload) {
          this.applyLocalRoomState(payload as RoomState);
        }
      })
      .on('broadcast', { event: 'physics:state' }, ({ payload }) => {
        if (Date.now() - this.lastRestoreOrCollapseAt < 900) return;
        if (
          !this.roomState ||
          (this.roomState.status !== 'PLAYING' && this.roomState.status !== 'SETTLING')
        ) {
          return;
        }
        if (Array.isArray(payload)) {
          const compact = payload as CompactBlockTuple[];
          if (this.roomState) {
            for (const tuple of compact) {
              if (!Array.isArray(tuple) || tuple.length < 8) continue;
              const [id, x, y, z, qx, qy, qz, qw] = tuple;
              const block = this.roomState.blocks[id];
              if (block && block.id === id) {
                block.position = [x, y, z];
                block.quaternion = [qx, qy, qz, qw];
              }
            }
          }
          this.callbacks?.onPhysicsState(compact);
        }
      })
      .on('broadcast', { event: 'block:hovered' }, ({ payload }) => {
        if (payload) {
          this.callbacks?.onBlockHovered(
            payload as { blockId: number | null; playerId: string }
          );
        }
      })
      .on('broadcast', { event: 'block:grabbed' }, ({ payload }) => {
        if (payload) {
          this.callbacks?.onBlockGrabbed(
            payload as { blockId: number; playerId: string; committed: boolean }
          );
        }
      })
      .on('broadcast', { event: 'chat:system' }, ({ payload }) => {
        if (payload) {
          this.callbacks?.onChatMessage(payload as ChatMessage);
        }
      })
      .on('broadcast', { event: 'chat:message' }, ({ payload }) => {
        if (payload) {
          this.callbacks?.onChatMessage(payload as ChatMessage);
        }
      })
      .on('broadcast', { event: 'sfx:event' }, ({ payload }) => {
        if (payload) {
          this.callbacks?.onSoundEvent(payload as GlobalSoundEvent);
        }
      })
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'jenga_rooms',
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          const row = payload.new as RoomRow | undefined;
          if (!row?.state) return;
          if (!this.roomState || this.shouldAdoptDbState(this.roomState, row.state)) {
            this.applyLocalRoomState(row.state);
          }
        }
      )
      .on('presence', { event: 'join' }, ({ key }) => {
        const timer = this.disconnectTimers.get(key);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          this.disconnectTimers.delete(key);
        }
      })
      .on('presence', { event: 'leave' }, ({ key }) => {
        this.handlePeerPresenceLeave(key);
      });

    await new Promise<void>((resolve, reject) => {
      channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          this.callbacks?.onConnectionChange(true);
          await channel.track({
            clientId: this.clientId,
            joinedAt: this.getServerNow(),
          });
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error(`Realtime subscription failed (${status}).`));
        }
      });
    });

    this.channel = channel;
  }

  private shouldAdoptDbState(local: RoomState, incoming: RoomState): boolean {
    if ((incoming.towerRestoreVersion ?? 1) > (local.towerRestoreVersion ?? 1)) return true;
    if (incoming.rulesMode !== local.rulesMode) return true;
    if (Boolean(incoming.powerUpsEnabled ?? true) !== Boolean(local.powerUpsEnabled ?? true)) {
      return true;
    }
    if (incoming.blocksMovedCount > local.blocksMovedCount) return true;
    if (incoming.status !== local.status) return true;
    if (incoming.currentTurnIndex !== local.currentTurnIndex) return true;
    if (incoming.turnStartedAt !== local.turnStartedAt) return true;
    if (incoming.settlingStartedAt !== local.settlingStartedAt) return true;
    if ((incoming.burningBlock?.blockId ?? null) !== (local.burningBlock?.blockId ?? null)) {
      return true;
    }
    if (incoming.players.length !== local.players.length) return true;
    if (incoming.players.some((p, i) => p.powerUp !== local.players[i]?.powerUp)) return true;
    if (incoming.activeBlockId !== local.activeBlockId) return true;
    if (
      incoming.blocks.some(
        (b, i) =>
          b.effect !== local.blocks[i]?.effect ||
          b.burnTurnsRemaining !== local.blocks[i]?.burnTurnsRemaining ||
          b.hasMysteryPowerUp !== local.blocks[i]?.hasMysteryPowerUp ||
          b.isRemoved !== local.blocks[i]?.isRemoved
      )
    ) {
      return true;
    }
    return false;
  }

  private handlePeerPresenceLeave(departedClientId: string): void {
    if (!this.roomState || departedClientId === this.clientId) return;
    const idx = this.roomState.players.findIndex((p) => p.id === departedClientId);
    if (idx === -1) return;

    const departed = this.roomState.players[idx];

    if (this.roomState.status === 'WAITING') {
      const remaining = this.roomState.players.filter((p) => p.id !== departedClientId);
      if (remaining.length > 0 && !remaining.some((p) => p.isHost)) {
        remaining[0] = { ...remaining[0], isHost: true };
      }
      const nextState: RoomState = {
        ...this.roomState,
        players: remaining,
        currentTurnIndex: 0,
      };
      if (nextState.players[0]?.id === this.clientId) {
        void this.commitAndBroadcastState(nextState);
        void this.broadcastSystemChat(`${departed.name} left the lobby.`, '👋');
      } else {
        this.applyLocalRoomState(nextState);
      }
      return;
    }

    // Active / finished match: mark disconnected and let coordinator enforce 12s grace period
    const updatedPlayers = this.roomState.players.map((p) =>
      p.id === departedClientId ? { ...p, connected: false } : p
    );
    if (departed.isHost) {
      const firstConnectedIdx = updatedPlayers.findIndex((p) => p.connected);
      if (firstConnectedIdx !== -1) {
        updatedPlayers.forEach((p, i) => {
          updatedPlayers[i] = { ...p, isHost: i === firstConnectedIdx };
        });
      }
    }

    const updatedState: RoomState = {
      ...this.roomState,
      players: updatedPlayers,
    };
    this.applyLocalRoomState(updatedState);

    if (!this.isCoordinator()) return;

    void this.persistState(updatedState);
    if (updatedState.status === 'PLAYING' || updatedState.status === 'SETTLING') {
      void this.broadcastSystemChat(
        `${departed.name} disconnected. Waiting ${DISCONNECT_GRACE_MS / 1000}s for reconnection...`,
        '⚡'
      );

      const existing = this.disconnectTimers.get(departedClientId);
      if (existing !== undefined) {
        window.clearTimeout(existing);
      }

      const timer = window.setTimeout(() => {
        this.disconnectTimers.delete(departedClientId);
        void this.finalizeDisconnectedPlayer(departedClientId, departed.name);
      }, DISCONNECT_GRACE_MS);

      this.disconnectTimers.set(departedClientId, timer);
    }
  }

  private async finalizeDisconnectedPlayer(
    departedId: string,
    departedName: string
  ): Promise<void> {
    if (!this.roomState || !this.isCoordinator()) return;
    if (this.roomState.status !== 'PLAYING' && this.roomState.status !== 'SETTLING') return;

    const target = this.roomState.players.find((p) => p.id === departedId);
    if (!target || target.connected) return;

    const remainingConnected = this.roomState.players.filter((p) => p.connected);
    if (remainingConnected.length <= 1) {
      const ended = this.buildEndedState(
        this.roomState,
        target.id,
        'PLAYER_DISCONNECTED'
      );
      await this.commitAndBroadcastState(ended);
      await this.broadcastSystemChat(
        `${departedName} failed to reconnect and forfeited the match.`,
        '🏳️'
      );
      return;
    }

    const activePlayer = this.roomState.players[this.roomState.currentTurnIndex];
    if (activePlayer?.id === target.id) {
      const nextState: RoomState = {
        ...this.roomState,
        activeBlockId: null,
        status: 'PLAYING',
        settlingStartedAt: null,
        turnStartedAt: this.getServerNow(),
        currentTurnIndex: this.findNextConnectedPlayerIndex(
          this.roomState,
          this.roomState.currentTurnIndex
        ),
      };
      await this.commitAndBroadcastState(nextState);
    }
    await this.broadcastSystemChat(
      `${departedName} timed out from disconnect. Match continues.`,
      '➡️'
    );
  }

  public async createRoom(rawPlayerName: string): Promise<void> {
    if (!this.client || !this.config.isConfigured) {
      this.callbacks?.onError('Please enter your Supabase URL and Anon Key first.');
      return;
    }

    await this.leaveRoom();
    await this.syncServerClock();

    let roomId = generateRoomCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data } = await this.client
        .from('jenga_rooms')
        .select('room_id')
        .eq('room_id', roomId)
        .maybeSingle();
      if (!data) break;
      roomId = generateRoomCode();
    }

    const initialBlocks = createInitialBlocks();
    const hostPlayer: Player = {
      id: this.clientId,
      name: sanitizePlayerName(rawPlayerName),
      score: 0,
      isHost: true,
      connected: true,
      eliminated: false,
    };

    const initialState: RoomState = {
      roomId,
      status: 'WAITING',
      rulesMode: 'CLASSIC',
      powerUpsEnabled: true,
      players: [hostPlayer],
      currentTurnIndex: 0,
      startingPlayerIndex: 0,
      turnStartedAt: this.getServerNow(),
      turnDurationMs: TURN_DURATION_MS,
      settlingStartedAt: null,
      settlingDurationMs: SETTLING_DURATION_MS,
      activeBlockId: null,
      blocksMovedCount: 0,
      blocks: initialBlocks,
      lastStableBlocks: cloneBlocks(initialBlocks),
      towerRestoreVersion: 1,
      lastEliminatedPlayerId: null,
      lastEliminatedAt: null,
      winnerId: null,
      loserId: null,
      gameOverReason: null,
    };

    try {
      const authoritativeState = await this.persistState(initialState);
      await this.subscribeToRoomChannel(roomId);
      this.applyLocalRoomState(authoritativeState);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to create Supabase room.';
      this.callbacks?.onError(msg);
    }
  }

  public async joinRoom(rawRoomId: string, rawPlayerName: string): Promise<void> {
    if (!this.client || !this.config.isConfigured) {
      this.callbacks?.onError('Please enter your Supabase URL and Anon Key first.');
      return;
    }

    const roomId = rawRoomId.trim().toUpperCase();
    if (roomId.length < 4) {
      this.callbacks?.onError('Please enter a valid 6-character room code.');
      return;
    }

    await this.syncServerClock();

    const { data, error } = await this.client
      .from('jenga_rooms')
      .select('state, updated_at')
      .eq('room_id', roomId)
      .maybeSingle();

    if (error) {
      this.callbacks?.onError(`Could not look up room: ${error.message}`);
      return;
    }

    if (!data?.state) {
      this.callbacks?.onError(`Room "${roomId}" was not found.`);
      return;
    }

    const room = data.state as RoomState;
    const playerName = sanitizePlayerName(rawPlayerName);

    let updatedPlayers = [...room.players];
    let reconnected = false;

    const existingById = updatedPlayers.findIndex((p) => p.id === this.clientId);
    const disconnectedByName = updatedPlayers.findIndex(
      (p) => !p.connected && p.name.toLowerCase() === playerName.toLowerCase()
    );

    if (existingById !== -1) {
      updatedPlayers[existingById] = {
        ...updatedPlayers[existingById],
        name: playerName,
        connected: true,
      };
      reconnected = true;
    } else if (disconnectedByName !== -1) {
      const oldId = updatedPlayers[disconnectedByName].id;
      updatedPlayers[disconnectedByName] = {
        ...updatedPlayers[disconnectedByName],
        id: this.clientId,
        connected: true,
      };
      if (room.winnerId === oldId) room.winnerId = this.clientId;
      if (room.loserId === oldId) room.loserId = this.clientId;
      reconnected = true;
    } else {
      if (room.status !== 'WAITING') {
        this.callbacks?.onError('This match is already in progress.');
        return;
      }
      if (updatedPlayers.length >= MAX_PLAYERS_PER_ROOM) {
        this.callbacks?.onError(
          `Room "${roomId}" is full (max ${MAX_PLAYERS_PER_ROOM} players).`
        );
        return;
      }

      const duplicateName = updatedPlayers.some(
        (p) => p.name.toLowerCase() === playerName.toLowerCase()
      );
      const uniqueName = duplicateName
        ? `${playerName.slice(0, 16)} #${updatedPlayers.length + 1}`
        : playerName;

      updatedPlayers.push({
        id: this.clientId,
        name: uniqueName,
        score: 0,
        isHost: updatedPlayers.length === 0,
        connected: true,
      });
    }

    const nextState: RoomState = {
      ...room,
      players: updatedPlayers,
    };

    try {
      await this.leaveRoom();
      await this.subscribeToRoomChannel(roomId);
      await this.commitAndBroadcastState(nextState);

      const joinedPlayer = updatedPlayers.find((p) => p.id === this.clientId);
      await this.broadcastSystemChat(
        reconnected
          ? `${joinedPlayer?.name ?? 'A player'} reconnected!`
          : `${joinedPlayer?.name ?? 'A player'} joined the table.`,
        reconnected ? '🔌' : '🪵'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to join room.';
      this.callbacks?.onError(msg);
    }
  }

  public async setRulesMode(rulesMode: GameRulesMode): Promise<void> {
    if (!this.roomState || this.roomState.status !== 'WAITING') return;
    const me = this.roomState.players.find((p) => p.id === this.clientId);
    if (!me?.isHost) return;
    const nextState: RoomState = {
      ...this.roomState,
      rulesMode,
    };
    await this.commitAndBroadcastState(nextState);
  }

  public async setPowerUpsEnabled(enabled: boolean): Promise<void> {
    if (!this.roomState || this.roomState.status !== 'WAITING') return;
    const me = this.roomState.players.find((p) => p.id === this.clientId);
    if (!me?.isHost) return;
    const freshBlocks = createInitialBlocks(enabled);
    const nextState: RoomState = {
      ...this.roomState,
      powerUpsEnabled: enabled,
      blocks: freshBlocks,
      lastStableBlocks: cloneBlocks(freshBlocks),
    };
    await this.commitAndBroadcastState(nextState);
  }

  public async startGame(): Promise<void> {
    if (!this.roomState) return;
    const me = this.roomState.players.find((p) => p.id === this.clientId);
    if (!me?.isHost) {
      this.callbacks?.onError('Only the host can start the match.');
      return;
    }
    if (this.roomState.status !== 'WAITING') return;

    const powerUpsOn = this.roomState.powerUpsEnabled !== false;
    const freshBlocks = createInitialBlocks(powerUpsOn);
    const nextState: RoomState = {
      ...this.roomState,
      powerUpsEnabled: powerUpsOn,
      status: 'PLAYING',
      startingPlayerIndex: 0,
      currentTurnIndex: 0,
      turnStartedAt: this.getServerNow(),
      settlingStartedAt: null,
      activeBlockId: null,
      blocksMovedCount: 0,
      players: this.roomState.players.map((p) => ({
        ...p,
        score: 0,
        eliminated: false,
        powerUp: null,
      })),
      winnerId: null,
      loserId: null,
      gameOverReason: null,
      burningBlock: null,
      blocks: freshBlocks,
      lastStableBlocks: cloneBlocks(freshBlocks),
      towerRestoreVersion: 1,
      lastEliminatedPlayerId: null,
      lastEliminatedAt: null,
    };

    await this.commitAndBroadcastState(nextState);
    await this.broadcastSystemChat(
      nextState.rulesMode === 'ELIMINATION'
        ? 'Elimination Tower started! Last builder standing wins!'
        : 'Match started! Pull any block below the top layer.',
      nextState.rulesMode === 'ELIMINATION' ? '💥' : '🎯'
    );
  }

  public hoverBlock(blockId: number | null): void {
    if (!this.channel || !this.roomState || this.roomState.status !== 'PLAYING') return;
    const active = this.roomState.players[this.roomState.currentTurnIndex];
    if (active?.id !== this.clientId) return;

    void this.channel.send({
      type: 'broadcast',
      event: 'block:hovered',
      payload: { blockId, playerId: this.clientId },
    });
  }

  public broadcastSound(event: GlobalSoundEvent): void {
    if (!this.channel || !this.roomState) return;
    void this.channel.send({
      type: 'broadcast',
      event: 'sfx:event',
      payload: event,
    });
  }

  public grabBlock(blockId: number, committed: boolean): void {
    if (!this.channel || !this.roomState || this.roomState.status !== 'PLAYING') return;
    const active = this.roomState.players[this.roomState.currentTurnIndex];
    if (active?.id !== this.clientId) return;

    if (this.roomState.activeBlockId !== null && this.roomState.activeBlockId !== blockId) {
      this.callbacks?.onError('Single-block rule: finish moving your committed block first.');
      return;
    }

    if (!isBlockSelectable(this.roomState.blocks, blockId)) {
      this.callbacks?.onError(
        'Illegal move: cannot pull from the top layer or incomplete top layer.'
      );
      return;
    }

    void this.channel.send({
      type: 'broadcast',
      event: 'block:grabbed',
      payload: { blockId, playerId: this.clientId, committed },
    });

    if (!committed) return;

    const targetBlock = this.roomState.blocks.find((b) => b.id === blockId);
    const powerUpsOn = this.roomState.powerUpsEnabled !== false;
    let grantedPowerUp: PowerUpType | null = null;
    const collectedPowerUp = powerUpsOn && Boolean(targetBlock?.hasMysteryPowerUp);
    const startedBurn =
      powerUpsOn &&
      targetBlock?.effect === 'BURN' &&
      this.roomState.burningBlock?.blockId !== blockId;
    const needsCommit =
      this.roomState.activeBlockId !== blockId || collectedPowerUp || startedBurn;

    if (!needsCommit) return;

    let nextPlayers = this.roomState.players;
    let nextBlocks = this.roomState.blocks;
    let nextStableBlocks = this.roomState.lastStableBlocks;
    let nextBurning = this.roomState.burningBlock ?? null;

    if (collectedPowerUp) {
      grantedPowerUp = Math.random() < 0.5 ? 'ICE_BLOCK' : 'BURNING_HAND';
      nextPlayers = nextPlayers.map((p, idx) =>
        idx === this.roomState!.currentTurnIndex ? { ...p, powerUp: grantedPowerUp } : p
      );
      nextBlocks = nextBlocks.map((b) =>
        b.id === blockId ? { ...b, hasMysteryPowerUp: false } : b
      );
      nextStableBlocks = nextStableBlocks.map((b) =>
        b.id === blockId ? { ...b, hasMysteryPowerUp: false } : b
      );
    }

    if (startedBurn) {
      nextBurning = {
        blockId,
        playerId: active.id,
        startedAt: this.getServerNow(),
        durationMs: BURN_DURATION_MS,
      };
    }

    const nextState: RoomState = {
      ...this.roomState,
      activeBlockId: blockId,
      players: nextPlayers,
      blocks: nextBlocks,
      lastStableBlocks: nextStableBlocks,
      burningBlock: nextBurning,
      lastEliminatedPlayerId: null,
      lastEliminatedAt: null,
    };

    void this.commitAndBroadcastState(nextState);

    if (grantedPowerUp) {
      const label = grantedPowerUp === 'ICE_BLOCK' ? 'Ice Block' : 'Burning Hand';
      const icon = grantedPowerUp === 'ICE_BLOCK' ? '🧊' : '🔥';
      void this.broadcastSystemChat(
        `${active.name} unlocked ${icon} ${label} from a Mystery Block!`,
        icon
      );
    }
    if (startedBurn) {
      void this.broadcastSystemChat(
        `🔥 ${active.name} picked up a BURNING block! Place it within 10s!`,
        '🔥'
      );
    }
  }

  public async usePowerUp(blockId: number): Promise<void> {
    if (
      !this.roomState ||
      this.roomState.status !== 'PLAYING' ||
      this.roomState.powerUpsEnabled === false
    ) {
      return;
    }
    const active = this.roomState.players[this.roomState.currentTurnIndex];
    if (!active || active.id !== this.clientId || !active.powerUp) return;

    const targetBlock = this.roomState.blocks.find((b) => b.id === blockId);
    if (!targetBlock || targetBlock.isRemoved) return;

    const powerUp = active.powerUp;
    const nextEffect = powerUp === 'ICE_BLOCK' ? 'ICE' : 'BURN';

    const nextPlayers = this.roomState.players.map((p, idx) =>
      idx === this.roomState!.currentTurnIndex ? { ...p, powerUp: null } : p
    );
    const nextBurnTurns = nextEffect === 'BURN' ? BURN_MAX_TURNS : null;
    const nextBlocks = this.roomState.blocks.map((b) =>
      b.id === blockId
        ? {
            ...b,
            effect: nextEffect as 'ICE' | 'BURN',
            burnTurnsRemaining: nextBurnTurns,
            hasMysteryPowerUp: false,
          }
        : b
    );
    const nextStableBlocks = this.roomState.lastStableBlocks.map((b) =>
      b.id === blockId
        ? {
            ...b,
            effect: nextEffect as 'ICE' | 'BURN',
            burnTurnsRemaining: nextBurnTurns,
            hasMysteryPowerUp: false,
          }
        : b
    );

    const startBurnNow =
      nextEffect === 'BURN' && this.roomState.activeBlockId === blockId;
    const nextBurning = startBurnNow
      ? {
          blockId,
          playerId: active.id,
          startedAt: this.getServerNow(),
          durationMs: BURN_DURATION_MS,
        }
      : this.roomState.burningBlock ?? null;

    const nextState: RoomState = {
      ...this.roomState,
      players: nextPlayers,
      blocks: nextBlocks,
      lastStableBlocks: nextStableBlocks,
      burningBlock: nextBurning,
      lastEliminatedPlayerId: null,
      lastEliminatedAt: null,
    };

    await this.commitAndBroadcastState(nextState);
    if (powerUp === 'ICE_BLOCK') {
      await this.broadcastSystemChat(
        `🧊 ${active.name} froze Block #${blockId + 1} with Ice Block!`,
        '🧊'
      );
    } else {
      await this.broadcastSystemChat(
        `🔥 ${active.name} cursed Block #${blockId + 1} with Burning Hand!`,
        '🔥'
      );
    }
  }

  public syncPhysics(compactBlocks: CompactBlockTuple[]): void {
    if (!this.channel || !this.roomState) return;
    if (this.roomState.status !== 'PLAYING' && this.roomState.status !== 'SETTLING') return;
    const active = this.roomState.players[this.roomState.currentTurnIndex];
    if (active?.id !== this.clientId) return;

    // Keep local roomState blocks aligned with latest simulated transforms
    for (const tuple of compactBlocks) {
      if (!Array.isArray(tuple) || tuple.length < 8) continue;
      const [id, x, y, z, qx, qy, qz, qw] = tuple;
      const block = this.roomState.blocks[id];
      if (block && block.id === id) {
        block.position = [x, y, z];
        block.quaternion = [qx, qy, qz, qw];
      }
    }

    void this.channel.send({
      type: 'broadcast',
      event: 'physics:state',
      payload: compactBlocks,
    });
  }

  public async placeBlock(
    blockId: number,
    finalTransform: { position: Vec3; quaternion: Quat },
    targetLayer?: number,
    targetSlot?: number
  ): Promise<void> {
    if (!this.roomState || this.roomState.status !== 'PLAYING') return;
    const active = this.roomState.players[this.roomState.currentTurnIndex];
    if (active?.id !== this.clientId) return;

    const fallbackSlot = getValidTopPlacements(this.roomState.blocks, blockId)[0];
    const resolvedLayer =
      typeof targetLayer === 'number' ? targetLayer : fallbackSlot.layer;
    const resolvedSlot =
      typeof targetSlot === 'number' ? targetSlot : fallbackSlot.slot;

    const nextPlayers = this.roomState.players.map((p, idx) =>
      idx === this.roomState!.currentTurnIndex ? { ...p, score: p.score + 1 } : p
    );

    const nextBlocks = this.roomState.blocks.map((b) =>
      b.id === blockId
        ? {
            ...b,
            layer: resolvedLayer,
            slot: resolvedSlot,
            position: finalTransform.position,
            quaternion: finalTransform.quaternion,
            isRemoved: false,
            effect: null,
            burnTurnsRemaining: null,
          }
        : b
    );

    const nextState: RoomState = {
      ...this.roomState,
      status: 'SETTLING',
      settlingStartedAt: this.getServerNow(),
      activeBlockId: null,
      burningBlock: null,
      lastEliminatedPlayerId: null,
      lastEliminatedAt: null,
      blocksMovedCount: this.roomState.blocksMovedCount + 1,
      players: nextPlayers,
      blocks: nextBlocks,
    };

    await this.commitAndBroadcastState(nextState);
  }

  public async reportCollapse(): Promise<void> {
    if (!this.roomState) return;
    if (this.roomState.status !== 'PLAYING' && this.roomState.status !== 'SETTLING') return;
    if (Date.now() - this.lastRestoreOrCollapseAt < 2500) return;
    this.lastRestoreOrCollapseAt = Date.now();

    const active = this.roomState.players[this.roomState.currentTurnIndex];
    const loserId = active?.id ?? null;

    if (this.roomState.rulesMode === 'ELIMINATION' && loserId) {
      await this.eliminatePlayerAndRestore(
        loserId,
        `${active?.name ?? 'A player'} toppled the tower and was ELIMINATED!`
      );
      return;
    }

    const ended = this.buildEndedState(this.roomState, loserId, 'TOWER_COLLAPSED');

    await this.commitAndBroadcastState(ended);
    await this.broadcastSystemChat(
      `TIMBER! The tower collapsed on ${active?.name ?? 'a player'}'s turn!`,
      '💥'
    );
  }

  public async rematch(): Promise<void> {
    if (!this.roomState) return;
    const resetPlayers = this.roomState.players.map((p) => ({
      ...p,
      score: 0,
      eliminated: false,
      powerUp: null,
    }));
    const nextStarter = this.findNextConnectedPlayerIndex(
      this.roomState,
      this.roomState.startingPlayerIndex,
      resetPlayers
    );
    const powerUpsOn = this.roomState.powerUpsEnabled !== false;
    const freshBlocks = createInitialBlocks(powerUpsOn);

    const nextState: RoomState = {
      ...this.roomState,
      powerUpsEnabled: powerUpsOn,
      status: 'PLAYING',
      startingPlayerIndex: nextStarter,
      currentTurnIndex: nextStarter,
      turnStartedAt: this.getServerNow(),
      settlingStartedAt: null,
      activeBlockId: null,
      burningBlock: null,
      blocksMovedCount: 0,
      players: resetPlayers,
      blocks: freshBlocks,
      lastStableBlocks: cloneBlocks(freshBlocks),
      towerRestoreVersion: (this.roomState.towerRestoreVersion ?? 1) + 1,
      lastEliminatedPlayerId: null,
      lastEliminatedAt: null,
      winnerId: null,
      loserId: null,
      gameOverReason: null,
    };

    await this.commitAndBroadcastState(nextState);
    const starter = nextState.players[nextState.currentTurnIndex];
    await this.broadcastSystemChat(
      `Rematch started! ${starter?.name ?? 'Player 1'} goes first.`,
      '🔄'
    );
  }

  public async sendChat(message: string, emoji?: string): Promise<void> {
    if (!this.channel || !this.roomState) return;
    const me = this.roomState.players.find((p) => p.id === this.clientId);
    if (!me) return;

    const cleanMessage = message.trim().slice(0, 180);
    const cleanEmoji = emoji ? emoji.trim().slice(0, 8) : undefined;
    if (!cleanMessage && !cleanEmoji) return;

    const chat: ChatMessage = {
      id: `msg-${Date.now()}-${nanoid(5)}`,
      senderId: me.id,
      senderName: me.name,
      message: cleanMessage,
      emoji: cleanEmoji,
      system: false,
      timestamp: this.getServerNow(),
    };

    this.callbacks?.onChatMessage(chat);
    await this.channel.send({
      type: 'broadcast',
      event: 'chat:message',
      payload: chat,
    });
  }

  public async leaveRoom(): Promise<void> {
    this.clearTimers();

    if (this.roomState && this.roomState.status === 'WAITING' && this.client) {
      const remaining = this.roomState.players.filter((p) => p.id !== this.clientId);
      if (remaining.length === 0) {
        await this.client
          .from('jenga_rooms')
          .delete()
          .eq('room_id', this.roomState.roomId);
      } else {
        if (!remaining.some((p) => p.isHost)) {
          remaining[0] = { ...remaining[0], isHost: true };
        }
        const updated: RoomState = {
          ...this.roomState,
          players: remaining,
          currentTurnIndex: 0,
        };
        await this.persistState(updated);
        if (this.channel) {
          await this.channel.send({
            type: 'broadcast',
            event: 'room:state',
            payload: updated,
          });
        }
      }
    }

    if (this.channel && this.client) {
      try {
        await this.channel.untrack();
        await this.client.removeChannel(this.channel);
      } catch {
        // Ignore cleanup errors
      }
      this.channel = null;
    }

    this.roomState = null;
  }
}

export const supabaseMultiplayer = new SupabaseRoomController();
