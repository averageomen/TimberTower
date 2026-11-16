import { customAlphabet, nanoid } from 'nanoid';
import {
  ChatMessage,
  CompactBlockTuple,
  createInitialBlocks,
  DISCONNECT_GRACE_MS,
  GameOverReason,
  getNextTopPlacement,
  isBlockSelectable,
  MAX_PLAYERS_PER_ROOM,
  Player,
  Quat,
  RoomState,
  SETTLING_DURATION_MS,
  TURN_DURATION_MS,
  Vec3,
} from './types.js';

const generateRoomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

export type RoomStateBroadcaster = (roomId: string, state: RoomState) => void;
export type SystemChatBroadcaster = (roomId: string, message: ChatMessage) => void;

interface RoomTimers {
  turnTimeout: NodeJS.Timeout | null;
  settlingTimeout: NodeJS.Timeout | null;
  cleanupTimeout: NodeJS.Timeout | null;
  disconnectTimeouts: Map<string, NodeJS.Timeout>;
}

export class RoomManager {
  private rooms = new Map<string, RoomState>();
  private timers = new Map<string, RoomTimers>();
  private socketToRoom = new Map<string, string>();
  private broadcastRoomState: RoomStateBroadcaster;
  private broadcastSystemChat: SystemChatBroadcaster;

  constructor(
    broadcastRoomState: RoomStateBroadcaster,
    broadcastSystemChat: SystemChatBroadcaster
  ) {
    this.broadcastRoomState = broadcastRoomState;
    this.broadcastSystemChat = broadcastSystemChat;
  }

  private createTimers(): RoomTimers {
    return {
      turnTimeout: null,
      settlingTimeout: null,
      cleanupTimeout: null,
      disconnectTimeouts: new Map(),
    };
  }

  private getOrCreateTimers(roomId: string): RoomTimers {
    let entry = this.timers.get(roomId);
    if (!entry) {
      entry = this.createTimers();
      this.timers.set(roomId, entry);
    }
    return entry;
  }

  private clearTurnAndSettlingTimers(roomId: string): void {
    const entry = this.timers.get(roomId);
    if (!entry) return;
    if (entry.turnTimeout) {
      clearTimeout(entry.turnTimeout);
      entry.turnTimeout = null;
    }
    if (entry.settlingTimeout) {
      clearTimeout(entry.settlingTimeout);
      entry.settlingTimeout = null;
    }
  }

  private clearAllTimers(roomId: string): void {
    this.clearTurnAndSettlingTimers(roomId);
    const entry = this.timers.get(roomId);
    if (!entry) return;
    if (entry.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
      entry.cleanupTimeout = null;
    }
    for (const timer of entry.disconnectTimeouts.values()) {
      clearTimeout(timer);
    }
    entry.disconnectTimeouts.clear();
  }

  private scheduleEmptyRoomCleanup(roomId: string): void {
    const entry = this.getOrCreateTimers(roomId);
    if (entry.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
    }
    entry.cleanupTimeout = setTimeout(() => {
      const room = this.rooms.get(roomId);
      if (!room) return;
      const anyConnected = room.players.some((p) => p.connected);
      if (!anyConnected) {
        this.clearAllTimers(roomId);
        this.timers.delete(roomId);
        this.rooms.delete(roomId);
      }
    }, 30_000);
  }

  private cancelEmptyRoomCleanup(roomId: string): void {
    const entry = this.timers.get(roomId);
    if (entry?.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
      entry.cleanupTimeout = null;
    }
  }

  private startTurnTimer(room: RoomState): void {
    const entry = this.getOrCreateTimers(room.roomId);
    if (entry.turnTimeout) {
      clearTimeout(entry.turnTimeout);
      entry.turnTimeout = null;
    }

    room.turnStartedAt = Date.now();
    entry.turnTimeout = setTimeout(() => {
      const currentRoom = this.rooms.get(room.roomId);
      if (!currentRoom || currentRoom.status !== 'PLAYING') return;

      const timedOutPlayer = currentRoom.players[currentRoom.currentTurnIndex];
      const loserId = timedOutPlayer ? timedOutPlayer.id : null;
      this.endGame(currentRoom, loserId, 'TIMEOUT');
      this.emitSystemMessage(
        currentRoom.roomId,
        `${timedOutPlayer?.name ?? 'Active player'} ran out of time!`,
        '⏰'
      );
    }, room.turnDurationMs);
  }

  private endGame(
    room: RoomState,
    loserId: string | null,
    reason: GameOverReason
  ): void {
    this.clearTurnAndSettlingTimers(room.roomId);
    room.status = 'GAME_OVER';
    room.settlingStartedAt = null;
    room.activeBlockId = null;
    room.loserId = loserId;
    room.gameOverReason = reason;

    const candidates = room.players.filter((p) => p.id !== loserId && p.connected);
    const fallbackCandidates = room.players.filter((p) => p.id !== loserId);
    const pool = candidates.length > 0 ? candidates : fallbackCandidates;

    if (pool.length > 0) {
      const winner = [...pool].sort((a, b) => b.score - a.score)[0];
      room.winnerId = winner.id;
    } else {
      room.winnerId = null;
    }

    this.broadcastRoomState(room.roomId, room);
  }

  private emitSystemMessage(roomId: string, message: string, emoji?: string): void {
    this.broadcastSystemChat(roomId, {
      id: nanoid(10),
      senderId: 'system',
      senderName: 'Jenga Referee',
      message,
      emoji,
      system: true,
      timestamp: Date.now(),
    });
  }

  private sanitizeName(rawName: string): string {
    const trimmed = rawName.trim().slice(0, 20);
    return trimmed.length > 0 ? trimmed : 'Player';
  }

  public getRoom(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId.toUpperCase());
  }

  public getRoomIdBySocket(socketId: string): string | undefined {
    return this.socketToRoom.get(socketId);
  }

  public createRoom(socketId: string, rawPlayerName: string): RoomState {
    this.leaveExistingRoomIfAny(socketId);

    let roomId = generateRoomCode();
    while (this.rooms.has(roomId)) {
      roomId = generateRoomCode();
    }

    const hostPlayer: Player = {
      id: socketId,
      name: this.sanitizeName(rawPlayerName),
      score: 0,
      isHost: true,
      connected: true,
    };

    const room: RoomState = {
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

    this.rooms.set(roomId, room);
    this.timers.set(roomId, this.createTimers());
    this.socketToRoom.set(socketId, roomId);
    return room;
  }

  public joinRoom(
    socketId: string,
    rawRoomId: string,
    rawPlayerName: string
  ): { ok: true; room: RoomState; reconnected: boolean } | { ok: false; error: string } {
    const roomId = rawRoomId.trim().toUpperCase();
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, error: `Room "${roomId}" was not found.` };
    }

    const playerName = this.sanitizeName(rawPlayerName);

    // Check for reconnection to a disconnected slot with matching name
    const disconnectedMatch = room.players.find(
      (p) => !p.connected && p.name.toLowerCase() === playerName.toLowerCase()
    );

    if (disconnectedMatch) {
      this.leaveExistingRoomIfAny(socketId);
      const oldId = disconnectedMatch.id;
      const entry = this.getOrCreateTimers(roomId);
      const graceTimer = entry.disconnectTimeouts.get(oldId);
      if (graceTimer) {
        clearTimeout(graceTimer);
        entry.disconnectTimeouts.delete(oldId);
      }

      disconnectedMatch.id = socketId;
      disconnectedMatch.connected = true;
      if (room.winnerId === oldId) room.winnerId = socketId;
      if (room.loserId === oldId) room.loserId = socketId;

      this.cancelEmptyRoomCleanup(roomId);
      this.socketToRoom.set(socketId, roomId);
      return { ok: true, room, reconnected: true };
    }

    if (room.players.some((p) => p.id === socketId)) {
      return { ok: true, room, reconnected: true };
    }

    if (room.status !== 'WAITING') {
      return { ok: false, error: 'This match is already in progress.' };
    }

    if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
      return { ok: false, error: `Room "${roomId}" is full (max ${MAX_PLAYERS_PER_ROOM} players).` };
    }

    this.leaveExistingRoomIfAny(socketId);

    const duplicateName = room.players.some(
      (p) => p.name.toLowerCase() === playerName.toLowerCase()
    );
    const uniqueName = duplicateName
      ? `${playerName.slice(0, 16)} #${room.players.length + 1}`
      : playerName;

    room.players.push({
      id: socketId,
      name: uniqueName,
      score: 0,
      isHost: false,
      connected: true,
    });

    this.cancelEmptyRoomCleanup(roomId);
    this.socketToRoom.set(socketId, roomId);
    return { ok: true, room, reconnected: false };
  }

  public startGame(
    socketId: string,
    rawRoomId: string
  ): { ok: true; room: RoomState } | { ok: false; error: string } {
    const room = this.getRoom(rawRoomId);
    if (!room) {
      return { ok: false, error: 'Room not found.' };
    }

    const player = room.players.find((p) => p.id === socketId);
    if (!player?.isHost) {
      return { ok: false, error: 'Only the host can start the match.' };
    }

    if (room.status !== 'WAITING') {
      return { ok: false, error: 'Match has already started.' };
    }

    room.status = 'PLAYING';
    room.startingPlayerIndex = 0;
    room.currentTurnIndex = 0;
    room.activeBlockId = null;
    room.blocksMovedCount = 0;
    room.winnerId = null;
    room.loserId = null;
    room.gameOverReason = null;
    room.blocks = createInitialBlocks();
    this.startTurnTimer(room);

    return { ok: true, room };
  }

  public canHover(socketId: string, rawRoomId: string): boolean {
    const room = this.getRoom(rawRoomId);
    if (!room || room.status !== 'PLAYING') return false;
    const activePlayer = room.players[room.currentTurnIndex];
    return activePlayer?.id === socketId;
  }

  public grabBlock(
    socketId: string,
    rawRoomId: string,
    blockId: number,
    commitLock: boolean
  ): { ok: true; room: RoomState; lockedNow: boolean } | { ok: false; error: string } {
    const room = this.getRoom(rawRoomId);
    if (!room) {
      return { ok: false, error: 'Room not found.' };
    }

    if (room.status !== 'PLAYING') {
      return { ok: false, error: 'Blocks can only be moved during an active turn.' };
    }

    const activePlayer = room.players[room.currentTurnIndex];
    if (!activePlayer || activePlayer.id !== socketId) {
      return { ok: false, error: 'Wait for your turn before touching the tower.' };
    }

    if (room.activeBlockId !== null && room.activeBlockId !== blockId) {
      return {
        ok: false,
        error: 'Single-block rule: finish moving your committed block first.',
      };
    }

    if (!isBlockSelectable(room.blocks, blockId)) {
      return {
        ok: false,
        error: 'Illegal move: cannot pull from the top layer or incomplete top layer.',
      };
    }

    let lockedNow = false;
    if (commitLock && room.activeBlockId !== blockId) {
      room.activeBlockId = blockId;
      lockedNow = true;
    }

    return { ok: true, room, lockedNow };
  }

  public syncPhysics(
    socketId: string,
    rawRoomId: string,
    compactBlocks: CompactBlockTuple[]
  ): boolean {
    const room = this.getRoom(rawRoomId);
    if (!room) return false;
    if (room.status !== 'PLAYING' && room.status !== 'SETTLING') return false;

    const activePlayer = room.players[room.currentTurnIndex];
    if (!activePlayer || activePlayer.id !== socketId) return false;

    for (const tuple of compactBlocks) {
      if (!Array.isArray(tuple) || tuple.length < 8) continue;
      const [id, x, y, z, qx, qy, qz, qw] = tuple;
      const block = room.blocks[id];
      if (block && block.id === id) {
        block.position = [x, y, z];
        block.quaternion = [qx, qy, qz, qw];
      }
    }

    return true;
  }

  public placeBlock(
    socketId: string,
    rawRoomId: string,
    blockId: number,
    finalTransform: { position: Vec3; quaternion: Quat },
    targetLayer?: number,
    targetSlot?: number
  ): { ok: true; room: RoomState } | { ok: false; error: string } {
    const room = this.getRoom(rawRoomId);
    if (!room) {
      return { ok: false, error: 'Room not found.' };
    }

    if (room.status !== 'PLAYING') {
      return { ok: false, error: 'Cannot place block right now.' };
    }

    const activePlayer = room.players[room.currentTurnIndex];
    if (!activePlayer || activePlayer.id !== socketId) {
      return { ok: false, error: 'Only the active player can complete a placement.' };
    }

    if (room.activeBlockId !== null && room.activeBlockId !== blockId) {
      return { ok: false, error: 'Placed block does not match committed block.' };
    }

    const block = room.blocks.find((b) => b.id === blockId);
    if (!block) {
      return { ok: false, error: 'Invalid block ID.' };
    }

    const nextSlot = getNextTopPlacement(room.blocks);
    block.layer = typeof targetLayer === 'number' ? targetLayer : nextSlot.layer;
    block.slot = typeof targetSlot === 'number' ? targetSlot : nextSlot.slot;
    block.position = finalTransform.position;
    block.quaternion = finalTransform.quaternion;
    block.isRemoved = false;

    activePlayer.score += 1;
    room.blocksMovedCount += 1;
    room.activeBlockId = null;
    room.status = 'SETTLING';
    room.settlingStartedAt = Date.now();

    const entry = this.getOrCreateTimers(room.roomId);
    if (entry.turnTimeout) {
      clearTimeout(entry.turnTimeout);
      entry.turnTimeout = null;
    }
    if (entry.settlingTimeout) {
      clearTimeout(entry.settlingTimeout);
    }

    entry.settlingTimeout = setTimeout(() => {
      const currentRoom = this.rooms.get(room.roomId);
      if (!currentRoom || currentRoom.status !== 'SETTLING') return;

      currentRoom.settlingStartedAt = null;
      currentRoom.status = 'PLAYING';
      currentRoom.currentTurnIndex = this.findNextConnectedPlayerIndex(
        currentRoom,
        currentRoom.currentTurnIndex
      );
      this.startTurnTimer(currentRoom);
      this.broadcastRoomState(currentRoom.roomId, currentRoom);
    }, room.settlingDurationMs);

    return { ok: true, room };
  }

  private findNextConnectedPlayerIndex(room: RoomState, fromIndex: number): number {
    const count = room.players.length;
    if (count === 0) return 0;
    for (let offset = 1; offset <= count; offset++) {
      const candidate = (fromIndex + offset) % count;
      if (room.players[candidate]?.connected) {
        return candidate;
      }
    }
    return (fromIndex + 1) % count;
  }

  public reportCollapse(
    rawRoomId: string,
    reportedLoserId?: string
  ): { ok: true; room: RoomState } | { ok: false; error: string } {
    const room = this.getRoom(rawRoomId);
    if (!room) {
      return { ok: false, error: 'Room not found.' };
    }

    if (room.status !== 'PLAYING' && room.status !== 'SETTLING') {
      return { ok: false, error: 'Match is not active.' };
    }

    const activePlayer = room.players[room.currentTurnIndex];
    const loserId =
      reportedLoserId && room.players.some((p) => p.id === reportedLoserId)
        ? reportedLoserId
        : activePlayer?.id ?? null;

    const loser = room.players.find((p) => p.id === loserId);
    this.endGame(room, loserId, 'TOWER_COLLAPSED');
    this.emitSystemMessage(
      room.roomId,
      `TIMBER! The tower collapsed on ${loser?.name ?? 'a player'}'s turn!`,
      '💥'
    );

    return { ok: true, room };
  }

  public rematch(
    socketId: string,
    rawRoomId: string
  ): { ok: true; room: RoomState } | { ok: false; error: string } {
    const room = this.getRoom(rawRoomId);
    if (!room) {
      return { ok: false, error: 'Room not found.' };
    }

    if (!room.players.some((p) => p.id === socketId)) {
      return { ok: false, error: 'You are not in this room.' };
    }

    this.clearTurnAndSettlingTimers(room.roomId);

    const connectedCount = room.players.filter((p) => p.connected).length;
    if (connectedCount === 0) {
      return { ok: false, error: 'No connected players.' };
    }

    room.startingPlayerIndex = this.findNextConnectedPlayerIndex(
      room,
      room.startingPlayerIndex
    );
    room.currentTurnIndex = room.startingPlayerIndex;
    room.status = 'PLAYING';
    room.activeBlockId = null;
    room.blocksMovedCount = 0;
    room.settlingStartedAt = null;
    room.winnerId = null;
    room.loserId = null;
    room.gameOverReason = null;
    room.blocks = createInitialBlocks();
    for (const player of room.players) {
      player.score = 0;
    }

    this.startTurnTimer(room);
    const starter = room.players[room.currentTurnIndex];
    this.emitSystemMessage(
      room.roomId,
      `Rematch started! ${starter?.name ?? 'Player 1'} goes first.`,
      '🔄'
    );

    return { ok: true, room };
  }

  public buildPlayerChatMessage(
    socketId: string,
    rawRoomId: string,
    message: string,
    emoji?: string
  ): ChatMessage | null {
    const room = this.getRoom(rawRoomId);
    if (!room) return null;
    const player = room.players.find((p) => p.id === socketId);
    if (!player) return null;

    const cleanMessage = message.trim().slice(0, 180);
    const cleanEmoji = emoji ? emoji.trim().slice(0, 8) : undefined;
    if (!cleanMessage && !cleanEmoji) return null;

    return {
      id: nanoid(10),
      senderId: player.id,
      senderName: player.name,
      message: cleanMessage,
      emoji: cleanEmoji,
      system: false,
      timestamp: Date.now(),
    };
  }

  private leaveExistingRoomIfAny(socketId: string): void {
    const prevRoomId = this.socketToRoom.get(socketId);
    if (prevRoomId) {
      this.handleDisconnect(socketId);
    }
  }

  public handleDisconnect(socketId: string): void {
    const roomId = this.socketToRoom.get(socketId);
    if (!roomId) return;
    this.socketToRoom.delete(socketId);

    const room = this.rooms.get(roomId);
    if (!room) return;

    const playerIndex = room.players.findIndex((p) => p.id === socketId);
    if (playerIndex === -1) return;

    const player = room.players[playerIndex];

    // In waiting lobby, remove immediately
    if (room.status === 'WAITING') {
      room.players.splice(playerIndex, 1);
      if (room.players.length === 0) {
        this.clearAllTimers(roomId);
        this.timers.delete(roomId);
        this.rooms.delete(roomId);
        return;
      }
      if (!room.players.some((p) => p.isHost)) {
        room.players[0].isHost = true;
      }
      if (room.currentTurnIndex >= room.players.length) {
        room.currentTurnIndex = 0;
      }
      this.broadcastRoomState(roomId, room);
      this.emitSystemMessage(roomId, `${player.name} left the lobby.`, '👋');
      return;
    }

    // During active or finished match, keep slot for grace period reconnection
    player.connected = false;
    if (player.isHost) {
      const nextConnected = room.players.find((p) => p.connected);
      if (nextConnected) {
        player.isHost = false;
        nextConnected.isHost = true;
      }
    }

    const anyConnected = room.players.some((p) => p.connected);
    if (!anyConnected) {
      this.clearTurnAndSettlingTimers(roomId);
      this.scheduleEmptyRoomCleanup(roomId);
      return;
    }

    this.broadcastRoomState(roomId, room);

    if (room.status === 'PLAYING' || room.status === 'SETTLING') {
      this.emitSystemMessage(
        roomId,
        `${player.name} disconnected. Waiting ${DISCONNECT_GRACE_MS / 1000}s for reconnection...`,
        '⚡'
      );

      const entry = this.getOrCreateTimers(roomId);
      const graceTimer = setTimeout(() => {
        entry.disconnectTimeouts.delete(socketId);
        const currentRoom = this.rooms.get(roomId);
        if (!currentRoom) return;

        const targetPlayer = currentRoom.players.find(
          (p) => !p.connected && p.name === player.name
        );
        if (!targetPlayer) return;

        if (currentRoom.status !== 'PLAYING' && currentRoom.status !== 'SETTLING') {
          return;
        }

        const remainingConnected = currentRoom.players.filter((p) => p.connected);
        if (remainingConnected.length <= 1) {
          this.endGame(currentRoom, targetPlayer.id, 'PLAYER_DISCONNECTED');
          this.emitSystemMessage(
            roomId,
            `${targetPlayer.name} failed to reconnect and forfeited the match.`,
            '🏳️'
          );
          return;
        }

        const activePlayer = currentRoom.players[currentRoom.currentTurnIndex];
        if (activePlayer?.id === targetPlayer.id) {
          currentRoom.activeBlockId = null;
          currentRoom.status = 'PLAYING';
          currentRoom.currentTurnIndex = this.findNextConnectedPlayerIndex(
            currentRoom,
            currentRoom.currentTurnIndex
          );
          this.startTurnTimer(currentRoom);
        }

        this.broadcastRoomState(roomId, currentRoom);
        this.emitSystemMessage(
          roomId,
          `${targetPlayer.name} timed out from disconnect. Match continues.`,
          '➡️'
        );
      }, DISCONNECT_GRACE_MS);

      entry.disconnectTimeouts.set(socketId, graceTimer);
    }
  }
}
