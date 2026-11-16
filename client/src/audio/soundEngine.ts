type SoundKey =
  | 'wood_tap'
  | 'wood_place'
  | 'wood_slide'
  | 'tower_collapse'
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
  tower_collapse: {
    local: './sounds/tower_collapse.ogg',
    remote: 'https://actions.google.com/sounds/v1/sports/bowling_strike.ogg',
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

class SoundEngine {
  private ctx: AudioContext | null = null;
  private muted = false;
  private buffers = new Map<SoundKey, AudioBuffer>();
  private loadingPromise: Promise<void> | null = null;

  private slideSource: AudioBufferSourceNode | null = null;
  private slideGain: GainNode | null = null;

  private lastImpactAt = 0;
  private lastHoverAt = 0;

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

  public unlock(): void {
    this.ensureContext();
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted && this.slideGain && this.ctx) {
      this.slideGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
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
    this.playBuffer('tower_collapse', 0.85, 0.95);
    this.playBuffer('crash', 0.65, 1.0, 0.12);
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
