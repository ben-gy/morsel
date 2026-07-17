/**
 * bot.ts — the AI blobs that fill empty seats.
 *
 * Two jobs, and the second one is the one that matters:
 *
 *  1. A solo player must face a busy dish, and a 2-player room must not be two
 *     specks alone in a lake.
 *  2. These are the players in tests/balance.test.ts. Every claim that test makes
 *     about Morsel is really a claim about a dish full of THESE. So a bot that is
 *     stupid in a specific direction — never dashes, never flees — would quietly
 *     invalidate the balance numbers. It does not have to be a great player; it
 *     has to weigh the same trade-off a human weighs: is this dash worth it?
 *
 * Bots decide at BOT_HZ, not every step. Cheap, and it is also more honest —
 * humans do not re-plan 60 times a second, and a bot that does is superhuman at
 * dodging in a way that would flatten the balance curve for the wrong reason.
 */

import { canEat, radiusOf, START_MASS, type Blob, type Game } from './game';
import { TUNING as T } from './tuning';
import { randFloat, type Rng } from './engine/rng';

/** How many times a second a bot re-decides. */
export const BOT_HZ = 10;

export interface Personality {
  /** Scales how attractive prey looks. >1 chases things it probably shouldn't. */
  greed: number;
  /** Scales how far away a threat still scares it. */
  fear: number;
  /** Radians of jitter on its chosen heading, so bots don't move like a grid. */
  wobble: number;
}

/** Deterministic from the round seed, so a replay of a seed is a replay. */
export function personalities(rng: Rng, n: number): Personality[] {
  return Array.from({ length: n }, () => ({
    greed: randFloat(rng, 0.7, 1.35),
    fear: randFloat(rng, 0.75, 1.3),
    wobble: randFloat(rng, 0.05, 0.35),
  }));
}

export interface Intent {
  ax: number;
  ay: number;
  dash: boolean;
}

const DRIFT: Intent = { ax: 0, ay: 0, dash: false };

/**
 * Decide what bot `i` wants to do. Pure apart from `rng`, which only supplies
 * wobble — so the decision is reproducible for a given seed.
 */
export function botIntent(g: Game, i: number, p: Personality, rng: Rng): Intent {
  const me = g.blobs[i];
  if (!me || me.ghost > 0) return DRIFT;

  const rMe = radiusOf(me.mass);
  let out: Intent;

  // ── 1. run ───────────────────────────────────────────────────────────────
  // Distance is measured edge-to-edge: a big blob is scary from further away
  // because it is physically bigger, which is exactly how it reads on screen.
  let threat: Blob | null = null;
  let threatD = Infinity;
  for (const o of g.blobs) {
    if (o.i === i || o.ghost > 0 || !canEat(o.mass, me.mass)) continue;
    const d = Math.hypot(o.x - me.x, o.y - me.y) - radiusOf(o.mass);
    if (d < threatD) {
      threatD = d;
      threat = o;
    }
  }

  const panicAt = (rMe * 4 + 120) * p.fear;
  if (threat && threatD < panicAt) {
    const dx = me.x - threat.x;
    const dy = me.y - threat.y;
    const d = Math.hypot(dx, dy) || 1;
    // Running straight into the rim is how prey dies. Bias inward as the wall
    // gets close, so the flee vector curves along it instead of pinning.
    const rim = Math.hypot(me.x, me.y) / g.mode.dishR;
    const inward = rim ** 4 * 1.5;
    out = {
      ax: dx / d - (me.x / (g.mode.dishR || 1)) * inward,
      ay: dy / d - (me.y / (g.mode.dishR || 1)) * inward,
      // Burn a dash only when it is genuinely about to happen. Panic-dashing at
      // every scare feeds the hunter for nothing — the mistake a nervous human
      // makes too.
      dash: threatD < rMe * 1.5 + 60 && me.mass > START_MASS * 1.5,
    };
  } else {
    // ── 2. hunt ─────────────────────────────────────────────────────────────
    let prey: Blob | null = null;
    let preyScore = 0;
    for (const o of g.blobs) {
      if (o.i === i || o.ghost > 0 || !canEat(me.mass, o.mass)) continue;
      const d = Math.hypot(o.x - me.x, o.y - me.y);
      // Worth = what we'd bank, discounted by how far we'd have to swim. A
      // speck across the dish is not worth the trip, and the decay clock is
      // running the whole time.
      const s = ((o.mass * T.ABSORB) / (d + 200)) * p.greed;
      if (s > preyScore) {
        preyScore = s;
        prey = o;
      }
    }

    // ── 3. graze ────────────────────────────────────────────────────────────
    let bestX = 0;
    let bestY = 0;
    let bestS = 0;
    const bloom = g.bloom();
    for (const q of g.pellets.values()) {
      const d = Math.hypot(q.x - me.x, q.y - me.y);
      const v = q.food ? bloom : q.v;
      const s = v / (d + 60);
      if (s > bestS) {
        bestS = s;
        bestX = q.x;
        bestY = q.y;
      }
    }

    // A pellet is a sure thing; a chase is a gamble that costs dashes. The 0.6
    // is the bots' risk aversion — with it at 1.0 they chase constantly, dash
    // themselves to nothing and the dish turns into a farming sim by minute two.
    const chase = prey && preyScore > bestS * 0.6;
    if (chase && prey) {
      const dx = prey.x - me.x;
      const dy = prey.y - me.y;
      const d = Math.hypot(dx, dy) || 1;
      const gain = prey.mass * T.ABSORB;
      const cost = me.mass * T.DASH_COST;
      out = {
        ax: dx / d,
        ay: dy / d,
        // The trade-off the whole game is built on, in one condition: only
        // spend the lead when the catch is close enough to land AND the meal
        // beats what the dash costs.
        dash: d < rMe + radiusOf(prey.mass) + 190 && gain > cost * 1.5,
      };
    } else if (bestS > 0) {
      const dx = bestX - me.x;
      const dy = bestY - me.y;
      const d = Math.hypot(dx, dy) || 1;
      out = { ax: dx / d, ay: dy / d, dash: false };
    } else {
      // Nothing to eat and nothing to fear — wander toward the middle.
      const d = Math.hypot(me.x, me.y) || 1;
      out = { ax: -me.x / d, ay: -me.y / d, dash: false };
    }
  }

  if (p.wobble > 0) {
    const a = randFloat(rng, -p.wobble, p.wobble);
    const c = Math.cos(a);
    const s = Math.sin(a);
    return { ax: out.ax * c - out.ay * s, ay: out.ax * s + out.ay * c, dash: out.dash };
  }
  return out;
}
