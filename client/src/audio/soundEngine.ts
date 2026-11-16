export type MusicTrack = 'MENU' | 'WAITING' | 'GAME' | 'NONE';

type SoundKey =
  | 'wood_tap'
  | 'wood_place'
  | 'wood_slide'
  | 'lego_break'
  | 'crash'
  | 'explosion'
  | 'turn_chime'
  | 'tick';

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
  private buffers = new Map<SoundKey, AudioBuffer>();
  private loadingPromise: Promise<void> | null = null;

  private slideSource: AudioBufferSourceNode | null = null;
  private slideGain: GainNode | null = null;

  private currentTrack: MusicTrack = 'NONE';
  private musicElements = new Map<Exclude<MusicTrack, 'NONE'>, HTMLAudioElement>();

  private lastImpactAt = 0;
  private lastHoverAt = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      const onFirstGesture = () => {
        this.unlock();
      };
      window.addEventListener('pointerdown', onFirstGesture, { once: true });
      window.addEventListener('keydown', onFirstGesture, { once: true });
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

  public updateSlide(speed: number): void {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    this.ensureSlideLoop(ctx);
    if (!this.slideGain || !this.slideSource) return;

    const clamped = Math.min(Math.max(speed, 0), 10);
    const activeGain = clamped > 0.12 ? Math.min(0.32, clamped * 0.055) : 0;
    const now = ctx.currentTime;

    this.slideGain.gain.setTargetAtTime(activeGain, now, 0.04);
    this.slideSource.playbackRate.setTargetAtTime(0.85 + clamped * 0.08, now, 0.05);
  }

  public stopSlide(): void {
    if (!this.ctx || !this.slideGain) return;
    this.slideGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
  }

  public playHover(legal = true): void {
    const nowMs = performance.now();
    if (nowMs - this.lastHoverAt < 75) return;
    this.lastHoverAt = nowMs;
    this.playBuffer('wood_tap', legal ? 0.18 : 0.12, legal ? 1.35 : 0.72, 0, 0.12);
  }

  public playSelect(): void {
    this.playBuffer('wood_tap', 0.42, 1.05, 0, 0.25);
  }

  public playPlace(): void {
    this.playBuffer('wood_place', 0.55, 1.0, 0, 0.42);
  }

  public playImpact(intensity = 0.5): void {
    const nowMs = performance.now();
    if (nowMs - this.lastImpactAt < 45) return;
    this.lastImpactAt = nowMs;

    const clamped = Math.min(Math.max(intensity, 0.12), 1);
    const rate = 0.88 + Math.random() * 0.28;
    this.playBuffer('wood_tap', clamped * 0.6, rate, 0, 0.25);
  }

  public playCollapse(): void {
    this.stopSlide();
    this.playBuffer('lego_break', 0.95, 1.0);
  }

  public playExplosion(): void {
    this.stopSlide();
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
