// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * game.ts — the Morsel simulation. Pure, headless, deterministic.
 *
 * No DOM, no canvas, no Math.random. Everything random comes from a seeded rng,
 * so two peers fed the same seed produce the same dish, and — the reason this
 * file is shaped like this at all — `tests/balance.test.ts` can play a few
 * hundred AI-vs-AI rounds headless and referee the design. Principle #18: build
 * the sim first, let it tell you what the game actually is. Every constant below
 * that carries a measurement in its comment was set by that test, not by a story
 * about how the game ought to work.
 *
 * The one idea:
 *
 *   Big blobs are SLOW. So the only way to catch anything is to DASH, and dash
 *   costs 15% of your mass, sprayed out behind you as food for whoever you are
 *   chasing. The only way to grow your lead is to spend your lead.
 *
 * Everything else is bookkeeping around that.
 */

import { makeRng, randFloat, type Rng } from '@ben-gy/game-engine/rng';
import type { Mode } from './modes';
import { TUNING as T } from './tuning';

// ── the constants ───────────────────────────────────────────────────────────
//
// The numbers the balance sim varies live in tuning.ts. The ones here are
// structural — changing them changes what the game IS, not how it plays out.

/** Where everyone starts, and where you return after being swallowed. */
export const START_MASS = 10;

/** radius = R_K * sqrt(mass), so AREA is proportional to mass. */
export const R_K = 2.85;

/** Dashing below this would make you a rounding error. */
const DASH_MIN_MASS = START_MASS * 1.2;

/** Specks below this do not decay at all — a respawn must not feel like drowning. */
const DECAY_FREE = START_MASS * 2;

/** Steering authority is cut to this while lunging, so a dash COMMITS. Without
 *  it a dash is a homing missile and prey can never juke. */
const DASH_STEER = 0.35;

/** Pellets a departing player's blob breaks into. */
const SCATTER_ON_LEAVE = 10;

/** Seconds you spend as a ghost after being swallowed. */
export const RESPAWN_S = 1.5;

/** Drawn/collision radius of a pellet. */
export const PELLET_R = 5;

/** Cell size of the pellet lookup grid, world units. */
const CELL = 110;

// ── types ───────────────────────────────────────────────────────────────────

export interface Pellet {
  id: number;
  x: number;
  y: number;
  /**
   * Dish food (true) is worth bloom(t) — it ramps over the round. Spill (false)
   * is worth exactly `v`, the mass somebody bled to make it.
   *
   * That split is not cosmetic: if spill were bloom-valued too, a late dash
   * would CREATE mass (spend 15, hand the dish 60) and the economy would inflate
   * out of control. Spill is a transfer; food is the faucet.
   */
  food: boolean;
  /** Mass value for spill pellets. Ignored for food. */
  v: number;
  /** Colour index of the blob that bled it, or -1 for dish food. */
  c: number;
}

export interface Stats {
  pellets: number;
  swallows: number;
  timesEaten: number;
  peak: number;
  /** Mass handed to the rest of the dish: dash spill + what scattered off you. */
  fed: number;
  /** Biggest single blob this player has swallowed. */
  biggest: number;
}

export interface Blob {
  i: number;
  /** Display name. AI seats get one too. */
  name: string;
  /** True for a seat driven by a bot. */
  bot: boolean;
  mass: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Unit heading the blob wants to swim in. (0,0) = drift. */
  ax: number;
  ay: number;
  /** Seconds of dash left. */
  dashT: number;
  /** Seconds until dash is available. */
  dashCd: number;
  /** Seconds until respawn, or 0 if alive. Infinity once the player has left. */
  ghost: number;
  /** This player left the room mid-round; their blob is parked, not dead. */
  left: boolean;
  stats: Stats;
}

export type GameEvent =
  | { k: 'pellet'; i: number; x: number; y: number; v: number; food: boolean }
  | { k: 'dash'; i: number; x: number; y: number }
  | { k: 'eat'; i: number; j: number; x: number; y: number; mass: number }
  | { k: 'spawn'; i: number; x: number; y: number }
  | { k: 'bloom'; v: number };

export interface Seat {
  name: string;
  bot: boolean;
}

export interface GameOpts {
  seed: number;
  mode: Mode;
  /** One per blob in the dish. Humans first, then bots. */
  seats: Seat[];
}

export const radiusOf = (mass: number): number => R_K * Math.sqrt(mass);
export const speedOf = (mass: number): number => T.V0 * (START_MASS / mass) ** T.SPEED_EXP;

export class Game {
  readonly mode: Mode;
  readonly blobs: Blob[] = [];
  /** Keyed by id. Pellets never move, so the grid below is maintained on
   *  add/remove rather than rebuilt every step. */
  readonly pellets = new Map<number, Pellet>();
  /** Seconds elapsed. The round ends at mode.secs. */
  t = 0;
  over = false;
  /** Drained by the renderer each frame. Headless callers just ignore it. */
  events: GameEvent[] = [];

  private rng: Rng;
  private nextId = 1;
  private grid = new Map<number, Set<number>>();
  /** Last integer bloom value announced, so the chime fires once per step up. */
  private bloomStep = 1;
  /**
   * Rotates which seat is served first, every step. See `order()` — this is a
   * fairness fix, not a detail.
   */
  private turn = 0;

  constructor(opts: GameOpts) {
    this.mode = opts.mode;
    this.rng = makeRng(opts.seed);

    const n = opts.seats.length;
    // Seats sit on a ring, equally spaced. Perfectly symmetric on purpose: with
    // the symmetric food field below, seat i's opening is a pure rotation of
    // seat 0's, so no seat can be luckier than another. That is the turn-0
    // fairness rule, and it is why tests/balance.test.ts's seat check is a
    // statement about the AI rather than about the geometry.
    const phase = randFloat(this.rng, 0, Math.PI * 2);
    const ring = opts.mode.dishR * 0.6;
    for (let i = 0; i < n; i++) {
      const a = phase + (Math.PI * 2 * i) / n;
      this.blobs.push({
        i,
        name: opts.seats[i].name,
        bot: opts.seats[i].bot,
        mass: START_MASS,
        x: Math.cos(a) * ring,
        y: Math.sin(a) * ring,
        vx: 0,
        vy: 0,
        ax: 0,
        ay: 0,
        dashT: 0,
        dashCd: 0,
        ghost: 0,
        left: false,
        stats: { pellets: 0, swallows: 0, timesEaten: 0, peak: START_MASS, fed: 0, biggest: 0 },
      });
    }

    this.seedFood(n);
  }

  // ── the dish ──────────────────────────────────────────────────────────────

  /**
   * Lay the opening food field with n-fold rotational symmetry: generate one
   * sector, then copy it around the ring. Every seat therefore opens onto an
   * identical neighbourhood, rotated. A plain random scatter hands one player a
   * cluster and another a desert before anyone has moved — the same trap
   * Hexbloom's random start fell into.
   *
   * Only the OPENING is symmetric. Food that respawns mid-round is free to land
   * anywhere; by then the players have made it unfair themselves, which is the
   * point of a game.
   */
  private seedFood(n: number): void {
    const per = Math.max(1, Math.round(this.mode.food / n));
    for (let s = 0; s < per; s++) {
      // Uniform over the disc: sqrt() or everything piles into the middle.
      const r = Math.sqrt(this.rng()) * this.mode.dishR * 0.94;
      const a0 = randFloat(this.rng, 0, (Math.PI * 2) / n);
      for (let i = 0; i < n; i++) {
        const a = a0 + (Math.PI * 2 * i) / n;
        this.addPellet(Math.cos(a) * r, Math.sin(a) * r, true, 0, -1);
      }
    }
  }

  private cellOf(x: number, y: number): number {
    // Offset so negative coords do not collide with positive ones.
    const cx = Math.floor(x / CELL) + 512;
    const cy = Math.floor(y / CELL) + 512;
    return cy * 1024 + cx;
  }

  private addPellet(x: number, y: number, food: boolean, v: number, c: number): Pellet {
    const p: Pellet = { id: this.nextId++, x, y, food, v, c };
    this.pellets.set(p.id, p);
    const k = this.cellOf(x, y);
    let set = this.grid.get(k);
    if (!set) this.grid.set(k, (set = new Set()));
    set.add(p.id);
    return p;
  }

  private removePellet(p: Pellet): void {
    this.pellets.delete(p.id);
    this.grid.get(this.cellOf(p.x, p.y))?.delete(p.id);
  }

  /** Scatter `mass` into `n` pellets around a point, tagged with a colour. */
  private spill(x: number, y: number, mass: number, n: number, c: number, spread: number): void {
    if (mass <= 0) return;
    const each = mass / n;
    for (let i = 0; i < n; i++) {
      const a = randFloat(this.rng, 0, Math.PI * 2);
      const d = randFloat(this.rng, spread * 0.3, spread);
      const p = this.clampToDish(x + Math.cos(a) * d, y + Math.sin(a) * d, PELLET_R);
      this.addPellet(p.x, p.y, false, each, c);
    }
  }

  private clampToDish(x: number, y: number, r: number): { x: number; y: number } {
    const d = Math.hypot(x, y);
    const max = this.mode.dishR - r;
    if (d <= max || d === 0) return { x, y };
    const k = max / d;
    return { x: x * k, y: y * k };
  }

  /**
   * What a food pellet is worth right now: 1 at the whistle, mode.bloomMax at
   * the end. Pure function of the clock — no state, nothing to sync, and it is
   * what keeps an early lead from meaning anything.
   */
  bloom(): number {
    const f = Math.min(1, Math.max(0, this.t / this.mode.secs));
    return 1 + (this.mode.bloomMax - 1) * f;
  }

  /** Seconds left in the round. */
  remaining(): number {
    return Math.max(0, this.mode.secs - this.t);
  }

  /** This step's service order. See `serveOrder`. */
  private order(): number[] {
    return serveOrder(this.blobs.length, this.turn);
  }

  /** Blobs sorted by mass, biggest first. Ghosts sort last. */
  standings(): Blob[] {
    return [...this.blobs].sort((a, b) => this.score(b) - this.score(a));
  }

  /** What a blob is worth on the board right now. A ghost is worth nothing. */
  score(b: Blob): number {
    return b.ghost > 0 ? 0 : b.mass;
  }

  // ── intent ────────────────────────────────────────────────────────────────

  /**
   * Point blob `i` at a heading and optionally ask it to dash. `ax,ay` need not
   * be normalised; (0,0) means drift. Called by the player's input, by bot.ts,
   * and by the balance sim — one door in.
   */
  setIntent(i: number, ax: number, ay: number, dash: boolean): void {
    const b = this.blobs[i];
    if (!b || b.ghost > 0) return;
    const d = Math.hypot(ax, ay);
    if (d > 0) {
      b.ax = ax / d;
      b.ay = ay / d;
    } else {
      b.ax = 0;
      b.ay = 0;
    }
    if (dash) this.tryDash(b);
  }

  private tryDash(b: Blob): void {
    if (b.dashCd > 0 || b.dashT > 0 || b.mass < DASH_MIN_MASS) return;
    if (b.ax === 0 && b.ay === 0) return; // a dash needs a direction
    const cost = b.mass * T.DASH_COST;
    b.mass -= cost;
    b.stats.fed += cost;
    b.dashT = T.DASH_DUR;
    b.dashCd = T.DASH_DUR + T.DASH_CD;

    // An IMPULSE, not a target speed. Ramping up to the burst through ACCEL ate
    // most of the burst before it did anything, which is a large part of why the
    // first baseline could not catch anybody: chasing simply did not work, so
    // nothing was ever swallowed and the round was a farming contest.
    const v = speedOf(b.mass) * T.DASH_MULT;
    b.vx = b.ax * v;
    b.vy = b.ay * v;

    // The spend lands BEHIND you — in the lap of whoever you are chasing. This
    // is the whole negative-feedback loop in one line: hunting feeds the hunted.
    const r = radiusOf(b.mass);
    this.spill(b.x - b.ax * r * 1.3, b.y - b.ay * r * 1.3, cost, T.DASH_SPILL_N, b.i, r * 0.9);
    this.events.push({ k: 'dash', i: b.i, x: b.x, y: b.y });
  }

  // ── step ──────────────────────────────────────────────────────────────────

  /** Advance by exactly `dt` seconds. */
  step(dt: number): void {
    if (this.over) return;

    this.t += dt;
    if (this.t >= this.mode.secs) {
      this.t = this.mode.secs;
      this.over = true;
    }

    const step = Math.floor(this.bloom());
    if (step > this.bloomStep) {
      this.bloomStep = step;
      this.events.push({ k: 'bloom', v: step });
    }

    this.turn = (this.turn + 1) % Math.max(1, this.blobs.length);
    for (const oi of this.order()) {
      const b = this.blobs[oi];
      if (b.ghost > 0) {
        b.ghost -= dt;
        if (b.ghost <= 0) this.respawn(b);
        continue;
      }

      if (b.dashCd > 0) b.dashCd -= dt;
      if (b.dashT > 0) b.dashT -= dt;

      // Decay. Specks are exempt — a respawn must not feel like drowning.
      const over = b.mass - DECAY_FREE;
      if (over > 0) b.mass = Math.max(DECAY_FREE, b.mass - over * T.DECAY_K * dt);

      const dashing = b.dashT > 0;
      const want = speedOf(b.mass) * (dashing ? T.DASH_MULT : 1);
      const k = Math.min(1, T.ACCEL * (dashing ? DASH_STEER : 1) * dt);
      b.vx += (b.ax * want - b.vx) * k;
      b.vy += (b.ay * want - b.vy) * k;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // The dish wall. Kill the outward velocity too, or a blob held against the
      // rim keeps its stored speed and slingshots the moment it turns away.
      const r = radiusOf(b.mass);
      const d = Math.hypot(b.x, b.y);
      const max = this.mode.dishR - r;
      if (d > max && d > 0) {
        const nx = b.x / d;
        const ny = b.y / d;
        b.x = nx * max;
        b.y = ny * max;
        const radial = b.vx * nx + b.vy * ny;
        if (radial > 0) {
          b.vx -= radial * nx;
          b.vy -= radial * ny;
        }
      }

      this.eatPellets(b);
      if (b.mass > b.stats.peak) b.stats.peak = b.mass;
    }

    this.eatBlobs();
    this.topUpFood();
  }

  private eatPellets(b: Blob): void {
    const r = radiusOf(b.mass);
    const reach = r + PELLET_R * 0.5;
    const c0x = Math.floor((b.x - reach) / CELL);
    const c1x = Math.floor((b.x + reach) / CELL);
    const c0y = Math.floor((b.y - reach) / CELL);
    const c1y = Math.floor((b.y + reach) / CELL);
    const bloom = this.bloom();

    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const set = this.grid.get((cy + 512) * 1024 + (cx + 512));
        if (!set || set.size === 0) continue;
        for (const id of [...set]) {
          const p = this.pellets.get(id);
          if (!p) continue;
          if (Math.hypot(p.x - b.x, p.y - b.y) > reach) continue;
          const v = p.food ? bloom : p.v;
          b.mass += v;
          b.stats.pellets++;
          this.removePellet(p);
          this.events.push({ k: 'pellet', i: b.i, x: p.x, y: p.y, v, food: p.food });
        }
      }
    }
  }

  private eatBlobs(): void {
    // Same rotation as step(): whoever is served first wins a swallow that two
    // blobs could both have made this step.
    const seats = this.order();
    for (const i of seats) {
      const a = this.blobs[i];
      if (a.ghost > 0) continue;
      for (const j of seats) {
        if (i === j) continue;
        const v = this.blobs[j];
        if (v.ghost > 0) continue;
        if (!canEat(a.mass, v.mass)) continue;
        const ra = radiusOf(a.mass);
        const rv = radiusOf(v.mass);
        if (Math.hypot(a.x - v.x, a.y - v.y) + rv * T.ENGULF > ra) continue;
        this.swallow(a, v);
      }
    }
  }

  /** `a` eats `v`. Exposed so the netcode can apply a victim's concede message. */
  swallow(a: Blob, v: Blob): void {
    if (a.ghost > 0 || v.ghost > 0) return;
    const mass = v.mass;
    const banked = mass * T.ABSORB;
    a.mass += banked;
    a.stats.swallows++;
    a.stats.biggest = Math.max(a.stats.biggest, mass);
    if (a.mass > a.stats.peak) a.stats.peak = a.mass;

    v.stats.timesEaten++;
    v.stats.fed += mass - banked;
    // The remainder sprays across the dish. Killing the leader does not crown
    // you — it spills the leader's lead into the water for everyone nearby.
    this.spill(v.x, v.y, mass - banked, T.SCATTER_N, v.i, radiusOf(mass) * 1.6);

    v.mass = START_MASS;
    v.vx = 0;
    v.vy = 0;
    v.dashT = 0;
    v.dashCd = 0;
    v.ghost = RESPAWN_S;
    this.events.push({ k: 'eat', i: a.i, j: v.i, x: v.x, y: v.y, mass });
  }

  /**
   * A player left the room. Their blob dissolves into food and is parked.
   *
   * Dissolving rather than deleting: it reads as an in-world event instead of a
   * disconnect, it is a windfall for whoever was near them, and their mass stays
   * in the economy rather than evaporating out of it mid-round.
   */
  dissolve(i: number): void {
    const b = this.blobs[i];
    if (!b) return;
    if (b.ghost <= 0 && b.mass > START_MASS) {
      this.spill(b.x, b.y, b.mass, SCATTER_ON_LEAVE, b.i, radiusOf(b.mass) * 2);
      this.events.push({ k: 'eat', i: b.i, j: b.i, x: b.x, y: b.y, mass: b.mass });
    }
    b.mass = START_MASS;
    b.vx = 0;
    b.vy = 0;
    // Parked, not dead: never respawns, never scores, never eats anyone.
    b.ghost = Number.POSITIVE_INFINITY;
    b.left = true;
  }

  /** Put a ghost back in the dish, as far from danger as we can find. */
  private respawn(b: Blob): void {
    b.ghost = 0;
    b.mass = START_MASS;
    b.vx = 0;
    b.vy = 0;
    let best = { x: 0, y: 0 };
    let bestD = -1;
    for (let s = 0; s < 12; s++) {
      const r = Math.sqrt(this.rng()) * this.mode.dishR * 0.9;
      const a = randFloat(this.rng, 0, Math.PI * 2);
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      let near = Infinity;
      for (const o of this.blobs) {
        if (o.i === b.i || o.ghost > 0) continue;
        // Only blobs that could actually eat us make a spot dangerous.
        if (!canEat(o.mass, START_MASS)) continue;
        near = Math.min(near, Math.hypot(o.x - x, o.y - y) - radiusOf(o.mass));
      }
      if (near > bestD) {
        bestD = near;
        best = { x, y };
      }
    }
    b.x = best.x;
    b.y = best.y;
    this.events.push({ k: 'spawn', i: b.i, x: b.x, y: b.y });
  }

  /** Keep the dish stocked. Food is the faucet; everything else is a transfer. */
  private topUpFood(): void {
    let food = 0;
    for (const p of this.pellets.values()) if (p.food) food++;
    // A few per step at most — a burst would carpet the dish after a big kill.
    for (let i = 0; i < 3 && food < this.mode.food; i++, food++) {
      const r = Math.sqrt(this.rng()) * this.mode.dishR * 0.94;
      const a = randFloat(this.rng, 0, Math.PI * 2);
      this.addPellet(Math.cos(a) * r, Math.sin(a) * r, true, 0, -1);
    }
  }

  // ── netcode surface ───────────────────────────────────────────────────────

  /** Replace the whole pellet field (host → peer resync, and host takeover). */
  setPellets(list: Pellet[]): void {
    this.pellets.clear();
    this.grid.clear();
    let max = 0;
    for (const p of list) {
      this.pellets.set(p.id, p);
      const k = this.cellOf(p.x, p.y);
      let set = this.grid.get(k);
      if (!set) this.grid.set(k, (set = new Set()));
      set.add(p.id);
      if (p.id > max) max = p.id;
    }
    // A promoted host must keep minting ids ABOVE anything already in the dish,
    // or its first new pellet silently overwrites one of the old host's.
    this.nextId = Math.max(this.nextId, max + 1);
  }

  pelletList(): Pellet[] {
    return [...this.pellets.values()];
  }

  /** Drop pellets by id (host → peer delta). */
  dropPellets(ids: number[]): void {
    for (const id of ids) {
      const p = this.pellets.get(id);
      if (p) this.removePellet(p);
    }
  }

  /** Add pellets wholesale (host → peer delta). */
  addPellets(list: Pellet[]): void {
    for (const p of list) {
      if (this.pellets.has(p.id)) continue;
      this.pellets.set(p.id, p);
      const k = this.cellOf(p.x, p.y);
      let set = this.grid.get(k);
      if (!set) this.grid.set(k, (set = new Set()));
      set.add(p.id);
      if (p.id >= this.nextId) this.nextId = p.id + 1;
    }
  }
}

/**
 * Seat indices, rotated `turn` places, so no seat is permanently served first.
 *
 * This is a MEASURED fairness fix, not tidiness. Iterating `blobs` in index
 * order meant blob 0 reached every contested pellet first and won every
 * simultaneous swallow — every step, all round. Over 800 sim rounds that was
 * worth about six points of win rate, trending monotonically by seat index
 * (19.4% down to 13.5% against a 16.7% chance; chi-square p ~ 0.02, and ~0.37
 * after this fix).
 *
 * A rotation rather than a shuffle: no rng (so it costs nothing and cannot
 * perturb the dish's stream), no allocation churn, and it distributes the
 * first-mover advantage EXACTLY evenly rather than merely in expectation.
 *
 * It is a top-level pure function purely so it can be tested directly. The seat
 * sweep in balance.test.ts CANNOT catch this: the bias is worth ~3 points of
 * deviation and any per-seat threshold loose enough to be stable is loose enough
 * to miss it. Reverting the rotation left the whole balance suite green. So the
 * mechanism gets its own test — see tests/game.test.ts.
 */
export function serveOrder(n: number, turn: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push((k + turn) % n);
  return out;
}

/** Can a blob of mass `a` swallow one of mass `v`? Asymmetric by construction:
 *  of any two blobs at most one can ever be the eater, so an eat is never a
 *  race and the victim can be the one who decides it happened. */
export function canEat(a: number, v: number): boolean {
  return a >= v * T.EAT_RATIO;
}
