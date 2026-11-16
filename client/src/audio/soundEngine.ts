class SoundEngine {
  private ctx: AudioContext | null = null;
  private muted = false;
  private noiseBuffer: AudioBuffer | null = null;

  private slideGain: GainNode | null = null;
  private slideFilter: BiquadFilterNode | null = null;
  private slideResonance: BiquadFilterNode | null = null;

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
      this.noiseBuffer = this.buildNoiseBuffer(this.ctx);
      this.setupSlideChain(this.ctx);
    }

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }

    return this.ctx;
  }

  private buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Pink-ish warm noise for realistic wood grain friction
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.18;
    }
    return buffer;
  }

  private setupSlideChain(ctx: AudioContext): void {
    if (!this.noiseBuffer) return;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 920;
    bandpass.Q.value = 2.4;

    const resonance = ctx.createBiquadFilter();
    resonance.type = 'peaking';
    resonance.frequency.value = 440;
    resonance.Q.value = 3.2;
    resonance.gain.value = 5.5;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(bandpass);
    bandpass.connect(resonance);
    resonance.connect(gain);
    gain.connect(ctx.destination);
    source.start();

    this.slideFilter = bandpass;
    this.slideResonance = resonance;
    this.slideGain = gain;
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
    if (!ctx || !this.slideGain || !this.slideFilter || !this.slideResonance) return;

    const clamped = Math.min(Math.max(speed, 0), 10);
    const active = clamped > 0.08 ? Math.min(0.24, clamped * 0.045) : 0;
    const now = ctx.currentTime;

    this.slideGain.gain.setTargetAtTime(active, now, 0.04);
    this.slideFilter.frequency.setTargetAtTime(700 + clamped * 260, now, 0.05);
    this.slideResonance.frequency.setTargetAtTime(360 + clamped * 65, now, 0.05);
  }

  public stopSlide(): void {
    if (!this.ctx || !this.slideGain) return;
    this.slideGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
  }

  public playHover(legal = true): void {
    const nowMs = performance.now();
    if (nowMs - this.lastHoverAt < 65) return;
    this.lastHoverAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(legal ? 580 : 210, now);
    osc.frequency.exponentialRampToValueAtTime(legal ? 420 : 140, now + 0.04);

    gain.gain.setValueAtTime(0.035, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  public playSelect(): void {
    this.playImpact(0.32);
  }

  public playPlace(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    this.triggerWoodClack(ctx, now, 0.45, 250, 620);
    this.triggerWoodClack(ctx, now + 0.05, 0.25, 310, 740);
  }

  public playImpact(intensity = 0.5): void {
    const nowMs = performance.now();
    if (nowMs - this.lastImpactAt < 35) return;
    this.lastImpactAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;

    const clamped = Math.min(Math.max(intensity, 0.08), 1);
    const pitchJitter = 0.9 + Math.random() * 0.24;
    this.triggerWoodClack(
      ctx,
      ctx.currentTime,
      clamped,
      340 * pitchJitter,
      860 * pitchJitter
    );
  }

  private triggerWoodClack(
    ctx: AudioContext,
    startTime: number,
    intensity: number,
    lowFreq: number,
    highFreq: number
  ): void {
    // Low hollow body resonance
    const lowOsc = ctx.createOscillator();
    const lowGain = ctx.createGain();
    lowOsc.type = 'triangle';
    lowOsc.frequency.setValueAtTime(lowFreq, startTime);
    lowOsc.frequency.exponentialRampToValueAtTime(lowFreq * 0.55, startTime + 0.075);

    lowGain.gain.setValueAtTime(0.24 * intensity, startTime);
    lowGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.08);

    lowOsc.connect(lowGain);
    lowGain.connect(ctx.destination);
    lowOsc.start(startTime);
    lowOsc.stop(startTime + 0.085);

    // Crisp hardwood click resonance
    const highOsc = ctx.createOscillator();
    const highGain = ctx.createGain();
    highOsc.type = 'sine';
    highOsc.frequency.setValueAtTime(highFreq, startTime);
    highOsc.frequency.exponentialRampToValueAtTime(highFreq * 0.48, startTime + 0.032);

    highGain.gain.setValueAtTime(0.16 * intensity, startTime);
    highGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.036);

    highOsc.connect(highGain);
    highGain.connect(ctx.destination);
    highOsc.start(startTime);
    highOsc.stop(startTime + 0.04);

    // Short wood transient burst
    if (this.noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1450;
      filter.Q.value = 1.6;

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.26 * intensity, startTime);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.03);

      noise.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(ctx.destination);
      noise.start(startTime);
      noise.stop(startTime + 0.035);
    }
  }

  public playCollapse(): void {
    this.stopSlide();
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const hitCount = 12;
    for (let i = 0; i < hitCount; i++) {
      const offset = i * 0.065 + Math.random() * 0.045;
      const intensity = Math.max(0.25, 0.95 - i * 0.055);
      const jitter = 0.8 + Math.random() * 0.45;
      this.triggerWoodClack(
        ctx,
        now + offset,
        intensity,
        240 * jitter,
        740 * jitter
      );
    }
  }

  public playTurnChime(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const freqs = [523.25, 659.25];
    freqs.forEach((freq, idx) => {
      const start = now + idx * 0.09;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.08, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.26);
    });
  }

  public playCountdownTick(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(0.045, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.065);
  }
}

export const soundEngine = new SoundEngine();
