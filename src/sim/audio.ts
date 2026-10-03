/**
 * Buzzers' sound: one square-wave voice per buzzer, at the pitch the
 * program drives it. The browser only allows sound after a click, so the
 * audio starts on the Start button.
 */
export class BuzzerSound {
  private ctx: AudioContext | null = null;
  private voices = new Map<string, { osc: OscillatorNode; gain: GainNode; frequency: number }>();
  muted = false;

  /** Call from a click: makes sound possible. */
  resume() {
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
      }
      void this.ctx.resume();
    } catch { /* no sound on this browser */ }
  }

  /** A buzzer's pitch now; 0 is silent. */
  set(id: string, frequency: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    let voice = this.voices.get(id);
    if (!voice) {
      if (frequency <= 0) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      voice = { osc, gain, frequency: 0 };
      this.voices.set(id, voice);
    }
    const audible = frequency > 20 && frequency < 20000 && !this.muted;
    const t = ctx.currentTime;
    if (audible) voice.osc.frequency.setTargetAtTime(frequency, t, 0.002);
    voice.gain.gain.setTargetAtTime(audible ? 0.04 : 0, t, 0.005);
    voice.frequency = frequency;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    for (const [id, v] of this.voices) this.set(id, v.frequency);
  }

  /** Silence everything (stop or pause). */
  silence() {
    for (const [id] of this.voices) this.set(id, 0);
  }

  dispose() {
    for (const v of this.voices.values()) { try { v.osc.stop(); v.osc.disconnect(); v.gain.disconnect(); } catch { /* already stopped */ } }
    this.voices.clear();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
