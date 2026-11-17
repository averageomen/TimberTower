import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { soundEngine } from './audio/soundEngine';
import { GameHUD } from './components/GameHUD';
import { Lobby } from './components/Lobby';
import {
  SupabaseConfig,
  supabaseMultiplayer,
} from './network/supabaseClient';
import { JengaTower } from './scene/JengaTower';
import {
  BlockState,
  BURN_DURATION_MS,
  ChatMessage,
  clearAllPowerUpsOnBlocks,
  cloneBlocks,
  CompactBlockTuple,
  createInitialBlocks,
  GameMode,
  GameRulesMode,
  maybeSpawnMysteryBlock,
  PowerUpType,
  Quat,
  RoomState,
  sanitizeStableBlocks,
  SETTLING_DURATION_MS,
  TURN_DURATION_MS,
  Vec3,
} from './types';

function createLocalRoomState(
  playerNames: string[],
  rulesMode: GameRulesMode,
  powerUpsEnabled = true
): RoomState {
  const initialBlocks = createInitialBlocks(powerUpsEnabled);
  return {
    roomId: 'LOCAL',
    status: 'PLAYING',
    rulesMode,
    powerUpsEnabled,
    players: playerNames.map((name, idx) => ({
      id: `local-${idx}`,
      name,
      score: 0,
      isHost: idx === 0,
      connected: true,
      eliminated: false,
    })),
    currentTurnIndex: 0,
    startingPlayerIndex: 0,
    turnStartedAt: Date.now(),
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
    burningBlock: null,
    winnerId: null,
    loserId: null,
    gameOverReason: null,
  };
}

function findNextAliveLocalIndex(
  players: RoomState['players'],
  fromIndex: number
): number {
  const count = players.length;
  if (count === 0) return 0;
  for (let offset = 1; offset <= count; offset++) {
    const idx = (fromIndex + offset) % count;
    if (!players[idx]?.eliminated) return idx;
  }
  return (fromIndex + 1) % count;
}

export default function App() {
  const initialRoomCode = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get('room') ?? '').trim().toUpperCase().slice(0, 6);
  }, []);

  const [mode, setMode] = useState<GameMode>('ONLINE');
  const [supabaseConfig, setSupabaseConfig] = useState<SupabaseConfig>(() =>
    supabaseMultiplayer.getConfig()
  );
  const [connected, setConnected] = useState(false);
  const [mySocketId, setMySocketId] = useState<string | null>(null);
  const [onlineRoomState, setOnlineRoomState] = useState<RoomState | null>(null);
  const [localRoomState, setLocalRoomState] = useState<RoomState | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [floatingReactions, setFloatingReactions] = useState<
    Array<{ id: string; emoji: string; sender: string; jitterX: number }>
  >([]);

  const [remoteHoveredBlockId, setRemoteHoveredBlockId] = useState<number | null>(null);
  const [remoteGrabbedBlockId, setRemoteGrabbedBlockId] = useState<number | null>(null);
  const [matchResetVersion, setMatchResetVersion] = useState(1);
  const [cameraResetTrigger, setCameraResetTrigger] = useState(0);
  const [muted, setMuted] = useState(false);
  const [emoteMuted, setEmoteMuted] = useState(false);
  const [powerUpTargeting, setPowerUpTargeting] = useState<PowerUpType | null>(null);

  const remotePhysicsFrames = useRef<
    Map<number, { pos: THREE.Vector3; quat: THREE.Quaternion }>
  >(new Map());
  const localTurnTimeoutRef = useRef<number | null>(null);
  const localSettlingTimeoutRef = useRef<number | null>(null);
  const localBurnTimeoutRef = useRef<number | null>(null);
  const reactionTimeoutsRef = useRef<number[]>([]);
  const prevTurnMarkerRef = useRef<string | null>(null);
  const lastExplosionAtRef = useRef<string | null>(null);
  const prevMovesStateRef = useRef<{ roomId: string; moves: number } | null>(null);
  const prevCollapseGameOverRef = useRef<string | null>(null);
  const latestLocalSimTransformsRef = useRef<Map<number, { position: Vec3; quaternion: Quat }>>(
    new Map()
  );

  const activeRoomState = mode === 'LOCAL' ? localRoomState : onlineRoomState;

  const clearLocalTimers = useCallback(() => {
    if (localTurnTimeoutRef.current !== null) {
      window.clearTimeout(localTurnTimeoutRef.current);
      localTurnTimeoutRef.current = null;
    }
    if (localSettlingTimeoutRef.current !== null) {
      window.clearTimeout(localSettlingTimeoutRef.current);
      localSettlingTimeoutRef.current = null;
    }
    if (localBurnTimeoutRef.current !== null) {
      window.clearTimeout(localBurnTimeoutRef.current);
      localBurnTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      for (const id of reactionTimeoutsRef.current) {
        window.clearTimeout(id);
      }
      reactionTimeoutsRef.current = [];
    };
  }, []);

  const showFloatingEmoji = useCallback((id: string, emoji: string, sender: string) => {
    soundEngine.playEmote(emoji);
    const jitterX = (Math.random() - 0.5) * 14;
    setFloatingReactions((prev) => [...prev.slice(-11), { id, emoji, sender, jitterX }]);
    const timer = window.setTimeout(() => {
      setFloatingReactions((prev) => prev.filter((item) => item.id !== id));
      reactionTimeoutsRef.current = reactionTimeoutsRef.current.filter((t) => t !== timer);
    }, 1850);
    reactionTimeoutsRef.current.push(timer);
  }, []);

  // Initialize Supabase Realtime + Postgres room controller
  useEffect(() => {
    supabaseMultiplayer.initialize({
      onConnectionChange: (isOnline) => {
        setConnected(isOnline);
      },
      onClientIdChange: (clientId) => {
        setMySocketId(clientId);
      },
      onRoomState: (nextState) => {
        setOnlineRoomState((prev) => {
          const isFreshMatch =
            nextState.blocksMovedCount === 0 &&
            nextState.status === 'PLAYING' &&
            (!prev || prev.status !== 'PLAYING' || prev.blocksMovedCount > 0);
          const isTowerRestored = Boolean(
            prev &&
              (nextState.towerRestoreVersion ?? 1) !== (prev.towerRestoreVersion ?? 1)
          );
          if (isFreshMatch || isTowerRestored) {
            remotePhysicsFrames.current.clear();
            setMatchResetVersion((v) => v + 1);
          }
          return nextState;
        });
        setRemoteHoveredBlockId(null);
        if (nextState.activeBlockId === null) {
          setRemoteGrabbedBlockId(null);
        }
        setLobbyError(null);
      },
      onPhysicsState: (compactBlocks) => {
        for (const tuple of compactBlocks) {
          const [id, x, y, z, qx, qy, qz, qw] = tuple;
          let entry = remotePhysicsFrames.current.get(id);
          if (!entry) {
            entry = {
              pos: new THREE.Vector3(x, y, z),
              quat: new THREE.Quaternion(qx, qy, qz, qw),
            };
            remotePhysicsFrames.current.set(id, entry);
          } else {
            entry.pos.set(x, y, z);
            entry.quat.set(qx, qy, qz, qw);
          }
        }
      },
      onBlockHovered: (payload) => {
        setRemoteHoveredBlockId(payload.blockId);
      },
      onBlockGrabbed: (payload) => {
        setRemoteGrabbedBlockId(payload.blockId);
      },
      onSoundEvent: (event) => {
        soundEngine.playRemoteEvent(event);
      },
      onChatMessage: (msg) => {
        setChatMessages((prev) => [...prev.slice(-60), msg]);
        if (!msg.system && msg.emoji && !msg.message) {
          showFloatingEmoji(msg.id, msg.emoji, msg.senderName);
        }
      },
      onError: (message) => {
        setLobbyError(message);
      },
    });

    soundEngine.setBroadcaster((event) => {
      supabaseMultiplayer.broadcastSound(event);
    });

    return () => {
      soundEngine.setBroadcaster(null);
      void supabaseMultiplayer.leaveRoom();
    };
  }, [showFloatingEmoji]);

  const handleSaveSupabaseConfig = useCallback((url: string, anonKey: string) => {
    setLobbyError(null);
    setOnlineRoomState(null);
    setChatMessages([]);
    remotePhysicsFrames.current.clear();
    const updated = supabaseMultiplayer.updateConfig(url, anonKey);
    setSupabaseConfig(updated);
  }, []);

  // Switch background jazz track between Main Menu, Waiting Lobby, and Active Game
  useEffect(() => {
    if (!activeRoomState) {
      soundEngine.setMusicTrack('MENU');
    } else if (activeRoomState.status === 'WAITING') {
      soundEngine.setMusicTrack('WAITING');
    } else {
      soundEngine.setMusicTrack('GAME');
    }
  }, [activeRoomState]);

  // Trigger explosion & Lego collapse audio once per elimination event
  const elimAudioKey = activeRoomState?.lastEliminatedPlayerId
    ? `${activeRoomState.roomId}-${activeRoomState.towerRestoreVersion}-${activeRoomState.lastEliminatedPlayerId}-${activeRoomState.status === 'GAME_OVER' ? 'end' : 'play'}`
    : null;

  useEffect(() => {
    if (elimAudioKey && elimAudioKey !== lastExplosionAtRef.current) {
      lastExplosionAtRef.current = elimAudioKey;
      soundEngine.playCollapse(false);
      soundEngine.playExplosion(false);
    } else if (!elimAudioKey) {
      lastExplosionAtRef.current = null;
    }
  }, [elimAudioKey]);

  // State-sync fallback for global tower collapse and block placement audio across all clients
  useEffect(() => {
    if (!activeRoomState) {
      prevMovesStateRef.current = null;
      prevCollapseGameOverRef.current = null;
      return;
    }

    const prevMoves = prevMovesStateRef.current;
    if (
      prevMoves &&
      prevMoves.roomId === activeRoomState.roomId &&
      activeRoomState.blocksMovedCount > prevMoves.moves &&
      activeRoomState.blocksMovedCount > 0
    ) {
      soundEngine.playPlace(false);
    }
    prevMovesStateRef.current = {
      roomId: activeRoomState.roomId,
      moves: activeRoomState.blocksMovedCount,
    };

    if (
      activeRoomState.status === 'GAME_OVER' &&
      activeRoomState.gameOverReason === 'TOWER_COLLAPSED'
    ) {
      const marker = `${activeRoomState.roomId}-${activeRoomState.blocksMovedCount}-${activeRoomState.towerRestoreVersion}-${activeRoomState.turnStartedAt}`;
      if (prevCollapseGameOverRef.current !== marker) {
        prevCollapseGameOverRef.current = marker;
        soundEngine.playCollapse(false);
      }
    } else {
      prevCollapseGameOverRef.current = null;
    }
  }, [activeRoomState]);

  // Turn audio chime when turn shifts to user
  useEffect(() => {
    if (!activeRoomState || activeRoomState.status !== 'PLAYING') return;
    const activePlayer = activeRoomState.players[activeRoomState.currentTurnIndex];
    const marker = `${activeRoomState.roomId}-${activeRoomState.blocksMovedCount}-${activeRoomState.towerRestoreVersion}-${activePlayer?.id}`;
    if (prevTurnMarkerRef.current !== marker) {
      prevTurnMarkerRef.current = marker;
      if (mode === 'LOCAL' || activePlayer?.id === mySocketId) {
        soundEngine.playTurnChime();
      }
    }
  }, [activeRoomState, mode, mySocketId]);

  const applyLocalElimination = useCallback((reasonLabel: string) => {
    setLocalRoomState((prev) => {
      if (!prev || (prev.status !== 'PLAYING' && prev.status !== 'SETTLING')) return prev;
      const loser = prev.players[prev.currentTurnIndex];
      const updatedPlayers = prev.players.map((p, idx) =>
        idx === prev.currentTurnIndex ? { ...p, eliminated: true } : p
      );
      const alivePlayers = updatedPlayers.filter((p) => !p.eliminated);
      const now = Date.now();

      if (prev.rulesMode === 'ELIMINATION' && alivePlayers.length >= 2) {
        const powerUpsOn = prev.powerUpsEnabled !== false;
        const restored = sanitizeStableBlocks(
          prev.lastStableBlocks.length > 0
            ? prev.lastStableBlocks
            : createInitialBlocks(powerUpsOn),
          createInitialBlocks(powerUpsOn)
        );
        const nextTurn = findNextAliveLocalIndex(updatedPlayers, prev.currentTurnIndex);
        latestLocalSimTransformsRef.current.clear();
        return {
          ...prev,
          status: 'PLAYING',
          players: updatedPlayers,
          currentTurnIndex: nextTurn,
          turnStartedAt: now,
          settlingStartedAt: null,
          activeBlockId: null,
          burningBlock: null,
          blocks: restored,
          lastStableBlocks: cloneBlocks(restored),
          towerRestoreVersion: prev.towerRestoreVersion + 1,
          lastEliminatedPlayerId: loser?.id ?? null,
          lastEliminatedAt: now,
        };
      }

      const winner =
        alivePlayers[0] ??
        (() => {
          const candidates = prev.players.filter((p) => p.id !== loser?.id);
          return candidates.length > 0
            ? [...candidates].sort((a, b) => b.score - a.score)[0]
            : null;
        })();

      return {
        ...prev,
        status: 'GAME_OVER',
        players: updatedPlayers.map((p) => ({ ...p, powerUp: null })),
        blocks: clearAllPowerUpsOnBlocks(prev.blocks),
        lastStableBlocks: clearAllPowerUpsOnBlocks(prev.lastStableBlocks),
        settlingStartedAt: null,
        activeBlockId: null,
        burningBlock: null,
        lastEliminatedPlayerId: prev.rulesMode === 'ELIMINATION' ? loser?.id ?? null : null,
        lastEliminatedAt: prev.rulesMode === 'ELIMINATION' ? now : null,
        loserId: loser?.id ?? null,
        winnerId: winner?.id ?? null,
        gameOverReason: reasonLabel === 'TIMEOUT' ? 'TIMEOUT' : 'TOWER_COLLAPSED',
      };
    });
  }, []);

  // Local mode 45s turn timer
  useEffect(() => {
    if (mode !== 'LOCAL' || !localRoomState) {
      clearLocalTimers();
      return;
    }

    if (localRoomState.status === 'PLAYING') {
      if (localTurnTimeoutRef.current !== null) {
        window.clearTimeout(localTurnTimeoutRef.current);
      }
      const elapsed = Date.now() - localRoomState.turnStartedAt;
      const remaining = Math.max(0, localRoomState.turnDurationMs - elapsed);
      localTurnTimeoutRef.current = window.setTimeout(() => {
        const currentPlayer = localRoomState.players[localRoomState.currentTurnIndex];
        applyLocalElimination('TIMEOUT');
        setChatMessages((prev) => [
          ...prev.slice(-60),
          {
            id: `timeout-${Date.now()}`,
            senderId: 'system',
            senderName: 'Jenga Referee',
            message:
              localRoomState.rulesMode === 'ELIMINATION'
                ? `${currentPlayer?.name ?? 'Player'} ran out of time and was ELIMINATED!`
                : `${currentPlayer?.name ?? 'Player'} ran out of time!`,
            emoji: localRoomState.rulesMode === 'ELIMINATION' ? '💥' : '⏰',
            system: true,
            timestamp: Date.now(),
          },
        ]);
      }, remaining);
    }

    return () => {
      if (localTurnTimeoutRef.current !== null) {
        window.clearTimeout(localTurnTimeoutRef.current);
        localTurnTimeoutRef.current = null;
      }
    };
  }, [
    mode,
    localRoomState?.status,
    localRoomState?.currentTurnIndex,
    localRoomState?.turnStartedAt,
    clearLocalTimers,
    applyLocalElimination,
  ]);

  // Local mode 10s Burning Hand block countdown timer
  useEffect(() => {
    if (localBurnTimeoutRef.current !== null) {
      window.clearTimeout(localBurnTimeoutRef.current);
      localBurnTimeoutRef.current = null;
    }

    if (
      mode !== 'LOCAL' ||
      !localRoomState ||
      localRoomState.status !== 'PLAYING' ||
      !localRoomState.burningBlock
    ) {
      return;
    }

    const burning = localRoomState.burningBlock;
    const elapsed = Date.now() - burning.startedAt;
    const remaining = Math.max(0, burning.durationMs - elapsed);

    localBurnTimeoutRef.current = window.setTimeout(() => {
      const currentPlayer = localRoomState.players[localRoomState.currentTurnIndex];
      setLocalRoomState((prev) => {
        if (!prev || prev.status !== 'PLAYING' || !prev.burningBlock) return prev;
        return {
          ...prev,
          blocks: prev.blocks.map((b) =>
            b.id === burning.blockId
              ? { ...b, isRemoved: true, effect: null, hasMysteryPowerUp: false }
              : b
          ),
          lastStableBlocks: prev.lastStableBlocks.map((b) =>
            b.id === burning.blockId
              ? { ...b, effect: null, hasMysteryPowerUp: false }
              : b
          ),
          burningBlock: null,
        };
      });
      applyLocalElimination('COLLAPSE');
      setChatMessages((prev) => [
        ...prev.slice(-60),
        {
          id: `burn-${Date.now()}`,
          senderId: 'system',
          senderName: 'Jenga Referee',
          message:
            localRoomState.rulesMode === 'ELIMINATION'
              ? `🔥 ${currentPlayer?.name ?? 'Player'}'s block burned away and they were ELIMINATED!`
              : `🔥 ${currentPlayer?.name ?? 'Player'}'s block burned to ash! Game Over!`,
          emoji: '🔥',
          system: true,
          timestamp: Date.now(),
        },
      ]);
    }, remaining);

    return () => {
      if (localBurnTimeoutRef.current !== null) {
        window.clearTimeout(localBurnTimeoutRef.current);
        localBurnTimeoutRef.current = null;
      }
    };
  }, [
    mode,
    localRoomState?.status,
    localRoomState?.burningBlock,
    applyLocalElimination,
  ]);

  const handleCreateOnlineRoom = (playerName: string) => {
    soundEngine.unlock();
    setMode('ONLINE');
    setChatMessages([]);
    setLobbyError(null);
    void supabaseMultiplayer.createRoom(playerName);
  };

  const handleJoinOnlineRoom = (roomId: string, playerName: string) => {
    soundEngine.unlock();
    setMode('ONLINE');
    setChatMessages([]);
    setLobbyError(null);
    void supabaseMultiplayer.joinRoom(roomId, playerName);
  };

  const handleStartOnlineGame = () => {
    if (!onlineRoomState) return;
    soundEngine.unlock();
    void supabaseMultiplayer.startGame();
  };

  const handleLeaveOnlineRoom = () => {
    void supabaseMultiplayer.leaveRoom();
    setOnlineRoomState(null);
    setChatMessages([]);
    remotePhysicsFrames.current.clear();
  };

  const handleSetOnlineRulesMode = (rulesMode: GameRulesMode) => {
    void supabaseMultiplayer.setRulesMode(rulesMode);
  };

  const handleSetOnlinePowerUpsEnabled = (enabled: boolean) => {
    void supabaseMultiplayer.setPowerUpsEnabled(enabled);
  };

  const handleStartLocalGame = (
    playerNames: string[],
    rulesMode: GameRulesMode,
    powerUpsEnabled: boolean
  ) => {
    soundEngine.unlock();
    clearLocalTimers();
    latestLocalSimTransformsRef.current.clear();
    setMode('LOCAL');
    setChatMessages([
      {
        id: `local-start-${Date.now()}`,
        senderId: 'system',
        senderName: 'Jenga Referee',
        message:
          rulesMode === 'ELIMINATION'
            ? `Elimination Tower started with ${playerNames.join(', ')}!`
            : `Local match started with ${playerNames.join(', ')}!`,
        emoji: rulesMode === 'ELIMINATION' ? '💥' : '🪵',
        system: true,
        timestamp: Date.now(),
      },
    ]);
    setLocalRoomState(createLocalRoomState(playerNames, rulesMode, powerUpsEnabled));
    setMatchResetVersion((v) => v + 1);
  };

  const handleHoverBlock = useCallback(
    (blockId: number | null) => {
      if (mode !== 'ONLINE' || !onlineRoomState) return;
      supabaseMultiplayer.hoverBlock(blockId);
    },
    [mode, onlineRoomState]
  );

  const handleGrabBlock = useCallback(
    (blockId: number, committed: boolean) => {
      if (mode === 'LOCAL') {
        if (!committed || !localRoomState || localRoomState.status !== 'PLAYING') return;

        const activePlayer = localRoomState.players[localRoomState.currentTurnIndex];
        const target = localRoomState.blocks.find((b) => b.id === blockId);
        const powerUpsOn = localRoomState.powerUpsEnabled !== false;
        const collected = powerUpsOn && Boolean(target?.hasMysteryPowerUp);
        const grantedPowerUp: PowerUpType | null = collected
          ? Math.random() < 0.5
            ? 'ICE_BLOCK'
            : 'BURNING_HAND'
          : null;
        const startedBurn = Boolean(
          powerUpsOn &&
            target?.effect === 'BURN' &&
            localRoomState.burningBlock?.blockId !== blockId
        );

        if (
          localRoomState.activeBlockId === blockId &&
          !collected &&
          !startedBurn
        ) {
          return;
        }

        setLocalRoomState((prev) => {
          if (!prev || prev.status !== 'PLAYING') return prev;
          const prevTarget = prev.blocks.find((b) => b.id === blockId);
          const prevPowerUpsOn = prev.powerUpsEnabled !== false;
          const canCollect =
            prevPowerUpsOn && Boolean(prevTarget?.hasMysteryPowerUp) && grantedPowerUp;
          const canBurn =
            prevPowerUpsOn &&
            prevTarget?.effect === 'BURN' &&
            prev.burningBlock?.blockId !== blockId;

          return {
            ...prev,
            activeBlockId: prev.activeBlockId ?? blockId,
            lastEliminatedPlayerId: null,
            lastEliminatedAt: null,
            players: canCollect
              ? prev.players.map((p, idx) =>
                  idx === prev.currentTurnIndex ? { ...p, powerUp: grantedPowerUp } : p
                )
              : prev.players,
            blocks: canCollect
              ? prev.blocks.map((b) =>
                  b.id === blockId ? { ...b, hasMysteryPowerUp: false } : b
                )
              : prev.blocks,
            lastStableBlocks: canCollect
              ? prev.lastStableBlocks.map((b) =>
                  b.id === blockId ? { ...b, hasMysteryPowerUp: false } : b
                )
              : prev.lastStableBlocks,
            burningBlock: canBurn
              ? {
                  blockId,
                  playerId: prev.players[prev.currentTurnIndex]?.id ?? 'local',
                  startedAt: Date.now(),
                  durationMs: BURN_DURATION_MS,
                }
              : prev.burningBlock ?? null,
          };
        });

        if (grantedPowerUp) {
          const icon = grantedPowerUp === 'ICE_BLOCK' ? '🧊' : '🔥';
          const label = grantedPowerUp === 'ICE_BLOCK' ? 'Ice Block' : 'Burning Hand';
          setChatMessages((prev) => [
            ...prev.slice(-60),
            {
              id: `pw-${Date.now()}`,
              senderId: 'system',
              senderName: 'Jenga Referee',
              message: `${activePlayer?.name ?? 'Player'} unlocked ${icon} ${label} from a Mystery Block!`,
              emoji: icon,
              system: true,
              timestamp: Date.now(),
            },
          ]);
        }
        if (startedBurn) {
          setChatMessages((prev) => [
            ...prev.slice(-60),
            {
              id: `burn-start-${Date.now()}`,
              senderId: 'system',
              senderName: 'Jenga Referee',
              message: `🔥 ${activePlayer?.name ?? 'Player'} picked up a BURNING block! Place it within 10s!`,
              emoji: '🔥',
              system: true,
              timestamp: Date.now(),
            },
          ]);
        }
        return;
      }

      if (!onlineRoomState) return;
      supabaseMultiplayer.grabBlock(blockId, committed);
    },
    [mode, localRoomState, onlineRoomState]
  );

  const handleApplyPowerUp = useCallback(
    (blockId: number) => {
      setPowerUpTargeting(null);
      if (mode === 'LOCAL') {
        if (
          !localRoomState ||
          localRoomState.status !== 'PLAYING' ||
          localRoomState.powerUpsEnabled === false
        ) {
          return;
        }
        const activePlayer = localRoomState.players[localRoomState.currentTurnIndex];
        const powerUp = activePlayer?.powerUp ?? null;
        if (!powerUp) return;

        const targetBlock = localRoomState.blocks.find((b) => b.id === blockId);
        if (!targetBlock || targetBlock.isRemoved) return;

        const nextEffect: 'ICE' | 'BURN' = powerUp === 'ICE_BLOCK' ? 'ICE' : 'BURN';
        setLocalRoomState((prev) => {
          if (!prev || prev.status !== 'PLAYING') return prev;
          const activeIdx = prev.currentTurnIndex;
          const curActive = prev.players[activeIdx];
          if (!curActive?.powerUp) return prev;
          const startNow = nextEffect === 'BURN' && prev.activeBlockId === blockId;
          return {
            ...prev,
            lastEliminatedPlayerId: null,
            lastEliminatedAt: null,
            players: prev.players.map((p, idx) =>
              idx === activeIdx ? { ...p, powerUp: null } : p
            ),
            blocks: prev.blocks.map((b) =>
              b.id === blockId ? { ...b, effect: nextEffect, hasMysteryPowerUp: false } : b
            ),
            lastStableBlocks: prev.lastStableBlocks.map((b) =>
              b.id === blockId ? { ...b, effect: nextEffect, hasMysteryPowerUp: false } : b
            ),
            burningBlock: startNow
              ? {
                  blockId,
                  playerId: curActive.id,
                  startedAt: Date.now(),
                  durationMs: BURN_DURATION_MS,
                }
              : prev.burningBlock ?? null,
          };
        });

        const icon = powerUp === 'ICE_BLOCK' ? '🧊' : '🔥';
        const msg =
          powerUp === 'ICE_BLOCK'
            ? `🧊 ${activePlayer?.name ?? 'Player'} froze Block #${blockId + 1} with Ice Block!`
            : `🔥 ${activePlayer?.name ?? 'Player'} cursed Block #${blockId + 1} with Burning Hand!`;
        setChatMessages((prev) => [
          ...prev.slice(-60),
          {
            id: `use-pw-${Date.now()}`,
            senderId: 'system',
            senderName: 'Jenga Referee',
            message: msg,
            emoji: icon,
            system: true,
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      if (!onlineRoomState) return;
      void supabaseMultiplayer.usePowerUp(blockId);
    },
    [mode, localRoomState, onlineRoomState]
  );

  const handlePlaceBlock = useCallback(
    (
      blockId: number,
      finalTransform: { position: Vec3; quaternion: Quat },
      targetLayer: number,
      targetSlot: number
    ) => {
      if (mode === 'LOCAL') {
        setLocalRoomState((prev) => {
          if (!prev || prev.status !== 'PLAYING') return prev;
          const nextPlayers = prev.players.map((p, idx) =>
            idx === prev.currentTurnIndex ? { ...p, score: p.score + 1 } : p
          );
          const nextBlocks = prev.blocks.map((b) =>
            b.id === blockId
              ? {
                  ...b,
                  layer: targetLayer,
                  slot: targetSlot,
                  position: finalTransform.position,
                  quaternion: finalTransform.quaternion,
                  effect: null,
                }
              : b
          );

          return {
            ...prev,
            status: 'SETTLING',
            settlingStartedAt: Date.now(),
            activeBlockId: null,
            burningBlock: null,
            lastEliminatedPlayerId: null,
            lastEliminatedAt: null,
            blocksMovedCount: prev.blocksMovedCount + 1,
            players: nextPlayers,
            blocks: nextBlocks,
          };
        });

        if (localSettlingTimeoutRef.current !== null) {
          window.clearTimeout(localSettlingTimeoutRef.current);
        }
        localSettlingTimeoutRef.current = window.setTimeout(() => {
          setLocalRoomState((prev) => {
            if (!prev || prev.status !== 'SETTLING') return prev;
            const candidateBlocks: BlockState[] = prev.blocks.map((b) => {
              const live = latestLocalSimTransformsRef.current.get(b.id);
              return live
                ? { ...b, position: live.position, quaternion: live.quaternion }
                : b;
            });
            const sanitized = sanitizeStableBlocks(
              candidateBlocks,
              prev.lastStableBlocks
            );
            const powerUpsOn = prev.powerUpsEnabled !== false;
            const settledBlocks = powerUpsOn
              ? maybeSpawnMysteryBlock(sanitized)
              : sanitized;
            return {
              ...prev,
              status: 'PLAYING',
              settlingStartedAt: null,
              turnStartedAt: Date.now(),
              currentTurnIndex: findNextAliveLocalIndex(prev.players, prev.currentTurnIndex),
              burningBlock: null,
              blocks: cloneBlocks(settledBlocks),
              lastStableBlocks: cloneBlocks(settledBlocks),
            };
          });
        }, SETTLING_DURATION_MS);
        return;
      }

      if (!onlineRoomState) return;
      void supabaseMultiplayer.placeBlock(
        blockId,
        finalTransform,
        targetLayer,
        targetSlot
      );
    },
    [mode, onlineRoomState]
  );

  const handlePhysicsSync = useCallback(
    (compactBlocks: CompactBlockTuple[]) => {
      if (mode === 'LOCAL') {
        for (const tuple of compactBlocks) {
          if (!Array.isArray(tuple) || tuple.length < 8) continue;
          const [id, x, y, z, qx, qy, qz, qw] = tuple;
          latestLocalSimTransformsRef.current.set(id, {
            position: [x, y, z],
            quaternion: [qx, qy, qz, qw],
          });
        }
        return;
      }
      if (!onlineRoomState) return;
      supabaseMultiplayer.syncPhysics(compactBlocks);
    },
    [mode, onlineRoomState]
  );

  const handleCollapse = useCallback(() => {
    if (mode === 'LOCAL') {
      clearLocalTimers();
      const activeName =
        localRoomState?.players[localRoomState.currentTurnIndex]?.name ?? 'Player';
      const isElim = localRoomState?.rulesMode === 'ELIMINATION';
      applyLocalElimination('COLLAPSE');
      setChatMessages((prev) => [
        ...prev.slice(-60),
        {
          id: `collapse-${Date.now()}`,
          senderId: 'system',
          senderName: 'Jenga Referee',
          message: isElim
            ? `${activeName} toppled the tower and was ELIMINATED!`
            : 'TIMBER! The tower collapsed!',
          emoji: '💥',
          system: true,
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    if (!onlineRoomState) return;
    void supabaseMultiplayer.reportCollapse();
  }, [mode, localRoomState, onlineRoomState, clearLocalTimers, applyLocalElimination]);

  const handleRematch = useCallback(() => {
    soundEngine.unlock();
    if (mode === 'LOCAL') {
      clearLocalTimers();
      latestLocalSimTransformsRef.current.clear();
      setLocalRoomState((prev) => {
        if (!prev) return prev;
        const nextStarter = (prev.startingPlayerIndex + 1) % prev.players.length;
        const freshBlocks = createInitialBlocks(prev.powerUpsEnabled !== false);
        return {
          ...prev,
          status: 'PLAYING',
          startingPlayerIndex: nextStarter,
          currentTurnIndex: nextStarter,
          turnStartedAt: Date.now(),
          settlingStartedAt: null,
          activeBlockId: null,
          blocksMovedCount: 0,
          players: prev.players.map((p) => ({
            ...p,
            score: 0,
            eliminated: false,
            powerUp: null,
          })),
          blocks: freshBlocks,
          lastStableBlocks: cloneBlocks(freshBlocks),
          towerRestoreVersion: prev.towerRestoreVersion + 1,
          lastEliminatedPlayerId: null,
          lastEliminatedAt: null,
          burningBlock: null,
          winnerId: null,
          loserId: null,
          gameOverReason: null,
        };
      });
      setMatchResetVersion((v) => v + 1);
      return;
    }

    if (!onlineRoomState) return;
    void supabaseMultiplayer.rematch();
  }, [mode, onlineRoomState, clearLocalTimers]);

  const handleExitToLobby = useCallback(() => {
    clearLocalTimers();
    if (mode === 'ONLINE') {
      handleLeaveOnlineRoom();
    } else {
      setLocalRoomState(null);
      setMode('ONLINE');
      setChatMessages([]);
    }
    setMatchResetVersion((v) => v + 1);
  }, [mode, clearLocalTimers]);

  const handleSendChat = useCallback(
    (message: string, emoji?: string) => {
      if (mode === 'LOCAL') {
        const sender =
          localRoomState?.players[localRoomState.currentTurnIndex]?.name ?? 'Player';
        const id = `local-chat-${Date.now()}`;
        setChatMessages((prev) => [
          ...prev.slice(-60),
          {
            id,
            senderId: 'local',
            senderName: sender,
            message,
            emoji,
            system: false,
            timestamp: Date.now(),
          },
        ]);
        if (emoji && !message) {
          showFloatingEmoji(id, emoji, sender);
        }
        return;
      }

      if (!onlineRoomState) return;
      void supabaseMultiplayer.sendChat(message, emoji);
    },
    [mode, localRoomState, onlineRoomState, showFloatingEmoji]
  );

  const handleToggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      soundEngine.setMuted(next);
      return next;
    });
  }, []);

  const handleToggleEmoteMute = useCallback(() => {
    setEmoteMuted((prev) => {
      const next = !prev;
      soundEngine.setEmoteSoundsMuted(next);
      return next;
    });
  }, []);

  const showcaseBlocks = useMemo(() => createInitialBlocks(false), []);
  const sceneBlocks = activeRoomState ? activeRoomState.blocks : showcaseBlocks;
  const sceneStatus = activeRoomState ? activeRoomState.status : 'WAITING';

  const isMyTurn = useMemo(() => {
    if (!activeRoomState || activeRoomState.status === 'WAITING' || activeRoomState.status === 'GAME_OVER') {
      return false;
    }
    if (mode === 'LOCAL') return true;
    const activePlayer = activeRoomState.players[activeRoomState.currentTurnIndex];
    return Boolean(mySocketId && activePlayer?.id === mySocketId);
  }, [activeRoomState, mode, mySocketId]);

  useEffect(() => {
    if (!isMyTurn || activeRoomState?.status !== 'PLAYING') {
      setPowerUpTargeting(null);
    }
  }, [isMyTurn, activeRoomState?.status]);

  const showLobby = !activeRoomState || activeRoomState.status === 'WAITING';

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-stone-950">
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: [11.5, 10.5, 11.5], fov: 44, near: 0.1, far: 160 }}
        onPointerDown={() => soundEngine.unlock()}
      >
        <Suspense fallback={null}>
          <JengaTower
            blocks={sceneBlocks}
            status={sceneStatus}
            isMyTurn={isMyTurn}
            activeBlockId={activeRoomState?.activeBlockId ?? null}
            powerUpTargeting={powerUpTargeting}
            burningBlockId={activeRoomState?.burningBlock?.blockId ?? null}
            remoteHoveredBlockId={remoteHoveredBlockId}
            remoteGrabbedBlockId={remoteGrabbedBlockId}
            remotePhysicsFrames={remotePhysicsFrames}
            matchResetVersion={matchResetVersion + (activeRoomState?.towerRestoreVersion ?? 0)}
            cameraResetTrigger={cameraResetTrigger}
            onHoverBlock={handleHoverBlock}
            onGrabBlock={handleGrabBlock}
            onApplyPowerUp={handleApplyPowerUp}
            onPlaceBlock={handlePlaceBlock}
            onPhysicsSync={handlePhysicsSync}
            onCollapse={handleCollapse}
          />
        </Suspense>
      </Canvas>

      {showLobby && (
        <Lobby
          roomState={onlineRoomState}
          mySocketId={mySocketId}
          connected={connected}
          supabaseConfig={supabaseConfig}
          initialRoomCode={initialRoomCode}
          errorMessage={lobbyError}
          muted={muted}
          onToggleMute={handleToggleMute}
          onSaveSupabaseConfig={handleSaveSupabaseConfig}
          onSetOnlineRulesMode={handleSetOnlineRulesMode}
          onSetOnlinePowerUpsEnabled={handleSetOnlinePowerUpsEnabled}
          onCreateOnlineRoom={handleCreateOnlineRoom}
          onJoinOnlineRoom={handleJoinOnlineRoom}
          onStartOnlineGame={handleStartOnlineGame}
          onStartLocalGame={handleStartLocalGame}
          onLeaveOnlineRoom={handleLeaveOnlineRoom}
          onClearError={() => setLobbyError(null)}
        />
      )}

      {activeRoomState && activeRoomState.status !== 'WAITING' && (
        <GameHUD
          mode={mode}
          roomState={activeRoomState}
          mySocketId={mySocketId}
          chatMessages={chatMessages}
          floatingReactions={floatingReactions}
          muted={muted}
          emoteMuted={emoteMuted}
          powerUpTargeting={powerUpTargeting}
          onTogglePowerUpTargeting={() => {
            const activePlayer = activeRoomState.players[activeRoomState.currentTurnIndex];
            const myPlayer =
              mode === 'LOCAL'
                ? activePlayer
                : activeRoomState.players.find((p) => p.id === mySocketId);
            if (
              !isMyTurn ||
              activeRoomState.status !== 'PLAYING' ||
              activeRoomState.powerUpsEnabled === false ||
              !myPlayer?.powerUp
            ) {
              setPowerUpTargeting(null);
              return;
            }
            setPowerUpTargeting((prev) => (prev ? null : myPlayer.powerUp ?? null));
          }}
          onToggleMute={handleToggleMute}
          onToggleEmoteMute={handleToggleEmoteMute}
          onResetCamera={() => setCameraResetTrigger((v) => v + 1)}
          onSendChat={handleSendChat}
          onRematch={handleRematch}
          onExitToLobby={handleExitToLobby}
        />
      )}
    </div>
  );
}
