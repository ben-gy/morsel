/**
 * sound.ts — procedural SFX. Zero asset files, works offline.
 *
 * Adapted from patterns/sound.ts with Morsel's own patches. Two of them are not
 * decoration:
 *
 *  - `pellet` is PITCHED BY YOUR MASS. Growing is a thing you hear happening,
 *    continuously, without reading the HUD. It is the closest this game gets to
 *    a score display.
 *  - the countdown beats and `whistle` carry the round's edges, because players
 *    are watching the dish, not the overlay.
 */

export type SfxName =
  | 'pellet'
  | 'dash'
  | 'swallow'
  | 'eaten'
  | 'spawn'
  | 'bloom'
  | 'whistle'
  | 'beat'
  | 'go'
  | 'select'
  | 'win';

interface Patch {
  type: OscillatorType;
  /** [startFreq, endFreq] Hz — glides between them over `dur`. */
  freq: [number, number];
  dur: number;
  /** Peak gain 0..1. */
  gain?: number;
  /** Add a short noise burst (impacts). */
  noise?: boolean;
}

const PATCHES: Record<SfxName, Patch> = {
  // Base pitch; play() transposes this one by your mass.
  pellet: { type: 'sine', freq: [660, 990], dur: 0.05, gain: 0.13 },
  dash: { type: 'sawtooth', freq: [220, 640], dur: 0.16, gain: 0.16, noise: true },
  // A wet, descending gulp. The most satisfying 200ms in the game.
  swallow: { type: 'triangle', freq: [520, 90], dur: 0.24, gain: 0.3, noise: true },
  // Your death. Deliberately low and ugly — it should sting.
  eaten: { type: 'sawtooth', freq: [180, 44], dur: 0.5, gain: 0.32, noise: true },
  spawn: { type: 'sine', freq: [300, 700], dur: 0.16, gain: 0.16 },
  bloom: { type: 'triangle', freq: [880, 1320], dur: 0.28, gain: 0.13 },
  whistle: { type: 'square', freq: [900, 300], dur: 0.6, gain: 0.26 },
  beat: { type: 'square', freq: [440, 440], dur: 0.1, gain: 0.22 },
  go: { type: 'square', freq: [880, 1200], dur: 0.28, gain: 0.28 },
  select: { type: 'triangle', freq: [520, 880], dur: 0.08, gain: 0.18 },
  win: { type: 'triangle', freq: [520, 1040], dur: 0.5, gain: 0.26 },
};

export interface Sfx {
  unlock(): void;
  /**
   * `param` transposes pitched patches. For 'pellet' it is the eater's mass —
   * bigger blob, deeper blip.
   */
  play(name: SfxName, param?: number): void;
  muted(): boolean;
  setMuted(m: boolean): void;
}

export function createSfx(initialMuted = false): Sfx {
  let ctx: AudioContext | null = null;
  let muted = initialMuted;
  /** Web Audio will happily stack 40 gulps into a clipped roar. */
  let voices = 0;

  const ensure = (): AudioContext | null => {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
      } catch {
        return null;
      }
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  };

  const noiseBuffer = (ac: AudioContext, dur: number): AudioBuffer => {
    const len = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  return {
    unlock() {
      ensure();
    },

    play(name, param) {
      if (muted) return;
      if (voices > 12) return; // a dish-wide feeding frenzy must not clip
      const ac = ensure();
      if (!ac) return;
      const p = PATCHES[name];
      if (!p) return;

      let [f0, f1] = p.freq;
      if (name === 'pellet' && param != null) {
        // Down an octave and a half across the whole mass range. Fast to read,
        // and it makes a fat blob's grazing sound like a fat blob grazing.
        const k = 1 / (1 + Math.log10(Math.max(1, param / 10)) * 0.42);
        f0 *= k;
        f1 *= k;
      }

      try {
        const t0 = ac.currentTime;
        voices++;
        const g = ac.createGain();
        g.gain.setValueAtTime(p.gain ?? 0.25, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
        g.connect(ac.destination);

        const osc = ac.createOscillator();
        osc.type = p.type;
        osc.frequency.setValueAtTime(Math.max(1, f0), t0);
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + p.dur);
        osc.connect(g);
        osc.start(t0);
        osc.stop(t0 + p.dur);
        osc.onended = () => {
          voices--;
        };

        if (p.noise) {
          const n = ac.createBufferSource();
          n.buffer = noiseBuffer(ac, p.dur);
          const ng = ac.createGain();
          ng.gain.setValueAtTime((p.gain ?? 0.25) * 0.5, t0);
          ng.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
          n.connect(ng);
          ng.connect(ac.destination);
          n.start(t0);
          n.stop(t0 + p.dur);
        }
      } catch {
        // Audio is a nice-to-have; a blocked or exhausted context must never
        // take the game down with it.
        voices = Math.max(0, voices - 1);
      }
    },

    muted: () => muted,
    setMuted(m) {
      muted = m;
    },
  };
}
