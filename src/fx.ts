// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * fx.ts — the juice layer: particles, screen shake, hit-stop, and the palette.
 *
 * All of it degrades under `prefers-reduced-motion` rather than disappearing —
 * a player who asked for less motion still needs to know they were just eaten.
 */

/**
 * Okabe–Ito, the standard deuteranopia/protanopia-safe qualitative set, plus a
 * neutral grey for the eighth seat.
 *
 * Colour is never load-bearing here: the only thing a player must read to
 * survive is who is BIGGER, and that is geometry. Colour just says who.
 */
export const COLORS = [
  '#e69f00', // orange
  '#56b4e9', // sky
  '#009e73', // green
  '#f0e442', // yellow
  '#0072b2', // blue
  '#d55e00', // vermillion
  '#cc79a7', // rose
  '#999999', // grey
];

export const colorOf = (i: number): string => COLORS[((i % COLORS.length) + COLORS.length) % COLORS.length];

export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  c: string;
}

export interface Fx {
  /** A puff of `n` particles. */
  burst(x: number, y: number, n: number, c: string, speed: number, r?: number): void;
  /** An expanding ring — respawns, blooms. */
  ring(x: number, y: number, c: string, r: number): void;
  /** Kick the camera. `mag` is in screen pixels. */
  shake(mag: number): void;
  /** Freeze the world for `s` seconds. The frame that makes a swallow land. */
  stop(s: number): void;
  /** Seconds of hit-stop still owed. The loop skips sim steps while > 0. */
  stopped(): number;
  step(dt: number): void;
  /** Current camera offset from shake. */
  offset(): { x: number; y: number };
  draw(ctx: CanvasRenderingContext2D): void;
  particles(): number;
}

interface Ring {
  x: number;
  y: number;
  c: string;
  life: number;
  max: number;
  r: number;
}

export function createFx(): Fx {
  const parts: Particle[] = [];
  const rings: Ring[] = [];
  let shakeMag = 0;
  let shakeX = 0;
  let shakeY = 0;
  let hitStop = 0;
  const reduced = reducedMotion();

  /** Particles are the first thing to sacrifice on a slow phone. */
  const CAP = 420;

  return {
    burst(x, y, n, c, speed, r = 3) {
      const count = reduced ? Math.ceil(n * 0.3) : n;
      for (let i = 0; i < count && parts.length < CAP; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = speed * (0.35 + Math.random() * 0.65);
        const max = 0.25 + Math.random() * 0.45;
        parts.push({
          x,
          y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          life: max,
          max,
          r: r * (0.6 + Math.random() * 0.8),
          c,
        });
      }
    },

    ring(x, y, c, r) {
      rings.push({ x, y, c, life: 0.5, max: 0.5, r });
    },

    shake(mag) {
      if (reduced) return;
      shakeMag = Math.min(28, shakeMag + mag);
    },

    stop(s) {
      // Hit-stop is a timing device, not decoration — reduced-motion keeps it,
      // just shorter. Removing it entirely would change the game's feel more
      // than any particle.
      hitStop = Math.max(hitStop, reduced ? s * 0.4 : s);
    },

    stopped: () => hitStop,

    step(dt) {
      if (hitStop > 0) hitStop = Math.max(0, hitStop - dt);

      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life -= dt;
        if (p.life <= 0) {
          // Swap-remove: order is irrelevant and splice would be O(n) each.
          parts[i] = parts[parts.length - 1];
          parts.pop();
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const drag = 1 - Math.min(1, 3.2 * dt);
        p.vx *= drag;
        p.vy *= drag;
      }

      for (let i = rings.length - 1; i >= 0; i--) {
        rings[i].life -= dt;
        if (rings[i].life <= 0) {
          rings[i] = rings[rings.length - 1];
          rings.pop();
        }
      }

      shakeMag *= 1 - Math.min(1, 7 * dt);
      if (shakeMag < 0.2) shakeMag = 0;
      shakeX = (Math.random() * 2 - 1) * shakeMag;
      shakeY = (Math.random() * 2 - 1) * shakeMag;
    },

    offset: () => ({ x: shakeX, y: shakeY }),

    draw(ctx) {
      for (const p of parts) {
        const a = p.life / p.max;
        ctx.globalAlpha = a * a;
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.4 + a * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
      for (const r of rings) {
        const a = r.life / r.max;
        ctx.globalAlpha = a * 0.7;
        ctx.strokeStyle = r.c;
        ctx.lineWidth = 2 + a * 3;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r * (1 + (1 - a) * 1.8), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },

    particles: () => parts.length,
  };
}
