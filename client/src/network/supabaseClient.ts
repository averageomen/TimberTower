import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { customAlphabet, nanoid } from 'nanoid';
import {
  ChatMessage,
  CompactBlockTuple,
  createInitialBlocks,
  getValidTopPlacements,
  isBlockSelectable,
  Player,
  Quat,
  RoomState,
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
  private disconnectTimers = new Map<string, number>();

  public getClientId(): string {
    return this.clientId;
  }

  public getConfig(): SupabaseConfig {
    return this.config;
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

    if (!this.isCoordinator()) return;

    if (state.status === 'PLAYING') {
      const elapsed = Date.now() - state.turnStartedAt;
      const remaining = Math.max(0, state.turnDurationMs - elapsed);
      this.turnTimeoutId = window.setTimeout(() => {
        void this.handleTurnTimeout();
      }, remaining);
    } else if (state.status === 'SETTLING' && state.settlingStartedAt) {
      const elapsed = Date.now() - state.settlingStartedAt;
      const remaining = Math.max(0, state.settlingDurationMs - elapsed);
      this.settlingTimeoutId = window.setTimeout(() => {
        void this.completeSettlingPhase();
      }, remaining);
    }
  }

  private async handleTurnTimeout(): Promise<void> {
    if (!this.roomState || this.roomState.status !== 'PLAYING' || !this.isCoordinator()) {
      return;
    }
    const timedOutPlayer = this.roomState.players[this.roomState.currentTurnIndex];
    const loserId = timedOutPlayer?.id ?? null;
    const nextState = this.buildEndedState(this.roomState, loserId, 'TIMEOUT');
    await this.commitAndBroadcastState(nextState);
    await this.broadcastSystemChat(
      `${timedOutPlayer?.name ?? 'Active player'} ran out of time!`,
      '⏰'
    );
  }

  private async completeSettlingPhase(): Promise<void> {
    if (!this.roomState || this.roomState.status !== 'SETTLING' || !this.isCoordinator()) {
      return;
    }
    const nextTurnIndex = this.findNextConnectedPlayerIndex(
      this.roomState,
      this.roomState.currentTurnIndex
    );
    const nextState: RoomState = {
      ...this.roomState,
      status: 'PLAYING',
      settlingStartedAt: null,
      turnStartedAt: Date.now(),
      currentTurnIndex: nextTurnIndex,
    };
    await this.commitAndBroadcastState(nextState);
  }

  private findNextConnectedPlayerIndex(state: RoomState, fromIndex: number): number {
    const count = state.players.length;
    if (count === 0) return 0;
    for (let offset = 1; offset <= count; offset++) {
      const idx = (fromIndex + offset) % count;
      if (state.players[idx]?.connected) return idx;
    }
    return (fromIndex + 1) % count;
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
      settlingStartedAt: null,
      activeBlockId: null,
      loserId,
      winnerId: winner?.id ?? null,
      gameOverReason: reason,
    };
  }

  private applyLocalRoomState(nextState: RoomState): void {
    this.roomState = nextState;
    this.callbacks?.onRoomState(nextState);
    this.syncCoordinatorTimers(nextState);
  }

  private async persistState(state: RoomState): Promise<void> {
    if (!this.client) return;
    const { error } = await this.client.from('jenga_rooms').upsert(
      {
        room_id: state.roomId,
        status: state.status,
        state,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'room_id' }
    );
    if (error) {
      this.callbacks?.onError(`Failed to sync room state: ${error.message}`);
    }
  }

  private async commitAndBroadcastState(state: RoomState): Promise<void> {
    this.applyLocalRoomState(state);
    await this.persistState(state);
    if (this.channel) {
      await this.channel.send({
        type: 'broadcast',
        event: 'room:state',
        payload: state,
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
      timestamp: Date.now(),
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
        if (Array.isArray(payload)) {
          this.callbacks?.onPhysicsState(payload as CompactBlockTuple[]);
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
            joinedAt: Date.now(),
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
    if (incoming.blocksMovedCount > local.blocksMovedCount) return true;
    if (incoming.status !== local.status) return true;
    if (incoming.players.length !== local.players.length) return true;
    if (incoming.activeBlockId !== local.activeBlockId) return true;
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
        turnStartedAt: Date.now(),
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

    const hostPlayer: Player = {
      id: this.clientId,
      name: sanitizePlayerName(rawPlayerName),
      score: 0,
      isHost: true,
      connected: true,
    };

    const initialState: RoomState = {
      roomId,
      status: 'WAITING',
      players: [hostPlayer],
      currentTurnIndex: 0,
      startingPlayerIndex: 0,
      turnStartedAt: Date.now(),
      turnDurationMs: TURN_DURATION_MS,
      settlingStartedAt: null,
      settlingDurationMs: SETTLING_DURATION_MS,
      activeBlockId: null,
      blocksMovedCount: 0,
      blocks: createInitialBlocks(),
      winnerId: null,
      loserId: null,
      gameOverReason: null,
    };

    try {
      await this.persistState(initialState);
      await this.subscribeToRoomChannel(roomId);
      this.applyLocalRoomState(initialState);
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

    const { data, error } = await this.client
      .from('jenga_rooms')
      .select('state')
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

  public async startGame(): Promise<void> {
    if (!this.roomState) return;
    const me = this.roomState.players.find((p) => p.id === this.clientId);
    if (!me?.isHost) {
      this.callbacks?.onError('Only the host can start the match.');
      return;
    }
    if (this.roomState.status !== 'WAITING') return;

    const nextState: RoomState = {
      ...this.roomState,
      status: 'PLAYING',
      startingPlayerIndex: 0,
      currentTurnIndex: 0,
      turnStartedAt: Date.now(),
      settlingStartedAt: null,
      activeBlockId: null,
      blocksMovedCount: 0,
      winnerId: null,
      loserId: null,
      gameOverReason: null,
      blocks: createInitialBlocks(),
    };

    await this.commitAndBroadcastState(nextState);
    await this.broadcastSystemChat('Match started! Pull any block below the top layer.', '🎯');
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

    if (committed && this.roomState.activeBlockId !== blockId) {
      const nextState: RoomState = {
        ...this.roomState,
        activeBlockId: blockId,
      };
      void this.commitAndBroadcastState(nextState);
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
          }
        : b
    );

    const nextState: RoomState = {
      ...this.roomState,
      status: 'SETTLING',
      settlingStartedAt: Date.now(),
      activeBlockId: null,
      blocksMovedCount: this.roomState.blocksMovedCount + 1,
      players: nextPlayers,
      blocks: nextBlocks,
    };

    await this.commitAndBroadcastState(nextState);
  }

  public async reportCollapse(): Promise<void> {
    if (!this.roomState) return;
    if (this.roomState.status !== 'PLAYING' && this.roomState.status !== 'SETTLING') return;

    const active = this.roomState.players[this.roomState.currentTurnIndex];
    const loserId = active?.id ?? null;
    const ended = this.buildEndedState(this.roomState, loserId, 'TOWER_COLLAPSED');

    await this.commitAndBroadcastState(ended);
    await this.broadcastSystemChat(
      `TIMBER! The tower collapsed on ${active?.name ?? 'a player'}'s turn!`,
      '💥'
    );
  }

  public async rematch(): Promise<void> {
    if (!this.roomState) return;
    const nextStarter = this.findNextConnectedPlayerIndex(
      this.roomState,
      this.roomState.startingPlayerIndex
    );

    const nextState: RoomState = {
      ...this.roomState,
      status: 'PLAYING',
      startingPlayerIndex: nextStarter,
      currentTurnIndex: nextStarter,
      turnStartedAt: Date.now(),
      settlingStartedAt: null,
      activeBlockId: null,
      blocksMovedCount: 0,
      players: this.roomState.players.map((p) => ({ ...p, score: 0 })),
      blocks: createInitialBlocks(),
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
      timestamp: Date.now(),
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
