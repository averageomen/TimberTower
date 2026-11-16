import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Crown,
  Gamepad2,
  Link2,
  Play,
  Plus,
  Server,
  Sparkles,
  Trash2,
  Users,
  Wifi,
} from 'lucide-react';
import { RoomState } from '../types';

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback for non-HTTPS or restricted webviews
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return copied;
}

interface LobbyProps {
  roomState: RoomState | null;
  mySocketId: string | null;
  connected: boolean;
  serverUrl: string;
  initialRoomCode: string;
  errorMessage: string | null;
  onUpdateServerUrl: (url: string) => void;
  onCreateOnlineRoom: (playerName: string) => void;
  onJoinOnlineRoom: (roomId: string, playerName: string) => void;
  onStartOnlineGame: () => void;
  onStartLocalGame: (playerNames: string[]) => void;
  onLeaveOnlineRoom: () => void;
  onClearError: () => void;
}

export function Lobby({
  roomState,
  mySocketId,
  connected,
  serverUrl,
  initialRoomCode,
  errorMessage,
  onUpdateServerUrl,
  onCreateOnlineRoom,
  onJoinOnlineRoom,
  onStartOnlineGame,
  onStartLocalGame,
  onLeaveOnlineRoom,
  onClearError,
}: LobbyProps) {
  const [tab, setTab] = useState<'ONLINE' | 'LOCAL'>('ONLINE');
  const [playerName, setPlayerName] = useState('Builder');
  const [joinCode, setJoinCode] = useState(initialRoomCode);
  const [serverDraft, setServerDraft] = useState(serverUrl);
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [localPlayers, setLocalPlayers] = useState<string[]>(['Player 1', 'Player 2']);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [copyFallbackHint, setCopyFallbackHint] = useState(false);
  const inviteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setServerDraft(serverUrl);
  }, [serverUrl]);

  const isHost = Boolean(
    roomState && mySocketId && roomState.players.find((p) => p.id === mySocketId)?.isHost
  );

  const isWebHttp =
    typeof window !== 'undefined' && window.location.protocol.startsWith('http');

  const inviteUrl = roomState
    ? isWebHttp
      ? `${window.location.origin}${window.location.pathname}?room=${roomState.roomId}`
      : roomState.roomId
    : '';

  const handleCopyInvite = async () => {
    if (!inviteUrl) return;
    const ok = await copyToClipboard(inviteUrl);
    if (ok) {
      setCopyFallbackHint(false);
      setCopiedInvite(true);
      window.setTimeout(() => setCopiedInvite(false), 2000);
    } else {
      inviteInputRef.current?.focus();
      inviteInputRef.current?.select();
      setCopyFallbackHint(true);
      window.setTimeout(() => setCopyFallbackHint(false), 3000);
    }
  };

  const handleAddLocalPlayer = () => {
    if (localPlayers.length >= 4) return;
    setLocalPlayers([...localPlayers, `Player ${localPlayers.length + 1}`]);
  };

  const handleRemoveLocalPlayer = (index: number) => {
    if (localPlayers.length <= 1) return;
    setLocalPlayers(localPlayers.filter((_, i) => i !== index));
  };

  return (
    <div className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center bg-stone-950/65 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-amber-500/25 bg-stone-900/95 shadow-2xl shadow-black/70">
        {/* Header */}
        <div className="border-b border-stone-800 bg-gradient-to-r from-amber-950/60 via-stone-900 to-stone-900 px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/30">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-amber-50">
                  TIMBER STACK
                </h1>
                <p className="text-xs text-amber-200/70">
                  3D Physics Multiplayer Jenga
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowServerConfig((v) => !v)}
              title="Configure backend server URL"
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition hover:brightness-110 ${
                connected
                  ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
                  : 'bg-stone-800 text-stone-400 ring-1 ring-stone-700'
              }`}
            >
              <Wifi className="h-3 w-3" />
              {connected ? 'Server Online' : 'Connecting...'}
            </button>
          </div>
        </div>

        <div className="p-6">
          {(showServerConfig || (!connected && tab === 'ONLINE' && !roomState)) && (
            <div className="mb-4 rounded-xl border border-stone-700/80 bg-stone-950/75 p-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                <span className="flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5 text-amber-400" />
                  Backend Server URL (NAS / Docker)
                </span>
                <span className="font-mono text-[10px] text-stone-500">
                  {connected ? 'Connected' : 'Offline'}
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={serverDraft}
                  onChange={(e) => setServerDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && serverDraft.trim()) {
                      onUpdateServerUrl(serverDraft);
                    }
                  }}
                  placeholder="http://100.x.y.z:3001"
                  className="flex-1 rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 font-mono text-xs text-stone-100 outline-none focus:border-amber-400"
                />
                <button
                  type="button"
                  onClick={() => onUpdateServerUrl(serverDraft)}
                  className="rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-200 ring-1 ring-amber-400/40 transition hover:bg-amber-500/30"
                >
                  Connect
                </button>
              </div>
              {!connected && (
                <div className="mt-2 flex items-center justify-between text-[11px] text-stone-400">
                  <span>Playing over Tailscale? Make sure Tailscale is running.</span>
                  <a
                    href="https://tailscale.com/download"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-amber-300 underline decoration-amber-400/40 hover:text-amber-200"
                  >
                    Get Tailscale
                  </a>
                </div>
              )}
            </div>
          )}

          {errorMessage && (
            <div className="mb-4 flex items-center justify-between rounded-xl border border-red-500/40 bg-red-950/70 px-3.5 py-2.5 text-xs text-red-200">
              <span>{errorMessage}</span>
              <button
                onClick={onClearError}
                className="ml-3 rounded px-1.5 py-0.5 text-red-300 hover:bg-red-900/60"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Waiting Room View once inside an online room */}
          {roomState && roomState.status === 'WAITING' ? (
            <div className="space-y-5">
              <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-950/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-300/80">
                      Room Code
                    </div>
                    <div className="mt-0.5 font-mono text-2xl font-bold tracking-[0.2em] text-amber-100">
                      {roomState.roomId}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyInvite}
                    className="flex items-center gap-2 rounded-xl bg-amber-500/20 px-3.5 py-2.5 text-xs font-semibold text-amber-200 ring-1 ring-amber-400/40 transition hover:bg-amber-500/30"
                  >
                    {copiedInvite ? (
                      <>
                        <Check className="h-4 w-4 text-emerald-300" />
                        Copied Invite Link!
                      </>
                    ) : (
                      <>
                        <Link2 className="h-4 w-4" />
                        Copy Invite Link
                      </>
                    )}
                  </button>
                </div>

                <div className="space-y-1">
                  <input
                    ref={inviteInputRef}
                    type="text"
                    readOnly
                    value={inviteUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Room invite link"
                    className="w-full rounded-lg border border-amber-500/20 bg-stone-950/80 px-3 py-1.5 font-mono text-xs text-amber-100/90 outline-none focus:border-amber-400"
                  />
                  {!isWebHttp && (
                    <div className="text-[11px] text-amber-200/75">
                      Server: <span className="font-mono">{serverUrl}</span>
                    </div>
                  )}
                  {copyFallbackHint && (
                    <div className="text-[11px] text-amber-300">
                      Clipboard access blocked — link selected above, press Ctrl+C to copy.
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-stone-400">
                  <span>Players at the Table ({roomState.players.length}/6)</span>
                </div>
                <div className="space-y-2">
                  {roomState.players.map((player) => (
                    <div
                      key={player.id}
                      className="flex items-center justify-between rounded-xl border border-stone-800 bg-stone-950/60 px-3.5 py-2.5"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-500/15 text-xs font-bold text-amber-300">
                          {player.name.slice(0, 1).toUpperCase()}
                        </div>
                        <span className="text-sm font-medium text-stone-100">
                          {player.name}
                          {player.id === mySocketId && (
                            <span className="ml-2 text-xs text-amber-300/80">(You)</span>
                          )}
                        </span>
                      </div>
                      {player.isHost && (
                        <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300">
                          <Crown className="h-3 w-3" />
                          Host
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={onLeaveOnlineRoom}
                  className="rounded-xl border border-stone-700 bg-stone-800/80 px-4 py-2.5 text-sm font-medium text-stone-300 transition hover:bg-stone-800"
                >
                  Leave
                </button>
                {isHost ? (
                  <button
                    onClick={onStartOnlineGame}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2.5 text-sm font-bold text-stone-950 shadow-lg shadow-amber-500/20 transition hover:brightness-110"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    {roomState.players.length >= 2
                      ? 'Start Match'
                      : 'Start Solo / Waiting Match'}
                  </button>
                ) : (
                  <div className="flex-1 rounded-xl border border-stone-800 bg-stone-950/60 px-4 py-2.5 text-center text-sm text-stone-400">
                    Waiting for host to start...
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* Mode Tabs */
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-stone-950/80 p-1 ring-1 ring-stone-800">
                <button
                  onClick={() => setTab('ONLINE')}
                  className={`flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-semibold transition ${
                    tab === 'ONLINE'
                      ? 'bg-amber-500 text-stone-950 shadow'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  <Users className="h-4 w-4" />
                  Online Multiplayer
                </button>
                <button
                  onClick={() => setTab('LOCAL')}
                  className={`flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-semibold transition ${
                    tab === 'LOCAL'
                      ? 'bg-amber-500 text-stone-950 shadow'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  <Gamepad2 className="h-4 w-4" />
                  Local Solo / Pass &amp; Play
                </button>
              </div>

              {tab === 'ONLINE' ? (
                <div className="space-y-4">
                  {initialRoomCode && (
                    <div className="flex items-center justify-between rounded-xl border border-amber-500/35 bg-amber-950/40 px-3.5 py-2 text-xs text-amber-200">
                      <span>
                        Invited to Room{' '}
                        <span className="font-mono font-bold tracking-wider text-amber-100">
                          {initialRoomCode}
                        </span>
                      </span>
                      <span className="text-[11px] text-amber-300/80">
                        Enter your name and click Join Room
                      </span>
                    </div>
                  )}

                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-stone-400">
                      Your Display Name
                    </label>
                    <input
                      type="text"
                      maxLength={20}
                      value={playerName}
                      onChange={(e) => setPlayerName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && joinCode.trim().length >= 4) {
                          onJoinOnlineRoom(joinCode, playerName);
                        }
                      }}
                      placeholder="Enter your name"
                      className="w-full rounded-xl border border-stone-700 bg-stone-950/80 px-3.5 py-2.5 text-sm text-stone-100 outline-none transition focus:border-amber-400"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => onCreateOnlineRoom(playerName)}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-3 text-sm font-bold text-stone-950 shadow-lg shadow-amber-500/20 transition hover:brightness-110"
                  >
                    <Copy className="h-4 w-4" />
                    Create New Room
                  </button>

                  <div className="relative flex items-center py-1">
                    <div className="flex-grow border-t border-stone-800" />
                    <span className="mx-3 text-[11px] font-medium uppercase tracking-wider text-stone-500">
                      or join with code
                    </span>
                    <div className="flex-grow border-t border-stone-800" />
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={joinCode}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const match = raw.match(/[?&]room=([A-Za-z0-9]{4,8})/i);
                        const extracted = match ? match[1] : raw;
                        setJoinCode(extracted.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && joinCode.trim().length >= 4) {
                          onJoinOnlineRoom(joinCode, playerName);
                        }
                      }}
                      placeholder="JNG42X"
                      className="w-36 rounded-xl border border-stone-700 bg-stone-950/80 px-3.5 py-2.5 text-center font-mono text-sm font-bold uppercase tracking-widest text-amber-200 outline-none transition focus:border-amber-400"
                    />
                    <button
                      type="button"
                      onClick={() => onJoinOnlineRoom(joinCode, playerName)}
                      disabled={joinCode.trim().length < 4}
                      className="flex-1 rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Join Room
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-stone-400">
                      Local Players ({localPlayers.length}/4)
                    </span>
                    <button
                      onClick={handleAddLocalPlayer}
                      disabled={localPlayers.length >= 4}
                      className="flex items-center gap-1 rounded-lg bg-stone-800 px-2.5 py-1 text-xs font-medium text-amber-300 transition hover:bg-stone-700 disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add Player
                    </button>
                  </div>

                  <div className="space-y-2">
                    {localPlayers.map((name, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="text"
                          maxLength={20}
                          value={name}
                          onChange={(e) => {
                            const updated = [...localPlayers];
                            updated[idx] = e.target.value;
                            setLocalPlayers(updated);
                          }}
                          className="flex-1 rounded-xl border border-stone-700 bg-stone-950/80 px-3.5 py-2 text-sm text-stone-100 outline-none focus:border-amber-400"
                        />
                        {localPlayers.length > 1 && (
                          <button
                            onClick={() => handleRemoveLocalPlayer(idx)}
                            className="rounded-xl border border-stone-800 bg-stone-950 p-2 text-stone-400 hover:text-red-300"
                            title="Remove player"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={() =>
                      onStartLocalGame(
                        localPlayers.map((n, i) => n.trim() || `Player ${i + 1}`)
                      )
                    }
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-3 text-sm font-bold text-stone-950 shadow-lg shadow-amber-500/20 transition hover:brightness-110"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    {localPlayers.length === 1 ? 'Start Solo Practice' : 'Start Pass-and-Play'}
                  </button>
                </div>
              )}

              {/* Quick Controls Guide */}
              <div className="rounded-xl border border-stone-800/90 bg-stone-950/55 px-4 py-3 text-xs text-stone-400">
                <span className="font-semibold text-amber-200/90">How to Play:</span> Drag any
                block below the top layer out along its length, lift it onto a glowing top slot,
                and hold steady for 3 seconds. Drag empty space to orbit the camera.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
