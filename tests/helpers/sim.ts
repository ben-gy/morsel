/**
 * sim.ts — play Morsel headless, with bots in every seat.
 *
 * This is the referee. tests/balance.test.ts asks it the only questions that
 * matter about a competitive game and that no unit test can answer: is it still
 * a game halfway through, and is every seat the same game?
 *
 * Determinism is the whole point — a seeded rng, no Math.random, no clock. Two
 * runs of the same seed produce byte-identical results, so a balance change that
 * moves a number moved it for a reason.
 */

import { Game, type Seat } from '../../src/game';
import type { Mode } from '../../src/modes';
import { botIntent, personalities, BOT_HZ, type Personality } from '../../src/bot';
import { makeRng } from '@ben-gy/game-engine/rng';

export interface RoundOpts {
  seed: number;
  mode: Mode;
  /** How many blobs. Defaults to mode.seats. */
  seats?: number;
  /**
   * Sim rate. 60 matches the shipped game. Do NOT drop this below ~40 for a
   * balance claim: a dashing blob covers 516 units/sec, so at 20Hz it steps 26
   * units at a time and tunnels straight through small prey — the sim would
   * under-count exactly the event the game is about.
   */
  hz?: number;
  /** Round fractions at which to record who is leading. */
  samples?: number[];
}

export interface RoundResult {
  /** Seat holding the most mass at the whistle. */
  winner: number;
  /** Final mass per seat. */
  final: number[];
  /** Seat leading at each sample fraction, in order. */
  leaders: number[];
  /** How many times the lead changed hands over the round. */
  leadChanges: number;
  /** (winner - runner-up) / winner. 1 = total blowout, 0 = a dead heat. */
  margin: number;
  swallows: number;
  dashes: number;
  /** Biggest single blob swallowed all round. */
  biggestSwallow: number;
  /** Total mass in play at the whistle — the economy sanity check. */
  totalMass: number;
  steps: number;
}

export function playRound(opts: RoundOpts): RoundResult {
  const hz = opts.hz ?? 60;
  const dt = 1 / hz;
  const n = opts.seats ?? opts.mode.seats;
  const samples = opts.samples ?? [0.1, 0.25, 0.5, 0.75, 0.9];

  const seats: Seat[] = Array.from({ length: n }, (_, i) => ({ name: `B${i}`, bot: true }));
  const g = new Game({ seed: opts.seed, mode: opts.mode, seats });

  // Bots get their own rng stream, seeded off the round seed but separate from
  // the dish's, so a change to bot behaviour doesn't reshuffle the food field
  // and make every before/after comparison meaningless.
  const brng = makeRng(opts.seed ^ 0x5bf03635);
  const persons: Personality[] = personalities(brng, n);

  const leaders: number[] = [];
  let sampleAt = 0;
  let swallows = 0;
  let dashes = 0;
  let biggestSwallow = 0;
  let leadChanges = 0;
  let lastLeader = -1;
  let steps = 0;
  const botEvery = Math.max(1, Math.round(hz / BOT_HZ));

  const leader = (): number => {
    let best = -1;
    let bestM = -1;
    for (const b of g.blobs) {
      const s = g.score(b);
      if (s > bestM) {
        bestM = s;
        best = b.i;
      }
    }
    return best;
  };

  while (!g.over) {
    if (steps % botEvery === 0) {
      for (let i = 0; i < n; i++) {
        const it = botIntent(g, i, persons[i], brng);
        g.setIntent(i, it.ax, it.ay, it.dash);
      }
    }
    g.step(dt);
    steps++;

    for (const e of g.events) {
      if (e.k === 'dash') dashes++;
      else if (e.k === 'eat') {
        swallows++;
        if (e.mass > biggestSwallow) biggestSwallow = e.mass;
      }
    }
    g.events.length = 0;

    const l = leader();
    if (l !== lastLeader) {
      // The first "change" is just the round starting.
      if (lastLeader !== -1) leadChanges++;
      lastLeader = l;
    }

    while (sampleAt < samples.length && g.t >= samples[sampleAt] * opts.mode.secs) {
      leaders.push(l);
      sampleAt++;
    }
  }
  while (leaders.length < samples.length) leaders.push(lastLeader);

  const final = g.blobs.map((b) => g.score(b));
  const sorted = [...final].sort((a, b) => b - a);
  const winner = final.indexOf(sorted[0]);

  return {
    winner,
    final,
    leaders,
    leadChanges,
    margin: sorted[0] > 0 ? (sorted[0] - sorted[1]) / sorted[0] : 0,
    swallows,
    dashes,
    biggestSwallow,
    totalMass: final.reduce((a, b) => a + b, 0),
    steps,
  };
}

export interface Sweep {
  rounds: RoundResult[];
  /** P(the seat leading at samples[k] wins) — the drama curve. */
  leaderWins: number[];
  /** Win rate per seat, as a percentage. */
  seatWins: number[];
  /** Share of rounds where the winner more than doubled the runner-up. */
  blowouts: number;
  meanLeadChanges: number;
  meanSwallows: number;
  meanDashes: number;
  meanBiggest: number;
  meanTotalMass: number;
}

/** Play `games` rounds from fixed, consecutive seeds and aggregate. */
export function sweep(games: number, opts: Omit<RoundOpts, 'seed'>, seed0 = 1000): Sweep {
  const n = opts.seats ?? opts.mode.seats;
  const samples = opts.samples ?? [0.1, 0.25, 0.5, 0.75, 0.9];
  const rounds: RoundResult[] = [];
  for (let i = 0; i < games; i++) rounds.push(playRound({ ...opts, seed: seed0 + i }));

  const leaderWins = samples.map(
    (_, k) => rounds.filter((r) => r.leaders[k] === r.winner).length / rounds.length,
  );
  const seatWins = Array.from(
    { length: n },
    (_, s) => (rounds.filter((r) => r.winner === s).length / rounds.length) * 100,
  );
  const mean = (f: (r: RoundResult) => number): number =>
    rounds.reduce((a, r) => a + f(r), 0) / rounds.length;

  return {
    rounds,
    leaderWins,
    seatWins,
    blowouts: rounds.filter((r) => r.margin > 0.5).length / rounds.length,
    meanLeadChanges: mean((r) => r.leadChanges),
    meanSwallows: mean((r) => r.swallows),
    meanDashes: mean((r) => r.dashes),
    meanBiggest: mean((r) => r.biggestSwallow),
    meanTotalMass: mean((r) => r.totalMass),
  };
}

/** A one-line dump, so a failing assertion is readable without a debugger. */
export function report(label: string, s: Sweep, samples: number[]): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  return [
    `${label}:`,
    `  P(leader wins) ${samples.map((f, k) => `t${f * 100}%=${pct(s.leaderWins[k])}`).join('  ')}`,
    `  seats ${s.seatWins.map((v) => v.toFixed(1)).join(' / ')}`,
    `  blowouts ${pct(s.blowouts)}  leadChanges ${s.meanLeadChanges.toFixed(1)}`,
    `  swallows ${s.meanSwallows.toFixed(1)}  dashes ${s.meanDashes.toFixed(0)}` +
      `  biggestSwallow ${s.meanBiggest.toFixed(0)}  totalMass ${s.meanTotalMass.toFixed(0)}`,
  ].join('\n');
}
