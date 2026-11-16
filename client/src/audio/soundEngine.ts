export type MusicTrack = 'MENU' | 'WAITING' | 'GAME' | 'NONE';

export type GlobalSoundEvent =
  | { type: 'SELECT' }
  | { type: 'PLACE' }
  | { type: 'IMPACT'; intensity: number }
  | { type: 'SLIDE'; speed: number }
  | { type: 'STOP_SLIDE' }
  | { type: 'COLLAPSE' }
  | { type: 'EXPLOSION' };

type SoundKey =
  | 'wood_tap'
  | 'wood_place'
  | 'wood_slide'
  | 'lego_break'
  | 'crash'
  | 'explosion'
  | 'turn_chime'
  | 'tick'
  | 'emote_fire'
  | 'emote_clap'
  | 'emote_shock'
  | 'emote_wood'
  | 'emote_laugh'
  | 'emote_boom';

const SOUND_SOURCES: Record<SoundKey, { local: string; remote: string }> = {
  wood_tap: {
    local: './sounds/wood_tap.ogg',
    remote: 'https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg',
  },
  wood_place: {
    local: './sounds/wood_place.ogg',
    remote: 'https://actions.google.com/sounds/v1/doors/knock_on_wooden_door.ogg',
  },
  wood_slide: {
    local: './sounds/wood_slide.ogg',
    remote: 'https://actions.google.com/sounds/v1/doors/wood_door_open.ogg',
  },
  lego_break: {
    local: './sounds/lego_break.mp3',
    remote: 'https://www.myinstants.com/media/sounds/lego-breaking.mp3',
  },
  crash: {
    local: './sounds/crash.ogg',
    remote: 'https://actions.google.com/sounds/v1/impacts/crash.ogg',
  },
  explosion: {
    local: './sounds/explosion.ogg',
    remote: 'https://actions.google.com/sounds/v1/weapons/big_explosion_cut_off.ogg',
  },
  turn_chime: {
    local: './sounds/turn_chime.ogg',
    remote: 'https://actions.google.com/sounds/v1/cartoon/pop.ogg',
  },
  tick: {
    local: './sounds/tick.ogg',
    remote: 'https://actions.google.com/sounds/v1/alarms/beep_short.ogg',
  },
  emote_fire: {
    local: './sounds/emote_fire.mp3',
    remote: 'https://www.myinstants.com/media/sounds/faaah.mp3',
  },
  emote_clap: {
    local: './sounds/emote_clap.mp3',
    remote: 'https://www.myinstants.com/media/sounds/claps-with-cheers-audience.mp3',
  },
  emote_shock: {
    local: './sounds/emote_shock.mp3',
    remote: 'https://www.myinstants.com/media/sounds/huh-cat-meme.mp3',
  },
  emote_wood: {
    local: './sounds/emote_wood.mp3',
    remote: 'https://www.myinstants.com/media/sounds/bonk_7zPAD7C.mp3',
  },
  emote_laugh: {
    local: './sounds/emote_laugh.mp3',
    remote: 'https://www.myinstants.com/media/sounds/cat-laugh-meme-1.mp3',
  },
  emote_boom: {
    local: './sounds/emote_boom.mp3',
    remote: 'https://www.myinstants.com/media/sounds/vine-boom-sound-meme.mp3',
  },
};

const EMOTE_SOUND_MAP: Record<string, SoundKey> = {
  '🔥': 'emote_fire',
  '👏': 'emote_clap',
  '😱': 'emote_shock',
  '🪵': 'emote_wood',
  '😂': 'emote_laugh',
  '💥': 'emote_boom',
};

const MUSIC_SOURCES: Record<Exclude<MusicTrack, 'NONE'>, { local: string; remote: string }> = {
  MENU: {
    local: './sounds/jazz_menu.mp3',
    remote: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Lobby%20Time.mp3',
  },
  WAITING: {
    local: './sounds/jazz_waiting.mp3',
    remote: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Jazz%20Brunch.mp3',
  },
  GAME: {
    local: './sounds/jazz_game.mp3',
    remote: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Bossa%20Antigua.mp3',
  },
};

const MUSIC_VOLUME = 0.22;

class SoundEngine {
  private ctx: AudioContext | null = null;
  private muted = false;
  private emoteSoundsMuted = false;
  private buffers = new Map<SoundKey, AudioBuffer>();
  private loadingPromise: Promise<void> | null = null;

  private slideSource: AudioBufferSourceNode | null = null;
  private slideGain: GainNode | null = null;

  private currentTrack: MusicTrack = 'NONE';
  private musicElements = new Map<Exclude<MusicTrack, 'NONE'>, HTMLAudioElement>();

  private broadcaster: ((event: GlobalSoundEvent) => void) | null = null;
  private slideStopTimeout: number | null = null;

  private lastImpactAt = 0;
  private lastImpactBroadcastAt = 0;
  private lastHoverAt = 0;
  private lastPlaceAt = 0;
  private lastSlideBroadcastAt = 0;
  private lastCollapseAt = 0;
  private lastExplosionAt = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      const onFirstGesture = () => {
        this.unlock();
      };
      window.addEventListener('pointerdown', onFirstGesture, { once: true });
      window.addEventListener('keydown', onFirstGesture, { once: true });
    }
  }

  public setBroadcaster(fn: ((event: GlobalSoundEvent) => void) | null): void {
    this.broadcaster = fn;
  }

  public playRemoteEvent(event: GlobalSoundEvent): void {
    switch (event.type) {
      case 'SELECT':
        this.playSelect(false);
        break;
      case 'PLACE':
        this.playPlace(false);
        break;
      case 'IMPACT':
        this.playImpact(event.intensity, false);
        break;
      case 'SLIDE':
        this.updateSlide(event.speed, false);
        break;
      case 'STOP_SLIDE':
        this.stopSlide(false);
        break;
      case 'COLLAPSE':
        this.playCollapse(false);
        break;
      case 'EXPLOSION':
        this.playExplosion(false);
        break;
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.muted || typeof window === 'undefined') return null;

    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }

    if (!this.loadingPromise) {
      this.loadingPromise = this.preloadAll(this.ctx);
    }

    return this.ctx;
  }

  private async fetchAndDecode(
    ctx: AudioContext,
    url: string
  ): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const arr = await res.arrayBuffer();
      return await ctx.decodeAudioData(arr);
    } catch {
      return null;
    }
  }

  private async preloadAll(ctx: AudioContext): Promise<void> {
    const keys = Object.keys(SOUND_SOURCES) as SoundKey[];
    await Promise.all(
      keys.map(async (key) => {
        const entry = SOUND_SOURCES[key];
        const decoded =
          (await this.fetchAndDecode(ctx, entry.local)) ??
          (await this.fetchAndDecode(ctx, entry.remote));
        if (decoded) {
          this.buffers.set(key, decoded);
        }
      })
    );
    this.ensureSlideLoop(ctx);
  }

  private ensureSlideLoop(ctx: AudioContext): void {
    if (this.slideSource || this.slideGain) return;
    const buffer = this.buffers.get('wood_slide');
    if (!buffer) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start();

    this.slideSource = source;
    this.slideGain = gain;
  }

  private playBuffer(
    key: SoundKey,
    volume = 0.7,
    playbackRate = 1,
    delaySec = 0,
    maxDurationSec?: number
  ): void {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const buffer = this.buffers.get(key);
    if (!buffer) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;

    const gain = ctx.createGain();
    const startAt = ctx.currentTime + delaySec;
    gain.gain.setValueAtTime(volume, startAt);

    if (maxDurationSec && maxDurationSec < buffer.duration) {
      gain.gain.setValueAtTime(volume, startAt + Math.max(0.05, maxDurationSec - 0.08));
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + maxDurationSec);
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(startAt, 0, maxDurationSec + 0.02);
    } else {
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(startAt);
    }
  }

  private getOrCreateMusicElement(
    track: Exclude<MusicTrack, 'NONE'>
  ): HTMLAudioElement | null {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;

    let audio = this.musicElements.get(track);
    if (!audio) {
      const source = MUSIC_SOURCES[track];
      audio = new Audio(source.local);
      audio.loop = true;
      audio.preload = 'auto';
      audio.volume = MUSIC_VOLUME;

      let triedRemote = false;
      audio.addEventListener('error', () => {
        if (triedRemote) return;
        triedRemote = true;
        audio!.src = source.remote;
        audio!.load();
        if (this.currentTrack === track && !this.muted) {
          void audio!.play().catch(() => {});
        }
      });

      this.musicElements.set(track, audio);
    }
    return audio;
  }

  private startCurrentMusic(resetTime = false): void {
    if (this.muted || this.currentTrack === 'NONE') return;
    const audio = this.getOrCreateMusicElement(this.currentTrack);
    if (!audio) return;

    if (resetTime) {
      try {
        audio.currentTime = 0;
      } catch {
        // Ignore if audio metadata is not ready yet
      }
    }

    if (audio.paused) {
      void audio.play().catch(() => {});
    }
  }

  public setMusicTrack(track: MusicTrack): void {
    const changed = this.currentTrack !== track;
    this.currentTrack = track;

    for (const [key, audio] of this.musicElements.entries()) {
      if (key !== track && !audio.paused) {
        audio.pause();
      }
    }

    if (track === 'NONE' || this.muted) {
      return;
    }

    this.startCurrentMusic(changed);
  }

  public unlock(): void {
    this.ensureContext();
    this.startCurrentMusic(false);
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      if (this.slideGain && this.ctx) {
        this.slideGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
      }
      for (const audio of this.musicElements.values()) {
        if (!audio.paused) {
          audio.pause();
        }
      }
    } else {
      this.ensureContext();
      this.startCurrentMusic(false);
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setEmoteSoundsMuted(muted: boolean): void {
    this.emoteSoundsMuted = muted;
  }

  public isEmoteSoundsMuted(): boolean {
    return this.emoteSoundsMuted;
  }

  public playEmote(emoji: string): void {
    if (this.muted || this.emoteSoundsMuted) return;
    const key = EMOTE_SOUND_MAP[emoji];
    if (!key) return;
    this.playBuffer(key, 0.72, 1.0);
  }

  public updateSlide(speed: number, broadcast = true): void {
    const clamped = Math.min(Math.max(speed, 0), 10);
    const nowMs = performance.now();

    if (broadcast && this.broadcaster && nowMs - this.lastSlideBroadcastAt >= 80) {
      this.lastSlideBroadcastAt = nowMs;
      this.broadcaster({ type: 'SLIDE', speed: clamped });
    }

    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    this.ensureSlideLoop(ctx);
    if (!this.slideGain || !this.slideSource) return;

    if (this.slideStopTimeout !== null) {
      window.clearTimeout(this.slideStopTimeout);
      this.slideStopTimeout = null;
    }

    if (!broadcast && clamped > 0.12) {
      this.slideStopTimeout = window.setTimeout(() => {
        this.slideStopTimeout = null;
        this.stopSlide(false);
      }, 220);
    }

    const activeGain = clamped > 0.12 ? Math.min(0.32, clamped * 0.055) : 0;
    const now = ctx.currentTime;

    this.slideGain.gain.setTargetAtTime(activeGain, now, 0.04);
    this.slideSource.playbackRate.setTargetAtTime(0.85 + clamped * 0.08, now, 0.05);
  }

  public stopSlide(broadcast = true): void {
    if (this.slideStopTimeout !== null) {
      window.clearTimeout(this.slideStopTimeout);
      this.slideStopTimeout = null;
    }
    if (broadcast && this.broadcaster) {
      this.broadcaster({ type: 'STOP_SLIDE' });
    }
    if (!this.ctx || !this.slideGain) return;
    this.slideGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
  }

  public playHover(legal = true): void {
    const nowMs = performance.now();
    if (nowMs - this.lastHoverAt < 75) return;
    this.lastHoverAt = nowMs;
    this.playBuffer('wood_tap', legal ? 0.18 : 0.12, legal ? 1.35 : 0.72, 0, 0.12);
  }

  public playSelect(broadcast = true): void {
    if (broadcast && this.broadcaster) {
      this.broadcaster({ type: 'SELECT' });
    }
    this.playBuffer('wood_tap', 0.42, 1.05, 0, 0.25);
  }

  public playPlace(broadcast = true): void {
    const nowMs = performance.now();
    if (nowMs - this.lastPlaceAt < 250) return;
    this.lastPlaceAt = nowMs;

    if (broadcast && this.broadcaster) {
      this.broadcaster({ type: 'PLACE' });
    }
    this.playBuffer('wood_place', 0.55, 1.0, 0, 0.42);
  }

  public playImpact(intensity = 0.5, broadcast = true): void {
    const nowMs = performance.now();
    if (nowMs - this.lastImpactAt < 45) return;
    this.lastImpactAt = nowMs;

    const clamped = Math.min(Math.max(intensity, 0.12), 1);
    if (broadcast && this.broadcaster && nowMs - this.lastImpactBroadcastAt >= 90) {
      this.lastImpactBroadcastAt = nowMs;
      this.broadcaster({ type: 'IMPACT', intensity: clamped });
    }

    const rate = 0.88 + Math.random() * 0.28;
    this.playBuffer('wood_tap', clamped * 0.6, rate, 0, 0.25);
  }

  public playCollapse(broadcast = true): void {
    const nowMs = performance.now();
    if (nowMs - this.lastCollapseAt < 1500) return;
    this.lastCollapseAt = nowMs;

    this.stopSlide(false);
    if (broadcast && this.broadcaster) {
      this.broadcaster({ type: 'COLLAPSE' });
    }
    this.playBuffer('lego_break', 0.95, 1.0);
  }

  public playExplosion(broadcast = true): void {
    const nowMs = performance.now();
    if (nowMs - this.lastExplosionAt < 1200) return;
    this.lastExplosionAt = nowMs;

    this.stopSlide(false);
    if (broadcast && this.broadcaster) {
      this.broadcaster({ type: 'EXPLOSION' });
    }
    this.playBuffer('explosion', 0.95, 1.0);
    this.playBuffer('crash', 0.75, 0.92, 0.08);
  }

  public playTurnChime(): void {
    this.playBuffer('turn_chime', 0.35, 1.05);
  }

  public playCountdownTick(): void {
    this.playBuffer('tick', 0.28, 1.1, 0, 0.18);
  }
}

export const soundEngine = new SoundEngine();
