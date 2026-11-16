import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { soundEngine } from './audio/soundEngine';
import { GameHUD } from './components/GameHUD';
import { Lobby } from './components/Lobby';
import { connectSocket, getServerUrl, getSocket, setServerUrl } from './network/socket';
import { JengaTower } from './scene/JengaTower';
import {
  ChatMessage,
  CompactBlockTuple,
  createInitialBlocks,
  GameMode,
  Quat,
  RoomState,
  SETTLING_DURATION_MS,
  TURN_DURATION_MS,
  Vec3,
} from './types';

function createLocalRoomState(playerNames: string[]): RoomState {
  return {
    roomId: 'LOCAL',
    status: 'PLAYING',
    players: playerNames.map((name, idx) => ({
      id: `local-${idx}`,
      name,
      score: 0,
      isHost: idx === 0,
      connected: true,
    })),
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
}

export default function App() {
  const initialRoomCode = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get('room') ?? '').trim().toUpperCase().slice(0, 6);
  }, []);

  const [mode, setMode] = useState<GameMode>('ONLINE');
  const [serverUrl, setServerUrlState] = useState<string>(() => getServerUrl());
  const [connected, setConnected] = useState(false);
  const [mySocketId, setMySocketId] = useState<string | null>(null);
  const [onlineRoomState, setOnlineRoomState] = useState<RoomState | null>(null);
  const [localRoomState, setLocalRoomState] = useState<RoomState | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [floatingReaction, setFloatingReaction] = useState<{
    id: string;
    emoji: string;
    sender: string;
  } | null>(null);

  const [remoteHoveredBlockId, setRemoteHoveredBlockId] = useState<number | null>(null);
  const [remoteGrabbedBlockId, setRemoteGrabbedBlockId] = useState<number | null>(null);
  const [matchResetVersion, setMatchResetVersion] = useState(1);
  const [cameraResetTrigger, setCameraResetTrigger] = useState(0);
  const [muted, setMuted] = useState(false);

  const remotePhysicsFrames = useRef<
    Map<number, { pos: THREE.Vector3; quat: THREE.Quaternion }>
  >(new Map());
  const localTurnTimeoutRef = useRef<number | null>(null);
  const localSettlingTimeoutRef = useRef<number | null>(null);
  const reactionTimeoutRef = useRef<number | null>(null);
  const prevTurnMarkerRef = useRef<string | null>(null);

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
  }, []);

  const showFloatingEmoji = useCallback((id: string, emoji: string, sender: string) => {
    setFloatingReaction({ id, emoji, sender });
    if (reactionTimeoutRef.current !== null) {
      window.clearTimeout(reactionTimeoutRef.current);
    }
    reactionTimeoutRef.current = window.setTimeout(() => {
      setFloatingReaction(null);
    }, 2200);
  }, []);

  // Connect Socket.IO client & subscribe to authoritative events
  useEffect(() => {
    const socket = connectSocket();

    const handleConnect = () => {
      setConnected(true);
      setMySocketId(socket.id ?? null);
    };

    const handleDisconnect = () => {
      setConnected(false);
    };

    const handleRoomState = (nextState: RoomState) => {
      setOnlineRoomState((prev) => {
        const isFreshMatch =
          nextState.blocksMovedCount === 0 &&
          nextState.status === 'PLAYING' &&
          (!prev || prev.status !== 'PLAYING' || prev.blocksMovedCount > 0);
        if (isFreshMatch) {
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
    };

    const handlePhysicsState = (compactBlocks: CompactBlockTuple[]) => {
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
    };

    const handleBlockHovered = (payload: { blockId: number | null; playerId: string }) => {
      setRemoteHoveredBlockId(payload.blockId);
    };

    const handleBlockGrabbed = (payload: {
      blockId: number;
      playerId: string;
      committed: boolean;
    }) => {
      setRemoteGrabbedBlockId(payload.blockId);
    };

    const handleChatMessage = (msg: ChatMessage) => {
      setChatMessages((prev) => [...prev.slice(-60), msg]);
      if (!msg.system && msg.emoji && !msg.message) {
        showFloatingEmoji(msg.id, msg.emoji, msg.senderName);
      }
    };

    const handleRoomError = (payload: { message: string }) => {
      setLobbyError(payload.message);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('room:state', handleRoomState);
    socket.on('physics:state', handlePhysicsState);
    socket.on('block:hovered', handleBlockHovered);
    socket.on('block:grabbed', handleBlockGrabbed);
    socket.on('chat:system', handleChatMessage);
    socket.on('chat:message', handleChatMessage);
    socket.on('room:error', handleRoomError);

    if (socket.connected) {
      handleConnect();
    }

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('room:state', handleRoomState);
      socket.off('physics:state', handlePhysicsState);
      socket.off('block:hovered', handleBlockHovered);
      socket.off('block:grabbed', handleBlockGrabbed);
      socket.off('chat:system', handleChatMessage);
      socket.off('chat:message', handleChatMessage);
      socket.off('room:error', handleRoomError);
    };
  }, [showFloatingEmoji, serverUrl]);

  const handleUpdateServerUrl = useCallback((nextUrl: string) => {
    const normalized = setServerUrl(nextUrl);
    setConnected(false);
    setMySocketId(null);
    setOnlineRoomState(null);
    setLobbyError(null);
    setChatMessages([]);
    remotePhysicsFrames.current.clear();
    setServerUrlState(normalized);
  }, []);

  // Turn audio chime when turn shifts to user
  useEffect(() => {
    if (!activeRoomState || activeRoomState.status !== 'PLAYING') return;
    const activePlayer = activeRoomState.players[activeRoomState.currentTurnIndex];
    const marker = `${activeRoomState.roomId}-${activeRoomState.blocksMovedCount}-${activePlayer?.id}`;
    if (prevTurnMarkerRef.current !== marker) {
      prevTurnMarkerRef.current = marker;
      if (mode === 'LOCAL' || activePlayer?.id === mySocketId) {
        soundEngine.playTurnChime();
      }
    }
  }, [activeRoomState, mode, mySocketId]);

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
        setLocalRoomState((prev) => {
          if (!prev || prev.status !== 'PLAYING') return prev;
          const loser = prev.players[prev.currentTurnIndex];
          const winner =
            prev.players.length > 1
              ? prev.players.find((p) => p.id !== loser?.id) ?? null
              : null;
          return {
            ...prev,
            status: 'GAME_OVER',
            activeBlockId: null,
            loserId: loser?.id ?? null,
            winnerId: winner?.id ?? null,
            gameOverReason: 'TIMEOUT',
          };
        });
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
  ]);

  const handleCreateOnlineRoom = (playerName: string) => {
    soundEngine.unlock();
    setMode('ONLINE');
    setChatMessages([]);
    setLobbyError(null);
    const socket = connectSocket();
    socket.emit('room:create', { playerName });
  };

  const handleJoinOnlineRoom = (roomId: string, playerName: string) => {
    soundEngine.unlock();
    setMode('ONLINE');
    setChatMessages([]);
    setLobbyError(null);
    const socket = connectSocket();
    socket.emit('room:join', { roomId, playerName });
  };

  const handleStartOnlineGame = () => {
    if (!onlineRoomState) return;
    soundEngine.unlock();
    getSocket().emit('game:start', { roomId: onlineRoomState.roomId });
  };

  const handleLeaveOnlineRoom = () => {
    const socket = getSocket();
    socket.disconnect();
    socket.connect();
    setOnlineRoomState(null);
    setChatMessages([]);
    remotePhysicsFrames.current.clear();
  };

  const handleStartLocalGame = (playerNames: string[]) => {
    soundEngine.unlock();
    clearLocalTimers();
    setMode('LOCAL');
    setChatMessages([
      {
        id: `local-start-${Date.now()}`,
        senderId: 'system',
        senderName: 'Jenga Referee',
        message: `Local match started with ${playerNames.join(', ')}!`,
        emoji: '🪵',
        system: true,
        timestamp: Date.now(),
      },
    ]);
    setLocalRoomState(createLocalRoomState(playerNames));
    setMatchResetVersion((v) => v + 1);
  };

  const handleHoverBlock = useCallback(
    (blockId: number | null) => {
      if (mode !== 'ONLINE' || !onlineRoomState) return;
      getSocket().emit('block:hover', {
        roomId: onlineRoomState.roomId,
        blockId,
      });
    },
    [mode, onlineRoomState]
  );

  const handleGrabBlock = useCallback(
    (blockId: number, committed: boolean) => {
      if (mode === 'LOCAL') {
        if (committed) {
          setLocalRoomState((prev) =>
            prev && prev.activeBlockId === null
              ? { ...prev, activeBlockId: blockId }
              : prev
          );
        }
        return;
      }

      if (!onlineRoomState) return;
      getSocket().emit('block:grab', {
        roomId: onlineRoomState.roomId,
        blockId,
        committed,
      });
    },
    [mode, onlineRoomState]
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
                }
              : b
          );

          return {
            ...prev,
            status: 'SETTLING',
            settlingStartedAt: Date.now(),
            activeBlockId: null,
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
            return {
              ...prev,
              status: 'PLAYING',
              settlingStartedAt: null,
              turnStartedAt: Date.now(),
              currentTurnIndex: (prev.currentTurnIndex + 1) % prev.players.length,
            };
          });
        }, SETTLING_DURATION_MS);
        return;
      }

      if (!onlineRoomState) return;
      getSocket().emit('block:placed', {
        roomId: onlineRoomState.roomId,
        blockId,
        finalTransform,
        targetLayer,
        targetSlot,
      });
    },
    [mode, onlineRoomState]
  );

  const handlePhysicsSync = useCallback(
    (compactBlocks: CompactBlockTuple[]) => {
      if (mode !== 'ONLINE' || !onlineRoomState) return;
      getSocket().emit('physics:sync', {
        roomId: onlineRoomState.roomId,
        blocks: compactBlocks,
      });
    },
    [mode, onlineRoomState]
  );

  const handleCollapse = useCallback(() => {
    if (mode === 'LOCAL') {
      clearLocalTimers();
      setLocalRoomState((prev) => {
        if (!prev || prev.status === 'GAME_OVER') return prev;
        const loser = prev.players[prev.currentTurnIndex];
        const candidates = prev.players.filter((p) => p.id !== loser?.id);
        const winner =
          candidates.length > 0
            ? [...candidates].sort((a, b) => b.score - a.score)[0]
            : null;
        return {
          ...prev,
          status: 'GAME_OVER',
          settlingStartedAt: null,
          activeBlockId: null,
          loserId: loser?.id ?? null,
          winnerId: winner?.id ?? null,
          gameOverReason: 'TOWER_COLLAPSED',
        };
      });
      setChatMessages((prev) => [
        ...prev.slice(-60),
        {
          id: `collapse-${Date.now()}`,
          senderId: 'system',
          senderName: 'Jenga Referee',
          message: 'TIMBER! The tower collapsed!',
          emoji: '💥',
          system: true,
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    if (!onlineRoomState) return;
    const activePlayer = onlineRoomState.players[onlineRoomState.currentTurnIndex];
    getSocket().emit('game:collapse', {
      roomId: onlineRoomState.roomId,
      loserId: activePlayer?.id,
    });
  }, [mode, onlineRoomState, clearLocalTimers]);

  const handleRematch = useCallback(() => {
    soundEngine.unlock();
    if (mode === 'LOCAL') {
      clearLocalTimers();
      setLocalRoomState((prev) => {
        if (!prev) return prev;
        const nextStarter = (prev.startingPlayerIndex + 1) % prev.players.length;
        return {
          ...prev,
          status: 'PLAYING',
          startingPlayerIndex: nextStarter,
          currentTurnIndex: nextStarter,
          turnStartedAt: Date.now(),
          settlingStartedAt: null,
          activeBlockId: null,
          blocksMovedCount: 0,
          players: prev.players.map((p) => ({ ...p, score: 0 })),
          blocks: createInitialBlocks(),
          winnerId: null,
          loserId: null,
          gameOverReason: null,
        };
      });
      setMatchResetVersion((v) => v + 1);
      return;
    }

    if (!onlineRoomState) return;
    getSocket().emit('game:rematch', { roomId: onlineRoomState.roomId });
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
      getSocket().emit('chat:send', {
        roomId: onlineRoomState.roomId,
        message,
        emoji,
      });
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

  const showcaseBlocks = useMemo(() => createInitialBlocks(), []);
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
            remoteHoveredBlockId={remoteHoveredBlockId}
            remoteGrabbedBlockId={remoteGrabbedBlockId}
            remotePhysicsFrames={remotePhysicsFrames}
            matchResetVersion={matchResetVersion}
            cameraResetTrigger={cameraResetTrigger}
            onHoverBlock={handleHoverBlock}
            onGrabBlock={handleGrabBlock}
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
          serverUrl={serverUrl}
          initialRoomCode={initialRoomCode}
          errorMessage={lobbyError}
          onUpdateServerUrl={handleUpdateServerUrl}
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
          floatingReaction={floatingReaction}
          muted={muted}
          onToggleMute={handleToggleMute}
          onResetCamera={() => setCameraResetTrigger((v) => v + 1)}
          onSendChat={handleSendChat}
          onRematch={handleRematch}
          onExitToLobby={handleExitToLobby}
        />
      )}
    </div>
  );
}
