/**
 * countdown.ts — 3, 2, 1, GO.
 *
 * A round never begins the instant the board appears. Without this, whoever
 * happens to be looking at their screen gets a free head start, and the board
 * reads as a jump-cut rather than a start.
 *
 * The AUDIO carries it — players watch the grid, not the overlay — so each beat
 * fires a sound whether or not anything is rendering.
 *
 * Each peer counts locally from the host's start message. That leaves peers in
 * step to within one network hop, which is plenty: the round clock is
 * host-authoritative anyway, so the countdown is theatre, not timing.
 *
 * setInterval, never rAF alone: a backgrounded tab pauses rAF, and a countdown
 * that freezes when you glance at another tab is worse than none.
 */

export interface CountdownOpts {
  /** 3 => "3", "2", "1", "GO". */
  from?: number;
  /** Ms per beat. */
  beatMs?: number;
  /** Fires per beat. `n` is 3,2,1 then 0 for GO. */
  onBeat: (n: number) => void;
  onDone: () => void;
  /** Injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface Countdown {
  /** Stop early. Safe to call twice, and MUST be called on teardown. */
  cancel(): void;
  done(): boolean;
}

export function startCountdown(opts: CountdownOpts): Countdown {
  const from = opts.from ?? 3;
  const beatMs = opts.beatMs ?? 700;
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let n = from;
  let finished = false;
  let handle: unknown = null;

  // The first beat is immediate — waiting a full beat before "3" appears just
  // looks like the game hasn't started.
  opts.onBeat(n);

  const stop = (): void => {
    if (handle !== null) clearTimer(handle);
    handle = null;
  };

  handle = setTimer(() => {
    if (finished) return;
    n--;
    opts.onBeat(n); // 0 is GO
    if (n <= 0) {
      finished = true;
      stop();
      opts.onDone();
    }
  }, beatMs);

  return {
    cancel() {
      if (finished) return;
      finished = true;
      stop();
    },
    done: () => finished,
  };
}
