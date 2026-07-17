/**
 * balance.test.ts — is Morsel still a game on second 40?
 *
 * Every other test in this repo asks "does it work". None of them can see the
 * two ways a competitive game dies, because both are invisible to unit tests and
 * to the ninety seconds you spend playing it yourself:
 *
 *   1. It is over before you made a decision (the snowball).
 *   2. It is never over, so the winner is whoever touched the last pellet (noise).
 *
 * Morsel's first baseline had disease #2, badly, and the design document
 * confidently predicted #1. That is the entire reason this file exists and the
 * entire reason it was written BEFORE any constant was tuned: the diagnosis was
 * wrong, and nothing except the sim was ever going to say so.
 *
 * The numbers in the assertions below are all measured. Where a bound looks
 * loose it is because the interesting direction is one-sided; where it looks
 * tight it is because the sim is deterministic (fixed seeds, seeded rng, no
 * clock), so these are not flaky — a change that moves them moved them for a
 * reason, and you should read the reason before widening the bound.
 *
 * Runtime is ~40s. That is the price of the only test here that can see a
 * fairness bug, and it is worth it: it found one (see `order()` in game.ts).
 */

import { describe, expect, it } from 'vitest';
import { sweep, report, playRound } from './helpers/sim';
import { MODES } from '../src/modes';
import { withTuning } from '../src/tuning';
import { Game, START_MASS } from '../src/game';

const SAMPLES = [0.1, 0.25, 0.5, 0.75, 0.9];

// One sweep per mode, reused for every question about that mode. Sim time is
// the budget here, so we buy it once.
const petri = sweep(300, { mode: MODES.petri, hz: 60, samples: SAMPLES });
const skirmish = sweep(250, { mode: MODES.skirmish, hz: 60, samples: SAMPLES });
const famine = sweep(200, { mode: MODES.famine, hz: 60, samples: SAMPLES });

const CASES = [
  { name: 'Petri', s: petri, mode: MODES.petri },
  { name: 'Skirmish', s: skirmish, mode: MODES.skirmish },
  { name: 'Famine', s: famine, mode: MODES.famine },
];

describe('the drama curve — P(leader at time T eventually wins)', () => {
  // This curve IS the game. It must sit near chance while the round is young and
  // only spike at the end. Flat all the way = a slot machine. High at t=10% =
  // the round was decided before anyone made a decision.
  for (const { name, s, mode } of CASES) {
    const chance = 1 / mode.seats;

    it(`${name}: the opening is near chance, so early luck banks nothing`, () => {
      // Measured t10: Petri 18.3%, Skirmish 19.2%, Famine 12.1% (chance 16.7 /
      // 16.7 / 12.5). The bloom ramp is what buys this — a pellet on second 5 is
      // worth a quarter of one at the whistle.
      expect(s.leaderWins[0], report(name, s, SAMPLES)).toBeLessThan(chance + 0.14);
    });

    it(`${name}: still open at halftime`, () => {
      // Measured t50: Petri 27.9%, Skirmish 35.6%, Famine 20.0%. Skirmish runs
      // hotter on purpose — it is a 110s mode, so every fraction of it is later
      // than the same fraction of Petri.
      expect(s.leaderWins[2], report(name, s, SAMPLES)).toBeLessThan(chance * 2.4);
    });

    it(`${name}: but it does resolve — a late lead mostly holds`, () => {
      // Measured t90: Petri 64.9%, Skirmish 70.8%, Famine 60.0%. If this sits
      // near chance the round never resolves and the winner is noise, which is
      // exactly the disease the first baseline had (30% here).
      expect(s.leaderWins[4], report(name, s, SAMPLES)).toBeGreaterThan(0.5);
      // ...and it must not be a certainty either: being biggest with seconds
      // left has to be frightening, not a victory lap.
      expect(s.leaderWins[4], report(name, s, SAMPLES)).toBeLessThan(0.9);
    });

    it(`${name}: the curve rises — that ramp is the drama`, () => {
      const s2 = s.leaderWins;
      expect(s2[4] - s2[0], report(name, s, SAMPLES)).toBeGreaterThan(0.3);
      expect(s2[4], report(name, s, SAMPLES)).toBeGreaterThan(s2[2]);
    });
  }
});

describe('seat fairness', () => {
  // The check that would have caught Hexbloom's 3P seats sitting at 54/33/10.
  //
  // Know what this can and cannot see. It catches GROSS unfairness — a seat that
  // is winning half the games or one in ten. It did NOT catch the real bias this
  // game shipped with (index-order service, ~6 points of spread): reverting that
  // fix leaves every assertion here green, because a per-seat threshold loose
  // enough not to flake is loose enough to miss a 3-point deviation. That is why
  // `serveOrder` is tested directly in game.test.ts. Statistical outcome tests
  // and mechanism tests are not substitutes for each other.
  for (const { name, s, mode } of CASES) {
    it(`${name}: no seat is grossly favoured over 100/${mode.seats}`, () => {
      const chance = 100 / mode.seats;
      for (const [i, w] of s.seatWins.entries()) {
        expect(Math.abs(w - chance), `seat ${i} of ${name}\n${report(name, s, SAMPLES)}`).toBeLessThan(6);
      }
    });
  }

  it('the dish itself is symmetric, so no seat can open luckier than another', () => {
    // Asserts the turn-0 fairness property DIRECTLY rather than inferring it
    // from win rates: rotating the opening dish by 2*pi/n must map the food
    // field onto itself and each blob onto the next seat. That is what makes
    // "no player starts with an advantage from the random board" a fact about
    // the generator instead of a hope about the statistics.
    for (const mode of Object.values(MODES)) {
      const n = mode.seats;
      const g = new Game({
        seed: 42,
        mode,
        seats: Array.from({ length: n }, (_, i) => ({ name: `B${i}`, bot: true })),
      });
      const a = (Math.PI * 2) / n;
      const rot = (x: number, y: number): [number, number] => [
        x * Math.cos(a) - y * Math.sin(a),
        x * Math.sin(a) + y * Math.cos(a),
      ];

      // Every blob starts on the ring at the same radius and the same mass.
      const radii = g.blobs.map((b) => Math.hypot(b.x, b.y));
      for (const r of radii) expect(r).toBeCloseTo(radii[0], 6);
      for (const b of g.blobs) expect(b.mass).toBe(START_MASS);

      // Rotating any pellet by one sector lands on another pellet.
      const pellets = g.pelletList();
      const near = (x: number, y: number): boolean =>
        pellets.some((q) => Math.hypot(q.x - x, q.y - y) < 0.5);
      for (const p of pellets) {
        const [rx, ry] = rot(p.x, p.y);
        expect(near(rx, ry), `${mode.name}: pellet ${p.x},${p.y} has no rotated twin`).toBe(true);
      }
    }
  });
});

describe('it does not turn into a procession, and it does terminate', () => {
  for (const { name, s } of CASES) {
    it(`${name}: blowouts stay bounded`, () => {
      // Measured: Petri 21.9%, Skirmish 28.0%, Famine 20.3%. Hexbloom's
      // disaster case was 51%.
      expect(s.blowouts, report(name, s, SAMPLES)).toBeLessThan(0.4);
    });

    it(`${name}: the lead actually changes hands`, () => {
      // A "fix" that flattens the curve by making every round a dead heat would
      // pass the tests above. This is the floor that catches it.
      expect(s.meanLeadChanges, report(name, s, SAMPLES)).toBeGreaterThan(5);
    });
  }

  it('every round ends at the whistle, to within a frame', () => {
    // Not exactly `secs * 60`: accumulating 1/60 six thousand times lands a
    // fraction past the mark, so the last step overshoots by up to one frame.
    // A 17ms-long final frame is not worth defending against; a round that
    // never ends is, which is what this actually guards.
    for (const mode of Object.values(MODES)) {
      const r = playRound({ seed: 3, mode, hz: 60 });
      expect(r.steps, mode.name).toBeGreaterThanOrEqual(mode.secs * 60);
      expect(r.steps, mode.name).toBeLessThanOrEqual(mode.secs * 60 + 2);
    }
  });

  it('the mass economy neither inflates nor starves', () => {
    // Food is the only faucet; dash spill and the swallow scatter are transfers.
    // If spill were bloom-valued too, a late dash would CREATE mass and this
    // would run away.
    for (const { name, s, mode } of CASES) {
      expect(s.meanTotalMass, name).toBeGreaterThan(mode.seats * 20);
      expect(s.meanTotalMass, name).toBeLessThan(mode.seats * 500);
    }
  });
});

describe('the feel — a fix that flattens the fun is still a failed fix', () => {
  // Hexbloom's capture cap fixed the win curve and destroyed the game: 0% of
  // blooms >= 6 tiles, when the cascade WAS the product. So the numbers that
  // describe the joy get asserted next to the numbers that describe the drama.
  for (const { name, s, mode } of CASES) {
    it(`${name}: blobs actually eat each other`, () => {
      // Measured: Petri 12.7, Skirmish 14.2, Famine 25.2 per round. The first
      // baseline managed 7.5 in Petri and the game was dead on its feet.
      expect(s.meanSwallows, report(name, s, SAMPLES)).toBeGreaterThan(mode.seats * 1.2);
    });

    it(`${name}: big swallows happen — the cascade is the product`, () => {
      // Mean biggest swallow of the round: Petri 143, Skirmish 133, Famine 108
      // — i.e. 10-14x a starting blob. If this collapses toward START_MASS then
      // nobody is ever getting fat and the game has no climax.
      expect(s.meanBiggest, report(name, s, SAMPLES)).toBeGreaterThan(40);
    });

    it(`${name}: dash is used constantly — it is the only verb`, () => {
      expect(s.meanDashes, report(name, s, SAMPLES)).toBeGreaterThan(mode.seats * 8);
    });
  }
});

describe('the constants the balance rests on', () => {
  it('SPEED_EXP is load-bearing: cheap size brings the snowball back', () => {
    // Pin it, per principle #18. If size stops costing speed, the biggest blob
    // runs everyone down and the game becomes the thing everyone assumed a blob
    // game already was. Measured at 60 rounds: blowouts 41.7% at 0.12 vs ~22%
    // shipped. This test exists so that "let's make it feel snappier" cannot
    // quietly re-arm the trap.
    const loose = withTuning({ SPEED_EXP: 0.12 }, () =>
      sweep(60, { mode: MODES.petri, hz: 60, samples: SAMPLES }),
    );
    const shipped = sweep(60, { mode: MODES.petri, hz: 60, samples: SAMPLES });
    expect(loose.blowouts).toBeGreaterThan(shipped.blowouts);
    expect(loose.meanBiggest).toBeGreaterThan(shipped.meanBiggest);
  });

  it('the sim rate is high enough not to tunnel through prey', () => {
    // A dashing blob covers ~400 units/sec. At 60Hz that is 6.6 units a step,
    // comfortably inside a starting blob's 9-unit radius. Drop the rate and the
    // sim silently stops seeing the event the whole game is about, so every
    // number above would be measuring a different game than the one that ships.
    const fast = playRound({ seed: 11, mode: MODES.petri, hz: 60 });
    const slow = playRound({ seed: 11, mode: MODES.petri, hz: 20 });
    expect(fast.swallows).toBeGreaterThan(slow.swallows);
  });
});
