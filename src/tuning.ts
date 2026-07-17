/**
 * tuning.ts — every number that decides whether Morsel is a game.
 *
 * These live in one mutable object for one reason: tests/balance.test.ts sweeps
 * them. A competitive game cannot be balanced by argument — the first baseline
 * of this one refuted its own design document — so the constants have to be
 * cheap to vary and the sim has to be the thing that picks them. Shipped code
 * only ever READS this. The balance test restores whatever it changes.
 *
 * The measured story behind the current values is in balance.test.ts. The short
 * version: the danger here was never the snowball everyone expects from a blob
 * game. It was the opposite — make being big costly enough and nobody can ever
 * catch anybody, the dish turns into six people farming pellets in parallel, and
 * the winner is whoever happened to touch the last one.
 */

export interface Tuning {
  /** Speed of a START_MASS blob, world units per second. */
  V0: number;
  /** speed = V0 * (START_MASS / mass) ** SPEED_EXP. How much size costs you. */
  SPEED_EXP: number;
  /** How fast velocity chases the desired heading. Higher = twitchier. */
  ACCEL: number;
  /** You must be this much bigger to swallow. */
  EAT_RATIO: number;
  /** The victim's centre must be this far inside you — "mostly swallowed". */
  ENGULF: number;
  /** The eater banks this much of the victim; the rest scatters as food. */
  ABSORB: number;
  /** How many pellets the scattered remainder breaks into. */
  SCATTER_N: number;
  /** Fraction of your mass a dash costs. */
  DASH_COST: number;
  /** Speed multiplier at the instant of the lunge. */
  DASH_MULT: number;
  /** Seconds a dash lasts. */
  DASH_DUR: number;
  /** Seconds after a dash ends before you can dash again. */
  DASH_CD: number;
  /** The spent mass sprays into this many pellets behind you. */
  DASH_SPILL_N: number;
  /** Fraction of (mass - DECAY_FREE) a blob bleeds per second. */
  DECAY_K: number;
}

export const TUNING: Tuning = {
  V0: 215,
  /**
   * MEASURED. The single most load-bearing number in the game: how much being
   * big costs you. The sim was run across 0.12 -> 0.30 at 300 rounds each, and
   * it is a smooth trade-off rather than a peak, so this is a choice, not a
   * discovery:
   *
   *   0.12 -> blowouts 41.7%, biggestSwallow 200 — size stops mattering, the
   *           big blob simply runs everyone down. The snowball everyone expects
   *           from a blob game is real, and it lives down here.
   *   0.24 -> blowouts 20.0%, swallows 13.3. Chosen.
   *   0.30 -> blowouts 18.3% but swallows down to 11.4 and biggestSwallow to
   *           123 — safer numbers bought by draining the game of the one event
   *           it is about. Measuring the FEEL is what catches this direction.
   */
  SPEED_EXP: 0.24,
  ACCEL: 7.5,
  EAT_RATIO: 1.15,
  ENGULF: 0.15,
  ABSORB: 0.55,
  SCATTER_N: 6,
  DASH_COST: 0.15,
  /**
   * MEASURED, and the fix that made Morsel a game at all. The first baseline
   * had dash as a target speed reached through ACCEL, at 2.4x for 0.45s. It
   * closed ~47 units per attempt while the (faster) prey regained 26 during the
   * cooldown, so chasing was strictly irrational: 7.5 swallows per round, the
   * lead changed 115 times in 150s, and P(leader at 90% wins) was 30% — the
   * winner was whoever touched the last pellet. Making the dash an IMPULSE at
   * 3.2x for 0.6s took swallows to ~13 and P(leader at 90%) to ~65%.
   */
  DASH_MULT: 3.2,
  DASH_DUR: 0.6,
  DASH_CD: 1.1,
  DASH_SPILL_N: 4,
  DECAY_K: 0.008,
};

/** Snapshot / restore, so a sweep cannot leak a value into the next test. */
export function withTuning<T>(patch: Partial<Tuning>, fn: () => T): T {
  const saved = { ...TUNING };
  Object.assign(TUNING, patch);
  try {
    return fn();
  } finally {
    Object.assign(TUNING, saved);
  }
}
