import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpCircle,
  Check,
  Copy,
  Crown,
  Download,
  Flame,
  Gamepad2,
  Link2,
  Play,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  Users,
  Volume2,
  VolumeX,
  Wifi,
} from 'lucide-react';
import { SupabaseConfig } from '../network/supabaseClient';
import { GameRulesMode, RoomState } from '../types';
import {
  APP_VERSION,
  AppUpdateInfo,
  checkForAppUpdate,
  getCurrentAppVersion,
  startAppSelfUpdate,
  subscribeUpdateEvents,
} from '../utils/updater';

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
  supabaseConfig: SupabaseConfig;
  initialRoomCode: string;
  errorMessage: string | null;
  muted: boolean;
  onToggleMute: () => void;
  onSaveSupabaseConfig: (url: string, anonKey: string) => void;
  onSetOnlineRulesMode: (rulesMode: GameRulesMode) => void;
  onCreateOnlineRoom: (playerName: string) => void;
  onJoinOnlineRoom: (roomId: string, playerName: string) => void;
  onStartOnlineGame: () => void;
  onStartLocalGame: (playerNames: string[], rulesMode: GameRulesMode) => void;
  onLeaveOnlineRoom: () => void;
  onClearError: () => void;
}

export function Lobby({
  roomState,
  mySocketId,
  connected,
  supabaseConfig,
  initialRoomCode,
  errorMessage,
  muted,
  onToggleMute,
  onSaveSupabaseConfig,
  onSetOnlineRulesMode,
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
  const [urlDraft, setUrlDraft] = useState(supabaseConfig.url);
  const [keyDraft, setKeyDraft] = useState(supabaseConfig.anonKey);
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [localRulesMode, setLocalRulesMode] = useState<GameRulesMode>('CLASSIC');
  const [localPlayers, setLocalPlayers] = useState<string[]>(['Player 1', 'Player 2']);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [copyFallbackHint, setCopyFallbackHint] = useState(false);
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  const [checkingUpdate, setCheckingUpdate] = useState(true);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updatingNow, setUpdatingNow] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const inviteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setUrlDraft(supabaseConfig.url);
    setKeyDraft(supabaseConfig.anonKey);
  }, [supabaseConfig.url, supabaseConfig.anonKey]);

  useEffect(() => {
    let active = true;
    void getCurrentAppVersion().then((v) => {
      if (active) setAppVersion(v);
    });
    void checkForAppUpdate().then((info) => {
      if (!active) return;
      setUpdateInfo(info);
      setCheckingUpdate(false);
    });

    const unsub = subscribeUpdateEvents(
      (pct) => {
        if (active) setUpdateProgress(pct);
      },
      (msg) => {
        if (active) {
          setUpdatingNow(false);
          setUpdateError(msg);
        }
      }
    );

    return () => {
      active = false;
      unsub();
    };
  }, []);

  const handleStartUpdate = async () => {
    if (!updateInfo?.downloadUrl) return;
    setUpdateError(null);
    setUpdatingNow(true);
    setUpdateProgress(0);
    try {
      await startAppSelfUpdate(updateInfo.downloadUrl);
    } catch (err) {
      setUpdatingNow(false);
      setUpdateError(err instanceof Error ? err.message : 'Update failed.');
    }
  };

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
    if (localPlayers.length >= 6) return;
    setLocalPlayers([...localPlayers, `Player ${localPlayers.length + 1}`]);
  };

  const handleSelectLocalRulesMode = (nextMode: GameRulesMode) => {
    setLocalRulesMode(nextMode);
    if (nextMode === 'ELIMINATION' && localPlayers.length < 3) {
      const next = [...localPlayers];
      while (next.length < 3) {
        next.push(`Player ${next.length + 1}`);
      }
      setLocalPlayers(next);
    }
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
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold tracking-tight text-amber-50">
                    TIMBER STACK
                  </h1>
                  <span className="rounded-md bg-stone-800 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-300/90">
                    v{appVersion}
                  </span>
                </div>
                <p className="text-xs text-amber-200/70">
                  3D Physics Multiplayer Jenga
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onToggleMute}
                title={muted ? 'Unmute music & sound effects' : 'Mute music & sound effects'}
                aria-label={muted ? 'Unmute audio' : 'Mute audio'}
                className={`flex h-7 w-7 items-center justify-center rounded-full border transition hover:brightness-110 ${
                  muted
                    ? 'border-red-500/40 bg-red-950/50 text-red-300'
                    : 'border-stone-700 bg-stone-800/80 text-amber-200'
                }`}
              >
                {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => setShowServerConfig((v) => !v)}
                title="Configure Supabase connection"
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition hover:brightness-110 ${
                  connected
                    ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
                    : 'bg-stone-800 text-stone-400 ring-1 ring-stone-700'
                }`}
              >
                <Wifi className="h-3 w-3" />
                {connected
                  ? 'Supabase Online'
                  : supabaseConfig.isConfigured
                    ? 'Connecting...'
                    : 'Setup Supabase'}
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          {updateInfo?.updateAvailable ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-amber-400/40 bg-gradient-to-br from-amber-950/60 to-stone-950/90 p-5 text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/40">
                  <ArrowUpCircle className="h-6 w-6" />
                </div>
                <h2 className="text-lg font-bold text-amber-50">
                  New Update Available (v{updateInfo.latestVersion})
                </h2>
                <p className="mt-1 text-xs text-stone-300">
                  Installed: <span className="font-mono text-stone-400">v{updateInfo.currentVersion}</span>
                  {' → '}
                  Latest: <span className="font-mono font-semibold text-emerald-300">v{updateInfo.latestVersion}</span>
                </p>
                <p className="mt-2 text-xs text-amber-200/80">
                  Update to play with the newest features and stay compatible with your friends.
                </p>

                {updateError && (
                  <div className="mt-3 rounded-xl border border-red-500/40 bg-red-950/70 px-3 py-2 text-xs text-red-200">
                    {updateError}
                  </div>
                )}

                {updatingNow ? (
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between text-xs font-semibold text-amber-200">
                      <span className="flex items-center gap-1.5">
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        {updateProgress >= 100
                          ? 'Installing & restarting...'
                          : 'Downloading update...'}
                      </span>
                      <span className="font-mono">{updateProgress}%</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-stone-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-amber-400 to-emerald-400 transition-all duration-150"
                        style={{ width: `${updateProgress}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleStartUpdate}
                    className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-400 to-amber-400 px-5 py-3 text-sm font-bold text-stone-950 shadow-lg shadow-emerald-500/20 transition hover:brightness-110"
                  >
                    <Download className="h-4 w-4" />
                    Update to v{updateInfo.latestVersion}
                  </button>
                )}
              </div>
            </div>
          ) : checkingUpdate ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <RefreshCw className="h-7 w-7 animate-spin text-amber-400" />
              <div className="mt-3 text-sm font-semibold text-stone-200">
                Checking for updates...
              </div>
              <div className="mt-1 text-xs text-stone-400">
                Installed version v{appVersion}
              </div>
            </div>
          ) : (
            <>
          {(showServerConfig || (!supabaseConfig.isConfigured && tab === 'ONLINE' && !roomState)) && (
            <div className="mb-4 space-y-2.5 rounded-xl border border-stone-700/80 bg-stone-950/75 p-3.5">
              <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                <span className="flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5 text-amber-400" />
                  Supabase Backend Setup
                </span>
                <span className="font-mono text-[10px] text-stone-500">
                  {connected ? 'Connected' : 'Not Connected'}
                </span>
              </div>
              <input
                type="text"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="https://your-project-ref.supabase.co"
                className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 font-mono text-xs text-stone-100 outline-none focus:border-amber-400"
              />
              <div className="flex gap-2">
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && urlDraft.trim() && keyDraft.trim()) {
                      onSaveSupabaseConfig(urlDraft, keyDraft);
                    }
                  }}
                  placeholder="Supabase Anon Public Key"
                  className="flex-1 rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 font-mono text-xs text-stone-100 outline-none focus:border-amber-400"
                />
                <button
                  type="button"
                  onClick={() => onSaveSupabaseConfig(urlDraft, keyDraft)}
                  className="rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-200 ring-1 ring-amber-400/40 transition hover:bg-amber-500/30"
                >
                  Save &amp; Connect
                </button>
              </div>
              <p className="text-[11px] text-stone-400">
                Run <span className="font-mono text-amber-300/90">supabase/schema.sql</span> in your Supabase SQL Editor first.
              </p>
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
                      Share Room Code <span className="font-mono font-semibold">{roomState.roomId}</span> with friends using this app.
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
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-400">
                  Game Mode
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={!isHost}
                    onClick={() => onSetOnlineRulesMode('CLASSIC')}
                    className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                      roomState.rulesMode === 'CLASSIC'
                        ? 'border-amber-400/70 bg-amber-500/20 text-amber-100'
                        : 'border-stone-800 bg-stone-950/60 text-stone-400 hover:text-stone-200'
                    } ${!isHost ? 'cursor-default' : ''}`}
                  >
                    <div className="font-bold">Classic Jenga</div>
                    <div className="text-[11px] opacity-75">First collapse ends round</div>
                  </button>
                  <button
                    type="button"
                    disabled={!isHost}
                    onClick={() => onSetOnlineRulesMode('ELIMINATION')}
                    className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                      roomState.rulesMode === 'ELIMINATION'
                        ? 'border-orange-400/80 bg-orange-500/20 text-orange-100'
                        : 'border-stone-800 bg-stone-950/60 text-stone-400 hover:text-stone-200'
                    } ${!isHost ? 'cursor-default' : ''}`}
                  >
                    <div className="flex items-center gap-1 font-bold">
                      <Flame className="h-3.5 w-3.5 text-orange-400" />
                      Elimination Tower
                    </div>
                    <div className="text-[11px] opacity-75">Last builder standing wins</div>
                  </button>
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
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => handleSelectLocalRulesMode('CLASSIC')}
                      className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                        localRulesMode === 'CLASSIC'
                          ? 'border-amber-400/70 bg-amber-500/20 text-amber-100'
                          : 'border-stone-800 bg-stone-950/60 text-stone-400 hover:text-stone-200'
                      }`}
                    >
                      <div className="font-bold">Classic Jenga</div>
                      <div className="text-[11px] opacity-75">First collapse ends round</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelectLocalRulesMode('ELIMINATION')}
                      className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                        localRulesMode === 'ELIMINATION'
                          ? 'border-orange-400/80 bg-orange-500/20 text-orange-100'
                          : 'border-stone-800 bg-stone-950/60 text-stone-400 hover:text-stone-200'
                      }`}
                    >
                      <div className="flex items-center gap-1 font-bold">
                        <Flame className="h-3.5 w-3.5 text-orange-400" />
                        Elimination Tower
                      </div>
                      <div className="text-[11px] opacity-75">Reset tower, eliminate 1</div>
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-stone-400">
                      Local Players ({localPlayers.length}/6)
                    </span>
                    <button
                      type="button"
                      onClick={handleAddLocalPlayer}
                      disabled={localPlayers.length >= 6}
                      className="flex items-center gap-1 rounded-lg bg-stone-800 px-2.5 py-1 text-xs font-medium text-amber-300 transition hover:bg-stone-700 disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add Player
                    </button>
                  </div>

                  <div className="max-h-40 space-y-2 overflow-y-auto pr-1 jenga-scroll">
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
                            type="button"
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
                    type="button"
                    onClick={() =>
                      onStartLocalGame(
                        localPlayers.map((n, i) => n.trim() || `Player ${i + 1}`),
                        localRulesMode
                      )
                    }
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-3 text-sm font-bold text-stone-950 shadow-lg shadow-amber-500/20 transition hover:brightness-110"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    {localRulesMode === 'ELIMINATION'
                      ? 'Start Elimination Tower'
                      : localPlayers.length === 1
                        ? 'Start Solo Practice'
                        : 'Start Pass-and-Play'}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
