import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Clock,
  Copy,
  Flame,
  Layers,
  LogOut,
  MessageSquare,
  RotateCcw,
  Send,
  Trophy,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';
import { copyToClipboard } from './Lobby';
import {
  ChatMessage,
  GameMode,
  getHighestOccupiedLayer,
  RoomState,
} from '../types';

interface GameHUDProps {
  mode: GameMode;
  roomState: RoomState;
  mySocketId: string | null;
  chatMessages: ChatMessage[];
  floatingReaction: { id: string; emoji: string; sender: string } | null;
  muted: boolean;
  onToggleMute: () => void;
  onResetCamera: () => void;
  onSendChat: (message: string, emoji?: string) => void;
  onRematch: () => void;
  onExitToLobby: () => void;
}

const QUICK_EMOJIS = ['🔥', '👏', '😱', '🪵', '😂', '💥'];

export function GameHUD({
  mode,
  roomState,
  mySocketId,
  chatMessages,
  floatingReaction,
  muted,
  onToggleMute,
  onResetCamera,
  onSendChat,
  onRematch,
  onExitToLobby,
}: GameHUDProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [chatOpen, setChatOpen] = useState(true);
  const [chatInput, setChatInput] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [eliminationBanner, setEliminationBanner] = useState<string | null>(null);
  const lastTickSecondRef = useRef<number | null>(null);
  const lastElimShownRef = useRef<number | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const elimAt = roomState.lastEliminatedAt;
    if (!elimAt || elimAt === lastElimShownRef.current) return;
    lastElimShownRef.current = elimAt;
    const elimPlayer = roomState.players.find(
      (p) => p.id === roomState.lastEliminatedPlayerId
    );
    setEliminationBanner(elimPlayer?.name ?? 'A player');
    const timer = window.setTimeout(() => setEliminationBanner(null), 3400);
    return () => window.clearTimeout(timer);
  }, [roomState.lastEliminatedAt, roomState.lastEliminatedPlayerId, roomState.players]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 100);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const activePlayer = roomState.players[roomState.currentTurnIndex];
  const isMyTurn =
    mode === 'LOCAL' ||
    (Boolean(mySocketId) && activePlayer?.id === mySocketId);

  const turnRemainingMs = Math.max(
    0,
    roomState.turnDurationMs - (nowMs - roomState.turnStartedAt)
  );
  const turnRemainingSec = Math.ceil(turnRemainingMs / 1000);
  const turnPct = Math.min(100, Math.max(0, (turnRemainingMs / roomState.turnDurationMs) * 100));

  const settlingRemainingMs =
    roomState.status === 'SETTLING' && roomState.settlingStartedAt
      ? Math.max(0, roomState.settlingDurationMs - (nowMs - roomState.settlingStartedAt))
      : 0;
  const settlingSec = (settlingRemainingMs / 1000).toFixed(1);

  useEffect(() => {
    if (roomState.status !== 'PLAYING') {
      lastTickSecondRef.current = null;
      return;
    }
    if (turnRemainingSec <= 5 && turnRemainingSec >= 1 && lastTickSecondRef.current !== turnRemainingSec) {
      lastTickSecondRef.current = turnRemainingSec;
      soundEngine.playCountdownTick();
    }
  }, [roomState.status, turnRemainingSec]);

  const { highestLayer } = getHighestOccupiedLayer(roomState.blocks);
  const winner = roomState.players.find((p) => p.id === roomState.winnerId);
  const loser = roomState.players.find((p) => p.id === roomState.loserId);

  const handleCopyInvite = async () => {
    const url =
      window.location.protocol.startsWith('http')
        ? `${window.location.origin}${window.location.pathname}?room=${roomState.roomId}`
        : roomState.roomId;
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    }
  };

  const handleSubmitChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    onSendChat(chatInput.trim());
    setChatInput('');
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-4">
      {/* Top Bar */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* Left: Room & Player Turn Badges */}
        <div className="pointer-events-auto flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {mode === 'ONLINE' ? (
              <button
                type="button"
                onClick={handleCopyInvite}
                className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-stone-900/85 px-3 py-1.5 text-xs font-semibold text-amber-200 shadow-lg backdrop-blur-md transition hover:bg-stone-800/90"
                title="Copy invite link"
              >
                <span className="font-mono tracking-wider">{roomState.roomId}</span>
                {copiedCode ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="text-[11px] text-emerald-300">Copied!</span>
                  </>
                ) : (
                  <Copy className="h-3.5 w-3.5 text-amber-400" />
                )}
              </button>
            ) : (
              <div className="rounded-xl border border-stone-700/80 bg-stone-900/85 px-3 py-1.5 text-xs font-semibold text-amber-200 backdrop-blur-md">
                Local Mode
              </div>
            )}

            <div className="flex items-center gap-1.5 rounded-xl border border-stone-700/80 bg-stone-900/85 px-3 py-1.5 text-xs text-stone-300 backdrop-blur-md">
              <Layers className="h-3.5 w-3.5 text-amber-400" />
              <span>Moves:</span>
              <span className="font-bold text-stone-100">{roomState.blocksMovedCount}</span>
              <span className="mx-1 text-stone-600">•</span>
              <span>Layers:</span>
              <span className="font-bold text-stone-100">{highestLayer + 1}</span>
            </div>

            {roomState.rulesMode === 'ELIMINATION' && (
              <div className="flex items-center gap-1.5 rounded-xl border border-orange-500/40 bg-orange-950/75 px-3 py-1.5 text-xs font-semibold text-orange-200 backdrop-blur-md">
                <Flame className="h-3.5 w-3.5 text-orange-400" />
                Elimination Tower
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {roomState.players.map((player, idx) => {
              const isTurn =
                idx === roomState.currentTurnIndex &&
                roomState.status !== 'GAME_OVER' &&
                !player.eliminated;
              const isMe = mode === 'ONLINE' && player.id === mySocketId;
              return (
                <div
                  key={player.id}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs backdrop-blur-md transition ${
                    player.eliminated
                      ? 'border-red-900/60 bg-red-950/40 text-stone-500 opacity-70'
                      : isTurn
                        ? 'border-amber-400/80 bg-amber-950/80 text-amber-100 shadow-lg shadow-amber-500/15'
                        : 'border-stone-700/70 bg-stone-900/75 text-stone-300'
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      player.eliminated || !player.connected
                        ? 'bg-red-500'
                        : isTurn
                          ? 'animate-pulse bg-amber-400'
                          : 'bg-emerald-400'
                    }`}
                  />
                  <span className={`font-semibold ${player.eliminated ? 'line-through' : ''}`}>
                    {player.name}
                    {isMe ? ' (You)' : ''}
                  </span>
                  {player.eliminated ? (
                    <span className="rounded bg-red-900/70 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-200">
                      Out
                    </span>
                  ) : (
                    <span className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[11px] text-amber-300">
                      {player.score}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Center: Turn Banner & 45s Timer */}
        {roomState.status !== 'GAME_OVER' && (
          <div className="pointer-events-auto mx-auto flex min-w-[260px] max-w-sm flex-col items-center rounded-2xl border border-stone-700/80 bg-stone-900/85 px-4 py-2.5 shadow-xl backdrop-blur-md">
            <div className="flex w-full items-center justify-between gap-4 text-xs font-semibold">
              <span className={isMyTurn ? 'text-amber-300' : 'text-stone-300'}>
                {roomState.status === 'SETTLING'
                  ? 'Checking Tower Stability...'
                  : mode === 'LOCAL'
                    ? `${activePlayer?.name ?? 'Player'}'s Turn`
                    : isMyTurn
                      ? 'Your Turn!'
                      : `${activePlayer?.name ?? 'Opponent'}'s Turn`}
              </span>
              <span
                className={`flex items-center gap-1 font-mono ${
                  turnRemainingSec <= 8 ? 'animate-pulse text-red-400' : 'text-amber-200'
                }`}
              >
                <Clock className="h-3.5 w-3.5" />
                {turnRemainingSec}s
              </span>
            </div>

            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-stone-800">
              <div
                className={`h-full rounded-full transition-all duration-150 ${
                  turnRemainingSec <= 8
                    ? 'bg-red-500'
                    : turnRemainingSec <= 15
                      ? 'bg-amber-400'
                      : 'bg-emerald-400'
                }`}
                style={{ width: `${turnPct}%` }}
              />
            </div>

            {roomState.status === 'PLAYING' && (
              <div className="mt-1.5 text-[11px] text-stone-400">
                {roomState.activeBlockId !== null
                  ? `Block #${roomState.activeBlockId + 1} locked — R / Right-Click: Rotate • F: Flip on Side`
                  : isMyTurn
                    ? 'Pull any block below the top layer'
                    : 'Watch your opponent move'}
              </div>
            )}
          </div>
        )}

        {/* Right: Audio, Camera & Exit Controls */}
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            onClick={onResetCamera}
            className="flex items-center gap-1.5 rounded-xl border border-stone-700/80 bg-stone-900/85 px-3 py-2 text-xs font-medium text-stone-200 backdrop-blur-md transition hover:bg-stone-800"
            title="Reset Camera"
          >
            <Camera className="h-4 w-4 text-amber-300" />
            <span className="hidden sm:inline">Reset View</span>
          </button>

          <button
            onClick={onToggleMute}
            className="rounded-xl border border-stone-700/80 bg-stone-900/85 p-2 text-stone-200 backdrop-blur-md transition hover:bg-stone-800"
            title={muted ? 'Unmute Sound' : 'Mute Sound'}
          >
            {muted ? (
              <VolumeX className="h-4 w-4 text-stone-400" />
            ) : (
              <Volume2 className="h-4 w-4 text-amber-300" />
            )}
          </button>

          <button
            onClick={onExitToLobby}
            className="flex items-center gap-1.5 rounded-xl border border-stone-700/80 bg-stone-900/85 px-3 py-2 text-xs font-medium text-stone-300 backdrop-blur-md transition hover:border-red-500/40 hover:text-red-200"
            title="Leave Match"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Center Overlay: Settling Tower Countdown */}
      {roomState.status === 'SETTLING' && (
        <div className="pointer-events-none flex items-center justify-center">
          <div className="rounded-2xl border border-amber-400/50 bg-stone-950/85 px-6 py-4 text-center shadow-2xl backdrop-blur-md">
            <div className="text-xs font-bold uppercase tracking-[0.2em] text-amber-300">
              Settling Tower...
            </div>
            <div className="mt-1 font-mono text-3xl font-extrabold text-amber-100">
              {settlingSec}s
            </div>
            <div className="mt-1 text-xs text-stone-400">
              Hands off while checking stability
            </div>
          </div>
        </div>
      )}

      {/* Center Overlay: Elimination Blast Alert */}
      {eliminationBanner && roomState.status !== 'GAME_OVER' && (
        <div className="pointer-events-none flex items-center justify-center">
          <div className="animate-pulse rounded-2xl border border-red-500/70 bg-red-950/90 px-6 py-4 text-center shadow-2xl backdrop-blur-md">
            <div className="text-xs font-bold uppercase tracking-[0.2em] text-red-300">
              Player Eliminated!
            </div>
            <div className="mt-1 text-2xl font-extrabold text-white">
              💥 {eliminationBanner} is OUT!
            </div>
            <div className="mt-1 text-xs text-red-200/80">
              Tower restored to last playable state
            </div>
          </div>
        </div>
      )}

      {/* Floating Emoji Reaction Burst */}
      {floatingReaction && (
        <div className="pointer-events-none flex justify-center">
          <div className="animate-bounce rounded-2xl border border-amber-400/40 bg-stone-900/90 px-4 py-2 text-center shadow-xl backdrop-blur-md">
            <div className="text-3xl">{floatingReaction.emoji}</div>
            <div className="text-[11px] font-medium text-amber-200">
              {floatingReaction.sender}
            </div>
          </div>
        </div>
      )}

      {/* Bottom Row: Emoji Reactions & Chat Panel */}
      <div className="flex items-end justify-between gap-4">
        {/* Quick Reaction Bar */}
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-2xl border border-stone-700/80 bg-stone-900/85 px-2.5 py-1.5 shadow-lg backdrop-blur-md">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => onSendChat('', emoji)}
              className="rounded-xl px-2 py-1 text-lg transition hover:scale-125 hover:bg-stone-800"
              title={`React ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>

        {/* Chat Drawer */}
        <div className="pointer-events-auto flex flex-col items-end">
          {chatOpen ? (
            <div className="w-72 overflow-hidden rounded-2xl border border-stone-700/80 bg-stone-900/85 shadow-xl backdrop-blur-md sm:w-80">
              <div className="flex items-center justify-between border-b border-stone-800 px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-stone-300">
                  <MessageSquare className="h-3.5 w-3.5 text-amber-400" />
                  Table Chat
                </div>
                <button
                  onClick={() => setChatOpen(false)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-stone-400 hover:bg-stone-800 hover:text-stone-200"
                >
                  Hide
                </button>
              </div>

              <div
                ref={chatScrollRef}
                className="jenga-scroll max-h-36 space-y-1.5 overflow-y-auto px-3 py-2 text-xs"
              >
                {chatMessages.length === 0 ? (
                  <div className="py-3 text-center text-stone-500">
                    Say hello or send a reaction!
                  </div>
                ) : (
                  chatMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className={
                        msg.system
                          ? 'rounded-lg bg-amber-950/40 px-2 py-1 text-amber-200/90'
                          : 'text-stone-200'
                      }
                    >
                      {msg.system ? (
                        <span>
                          {msg.emoji ? `${msg.emoji} ` : ''}
                          {msg.message}
                        </span>
                      ) : (
                        <span>
                          <span className="font-semibold text-amber-300">
                            {msg.senderName}:{' '}
                          </span>
                          {msg.emoji && <span className="mr-1">{msg.emoji}</span>}
                          {msg.message}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>

              <form
                onSubmit={handleSubmitChat}
                className="flex items-center gap-1.5 border-t border-stone-800 p-2"
              >
                <input
                  type="text"
                  maxLength={140}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Message table..."
                  className="flex-1 rounded-lg bg-stone-950/90 px-2.5 py-1.5 text-xs text-stone-100 outline-none ring-1 ring-stone-800 focus:ring-amber-400"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-amber-500 p-1.5 text-stone-950 transition hover:bg-amber-400"
                  title="Send message"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </form>
            </div>
          ) : (
            <button
              onClick={() => setChatOpen(true)}
              className="flex items-center gap-1.5 rounded-xl border border-stone-700/80 bg-stone-900/85 px-3 py-2 text-xs font-semibold text-stone-200 shadow-lg backdrop-blur-md hover:bg-stone-800"
            >
              <MessageSquare className="h-3.5 w-3.5 text-amber-400" />
              Chat ({chatMessages.length})
            </button>
          )}
        </div>
      </div>

      {/* Game Over / Rematch Modal */}
      {roomState.status === 'GAME_OVER' && (
        <div className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center bg-stone-950/65 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-amber-500/35 bg-stone-900/95 p-6 text-center shadow-2xl">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/40">
              <Trophy className="h-7 w-7" />
            </div>

            <h2 className="text-2xl font-extrabold text-amber-50">
              {roomState.rulesMode === 'ELIMINATION'
                ? 'LAST BUILDER STANDING!'
                : roomState.gameOverReason === 'TIMEOUT'
                  ? "TIME'S UP!"
                  : roomState.gameOverReason === 'PLAYER_DISCONNECTED'
                    ? 'MATCH FORFEITED'
                    : 'TIMBER!'}
            </h2>

            <p className="mt-1 text-sm text-stone-300">
              {winner
                ? roomState.rulesMode === 'ELIMINATION'
                  ? `${winner.name} survived Elimination Tower!`
                  : `${winner.name} wins the round!`
                : loser
                  ? `${loser.name} toppled the tower after ${roomState.blocksMovedCount} moves.`
                  : 'The tower collapsed!'}
            </p>
            {winner && loser && (
              <p className="mt-0.5 text-xs text-stone-400">
                {loser.name}{' '}
                {roomState.gameOverReason === 'TIMEOUT'
                  ? 'ran out of time.'
                  : roomState.gameOverReason === 'PLAYER_DISCONNECTED'
                    ? 'disconnected.'
                    : 'knocked over the tower.'}
              </p>
            )}

            <div className="mt-5 grid grid-cols-2 gap-2 text-left">
              {roomState.players.map((p) => (
                <div
                  key={p.id}
                  className={`rounded-xl border px-3 py-2 ${
                    p.id === winner?.id
                      ? 'border-emerald-500/50 bg-emerald-950/40'
                      : 'border-stone-800 bg-stone-950/60'
                  }`}
                >
                  <div className="text-xs font-semibold text-stone-200">{p.name}</div>
                  <div className="mt-0.5 text-[11px] text-amber-300">
                    {p.score} blocks stacked
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={onExitToLobby}
                className="flex-1 rounded-xl border border-stone-700 bg-stone-800 px-4 py-2.5 text-sm font-semibold text-stone-200 transition hover:bg-stone-700"
              >
                Lobby
              </button>
              <button
                onClick={onRematch}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2.5 text-sm font-bold text-stone-950 shadow-lg shadow-amber-500/20 transition hover:brightness-110"
              >
                <RotateCcw className="h-4 w-4" />
                Rematch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
