/**
 * game.test.ts — the pure simulation.
 *
 * Everything here is deterministic and instant. The slow, statistical questions
 * ("is it still a game on second 40") live in balance.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  Game,
  START_MASS,
  canEat,
  radiusOf,
  speedOf,
  serveOrder,
  RESPAWN_S,
  type Seat,
} from '../src/game';
import { MODES, modeOf, DEFAULT_MODE, MODE_LIST } from '../src/modes';
import { TUNING as T, withTuning } from '../src/tuning';

const seats = (n: number): Seat[] =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i}`, bot: i > 0 }));

const mk = (n = 4, mode = MODES.petri, seed = 1): Game =>
  new Game({ seed, mode, seats: seats(n) });

/** Step a game forward `secs` seconds at 60Hz, draining events. */
const run = (g: Game, secs: number): void => {
  for (let i = 0; i < Math.round(secs * 60); i++) {
    g.step(1 / 60);
    g.events.length = 0;
  }
};

describe('serveOrder — the seat-fairness mechanism', () => {
  // This is the test that catches the real bug. The seat sweep in balance.test.ts
  // does NOT: reverting the rotation leaves that whole suite green, because the
  // bias is ~3 points of deviation and no stable threshold is that tight.
  // Verified by mutation: break the rotation below and this goes red immediately.

  it('serves every seat first exactly once per lap', () => {
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      const firsts = Array.from({ length: n }, (_, turn) => serveOrder(n, turn)[0]);
      expect(new Set(firsts).size, `n=${n} first-served: ${firsts}`).toBe(n);
    }
  });

  it('is always a permutation — nobody is skipped or served twice', () => {
    for (const n of [1, 2, 5, 8]) {
      for (let turn = 0; turn < n * 3; turn++) {
        const o = serveOrder(n, turn);
        expect(o).toHaveLength(n);
        expect([...o].sort((a, b) => a - b)).toEqual([...Array(n).keys()]);
      }
    }
  });

  it('does not favour seat 0 — the bug it exists to prevent', () => {
    // Index order would make this array all zeroes.
    const n = 6;
    const firsts = Array.from({ length: 60 }, (_, turn) => serveOrder(n, turn)[0]);
    const counts = Array.from({ length: n }, (_, s) => firsts.filter((f) => f === s).length);
    for (const c of counts) expect(c, `counts ${counts}`).toBe(60 / n);
  });
});

describe('the size/speed rule — the spine of the game', () => {
  it('bigger is strictly slower', () => {
    expect(speedOf(START_MASS)).toBeGreaterThan(speedOf(START_MASS * 10));
    expect(speedOf(START_MASS * 10)).toBeGreaterThan(speedOf(START_MASS * 100));
  });

  it('radius grows with the square root, so mass is AREA', () => {
    // Doubling the radius must quadruple the mass — otherwise a big blob covers
    // the dish in a way that is nothing like what the player sees.
    expect(radiusOf(40)).toBeCloseTo(radiusOf(10) * 2, 6);
  });

  it('a 10x blob is meaningfully slower but not immobile', () => {
    const ratio = speedOf(START_MASS * 10) / speedOf(START_MASS);
    expect(ratio).toBeLessThan(0.7); // being big has to cost something real
    expect(ratio).toBeGreaterThan(0.4); // ...but not so much it can never hunt
  });
});

describe('eating is asymmetric — which is what makes it race-free', () => {
  it('needs a clear size advantage', () => {
    expect(canEat(100, 100)).toBe(false);
    expect(canEat(100, 90)).toBe(false); // within EAT_RATIO — a standoff
    expect(canEat(100, 50)).toBe(true);
  });

  it('of any two blobs, at most one can ever be the eater', () => {
    // The property the whole victim-authoritative netcode rests on: if both
    // could eat each other, two peers could each report a kill.
    for (const a of [10, 37, 100, 260, 1000]) {
      for (const v of [10, 37, 100, 260, 1000]) {
        expect(canEat(a, v) && canEat(v, a)).toBe(false);
      }
    }
  });
});

describe('the dish', () => {
  it('opens with every seat identical', () => {
    const g = mk(6);
    const radii = g.blobs.map((b) => Math.hypot(b.x, b.y));
    for (const r of radii) expect(r).toBeCloseTo(radii[0], 6);
    for (const b of g.blobs) expect(b.mass).toBe(START_MASS);
  });

  it('keeps blobs inside the wall', () => {
    const g = mk(4);
    for (const b of g.blobs) g.setIntent(b.i, 1, 0, false);
    run(g, 20);
    for (const b of g.blobs) {
      expect(Math.hypot(b.x, b.y)).toBeLessThanOrEqual(g.mode.dishR - radiusOf(b.mass) + 0.001);
    }
  });

  it('holds the food supply near the mode target', () => {
    const g = mk(4);
    run(g, 30);
    const food = g.pelletList().filter((p) => p.food).length;
    expect(food).toBeGreaterThan(g.mode.food * 0.5);
    expect(food).toBeLessThanOrEqual(g.mode.food + 3);
  });

  it('ends at the whistle and then stops moving', () => {
    const g = mk(4, MODES.skirmish);
    run(g, MODES.skirmish.secs + 1);
    expect(g.over).toBe(true);
    const before = g.blobs.map((b) => `${b.x},${b.y}`);
    run(g, 2);
    expect(g.blobs.map((b) => `${b.x},${b.y}`)).toEqual(before);
  });
});

describe('the bloom — early gains small, late gains big', () => {
  it('ramps from 1 to bloomMax across the round', () => {
    const g = mk(4, MODES.petri);
    expect(g.bloom()).toBeCloseTo(1, 3);
    run(g, MODES.petri.secs / 2);
    expect(g.bloom()).toBeCloseTo(1 + (MODES.petri.bloomMax - 1) / 2, 1);
  });

  it('never exceeds bloomMax, even past the whistle', () => {
    const g = mk(4, MODES.skirmish);
    run(g, MODES.skirmish.secs + 5);
    expect(g.bloom()).toBeLessThanOrEqual(MODES.skirmish.bloomMax + 1e-9);
  });

  it('a late pellet is worth multiples of an early one', () => {
    // This IS the anti-early-luck mechanism. If it ever returned a flat 1 the
    // opening would start banking real leads again.
    const g = mk(4, MODES.famine);
    const early = g.bloom();
    run(g, MODES.famine.secs * 0.95);
    expect(g.bloom() / early).toBeGreaterThan(3);
  });
});

describe('dash — the one verb', () => {
  it('costs mass, and the mass lands in the dish rather than vanishing', () => {
    const g = mk(2);
    const b = g.blobs[0];
    b.mass = 100;
    const before = totalMass(g);
    g.setIntent(0, 1, 0, true);
    expect(b.mass).toBeCloseTo(85, 6); // 15% gone
    // Conservation: what he spent is now pellets, not thin air.
    expect(totalMass(g)).toBeCloseTo(before, 4);
    expect(b.stats.fed).toBeCloseTo(15, 6);
  });

  it('sprays the spend BEHIND you — into the lap of whoever you chase', () => {
    const g = mk(2);
    const b = g.blobs[0];
    b.mass = 100;
    b.x = 0;
    b.y = 0;
    const before = new Set(g.pelletList().map((p) => p.id));
    g.setIntent(0, 1, 0, true); // heading +x
    const spill = g.pelletList().filter((p) => !before.has(p.id));
    expect(spill.length).toBeGreaterThan(0);
    for (const p of spill) expect(p.x).toBeLessThan(0); // behind
  });

  it('is an impulse — it moves you NOW', () => {
    // The first baseline ramped into the dash through ACCEL and it ate most of
    // the burst, which is why nothing was ever caught. Guard the fix.
    const g = mk(2);
    const b = g.blobs[0];
    b.mass = 100;
    g.setIntent(0, 1, 0, true);
    expect(b.vx).toBeCloseTo(speedOf(85) * T.DASH_MULT, 4);
  });

  it('respects the cooldown', () => {
    const g = mk(2);
    const b = g.blobs[0];
    b.mass = 200;
    g.setIntent(0, 1, 0, true);
    const after = b.mass;
    g.setIntent(0, 1, 0, true); // immediately again
    expect(b.mass).toBe(after); // refused, no double-charge
  });

  it('will not dash a speck into nothing', () => {
    const g = mk(2);
    const b = g.blobs[0];
    b.mass = START_MASS;
    g.setIntent(0, 1, 0, true);
    expect(b.mass).toBe(START_MASS);
  });

  it('needs a direction — a dash with no heading is not a free spend', () => {
    const g = mk(2);
    const b = g.blobs[0];
    b.mass = 100;
    g.setIntent(0, 0, 0, true);
    expect(b.mass).toBe(100);
  });
});

describe('swallowing', () => {
  it('banks a share and scatters the rest', () => {
    const g = mk(2);
    const [a, v] = g.blobs;
    a.mass = 200;
    v.mass = 40;
    const before = totalMass(g);
    g.swallow(a, v);
    expect(a.mass).toBeCloseTo(200 + 40 * T.ABSORB, 5);
    expect(v.mass).toBe(START_MASS);
    expect(v.ghost).toBeCloseTo(RESPAWN_S, 5);
    // The victim's mass went somewhere: eater + dish, nowhere else. (The victim
    // respawning at START_MASS is a fresh injection, hence the +START_MASS.)
    expect(totalMass(g)).toBeCloseTo(before + START_MASS, 3);
  });

  it('killing the leader spills the lead into the dish, not into you', () => {
    // The catch-up mechanism. If ABSORB were 1.0 the winner of one fight would
    // simply become the new runaway.
    const g = mk(2);
    const [a, v] = g.blobs;
    a.mass = 120;
    v.mass = 400;
    const foodBefore = g.pelletList().length;
    g.swallow(a, v);
    expect(a.mass).toBeLessThan(400); // eating the leader does not crown you
    expect(g.pelletList().length).toBeGreaterThan(foodBefore);
  });

  it('records both sides of the ledger', () => {
    const g = mk(2);
    const [a, v] = g.blobs;
    a.mass = 200;
    v.mass = 90;
    g.swallow(a, v);
    expect(a.stats.swallows).toBe(1);
    expect(a.stats.biggest).toBe(90);
    expect(v.stats.timesEaten).toBe(1);
    expect(v.stats.fed).toBeCloseTo(90 * (1 - T.ABSORB), 5);
  });

  it('happens when a big blob engulfs a small one', () => {
    const g = mk(2);
    const [a, v] = g.blobs;
    a.mass = 400;
    v.mass = 10;
    a.x = 0;
    a.y = 0;
    v.x = 5;
    v.y = 0;
    g.step(1 / 60);
    expect(v.ghost).toBeGreaterThan(0);
  });

  it('does NOT happen to a blob merely touching your rim', () => {
    const g = mk(2);
    const [a, v] = g.blobs;
    a.mass = 400;
    v.mass = 10;
    a.x = 0;
    a.y = 0;
    v.x = radiusOf(400) + radiusOf(10) - 1; // grazing
    v.y = 0;
    g.step(1 / 60);
    expect(v.ghost).toBe(0);
  });

  it('a ghost cannot be eaten again while it is down', () => {
    const g = mk(2);
    const [a, v] = g.blobs;
    a.mass = 400;
    v.mass = 100;
    g.swallow(a, v);
    const mass = a.mass;
    g.swallow(a, v);
    expect(a.mass).toBe(mass);
    expect(a.stats.swallows).toBe(1);
  });
});

describe('nobody is ever out', () => {
  it('respawns as a speck, somewhere survivable', () => {
    const g = mk(4);
    const v = g.blobs[1];
    g.blobs[0].mass = 500;
    g.swallow(g.blobs[0], v);
    expect(v.ghost).toBeGreaterThan(0);
    run(g, RESPAWN_S + 0.2);
    expect(v.ghost).toBe(0);
    expect(v.mass).toBe(START_MASS);
    // Not respawned inside the mouth of the thing that just ate it.
    const d = Math.hypot(v.x - g.blobs[0].x, v.y - g.blobs[0].y);
    expect(d).toBeGreaterThan(radiusOf(g.blobs[0].mass));
  });

  it('a ghost scores nothing but is still on the board', () => {
    const g = mk(2);
    g.blobs[0].mass = 500;
    g.swallow(g.blobs[0], g.blobs[1]);
    expect(g.score(g.blobs[1])).toBe(0);
    expect(g.standings()[0].i).toBe(0);
  });

  it('ignores intent while down', () => {
    const g = mk(2);
    g.blobs[0].mass = 500;
    const v = g.blobs[1];
    g.swallow(g.blobs[0], v);
    const at = { x: v.x, y: v.y };
    g.setIntent(1, 1, 0, true);
    expect(v.ax).toBe(0);
    g.step(1 / 60);
    expect(v.x).toBe(at.x);
  });
});

describe('decay — big blobs bleed, specks do not', () => {
  it('a fresh blob never starves', () => {
    const g = mk(2);
    const b = g.blobs[0];
    g.setIntent(0, 0, 0, false);
    b.x = 1e5; // parked outside the dish's food, so only decay acts
    run(g, 10);
    expect(b.mass).toBeGreaterThanOrEqual(START_MASS);
  });

  it('a fat blob loses mass if it stops eating', () => {
    const g = mk(2);
    const b = g.blobs[0];
    b.mass = 1000;
    b.x = 1e5;
    run(g, 10);
    expect(b.mass).toBeLessThan(1000);
  });
});

describe('modes', () => {
  it('exposes three, and they differ in how you get fed', () => {
    expect(MODE_LIST).toHaveLength(3);
    const density = MODE_LIST.map((m) => m.food / (Math.PI * m.dishR ** 2));
    // Famine is the outlier by construction: you cannot farm a win there.
    expect(Math.min(...density)).toBe(density[2]);
    expect(density[2]).toBeLessThan(density[1] / 2);
  });

  it('every mode is a real spread, not a reskin', () => {
    const key = (m: (typeof MODE_LIST)[number]): string => `${m.dishR}|${m.secs}|${m.food}`;
    expect(new Set(MODE_LIST.map(key)).size).toBe(3);
  });

  it('modeOf resolves a known id', () => {
    expect(modeOf('famine').id).toBe('famine');
  });

  it('modeOf refuses prototype keys off the wire', () => {
    // MODES[id] || DEFAULT would hand the sim `Object.prototype.constructor`,
    // which has no dishR, and the dish would generate as NaN.
    for (const evil of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(modeOf(evil), evil).toBe(DEFAULT_MODE);
    }
  });

  it('modeOf falls back for junk', () => {
    for (const junk of [undefined, null, 42, {}, [], '', 'nope']) {
      expect(modeOf(junk)).toBe(DEFAULT_MODE);
    }
  });
});

describe('tuning is restored after a sweep', () => {
  it('withTuning cannot leak into the next test', () => {
    const before = T.SPEED_EXP;
    withTuning({ SPEED_EXP: 0.9 }, () => {
      expect(T.SPEED_EXP).toBe(0.9);
    });
    expect(T.SPEED_EXP).toBe(before);
  });

  it('restores even when the body throws', () => {
    const before = T.SPEED_EXP;
    expect(() =>
      withTuning({ SPEED_EXP: 0.9 }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(T.SPEED_EXP).toBe(before);
  });
});

function totalMass(g: Game): number {
  let m = 0;
  for (const b of g.blobs) m += b.mass;
  for (const p of g.pelletList()) m += p.food ? 0 : p.v;
  return m;
}
