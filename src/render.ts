/**
 * render.ts — draw the dish.
 *
 * Owns no game state. Everything here is a pure function of a Game plus a little
 * view-local easing (the wobble, the camera), so the sim stays headless and
 * testable and this file can be as impure and frame-rate-dependent as it likes.
 */

import { radiusOf, type Blob, type Game } from './game';
import { colorOf, reducedMotion, type Fx } from './fx';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** Springy outline vertices, one ring per blob. Purely cosmetic. */
interface Membrane {
  phase: number[];
}

export interface Renderer {
  /** Call on canvas resize. */
  resize(w: number, h: number, dpr: number): void;
  draw(g: Game, me: number, fx: Fx, alpha: number, dt: number): void;
  /** World coords under a CSS-pixel point — used to aim at the pointer. */
  toWorld(px: number, py: number): { x: number; y: number };
  camera(): Camera;
}

/** Vertices per membrane. 14 is where the wobble stops reading as a polygon. */
const VERTS = 14;

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d')!;
  let w = 1;
  let h = 1;
  const cam: Camera = { x: 0, y: 0, zoom: 1 };
  const membranes = new Map<number, Membrane>();
  const reduced = reducedMotion();
  let t = 0;

  const membraneOf = (i: number): Membrane => {
    let m = membranes.get(i);
    if (!m) {
      m = { phase: Array.from({ length: VERTS }, () => Math.random() * Math.PI * 2) };
      membranes.set(i, m);
    }
    return m;
  };

  /**
   * A blob outline. The wobble is what makes these read as ALIVE rather than as
   * circles — cheap (14 verts), and it is scaled by speed so a lunging blob
   * deforms into its own motion.
   */
  function blobPath(b: Blob, r: number, speed: number): void {
    const m = membraneOf(b.i);
    const wob = reduced ? 0 : Math.min(0.13, 0.04 + speed * 0.0002);
    ctx.beginPath();
    for (let i = 0; i <= VERTS; i++) {
      const k = i % VERTS;
      const a = (Math.PI * 2 * k) / VERTS;
      const wig = 1 + Math.sin(t * 3.1 + m.phase[k]) * wob;
      const x = b.x + Math.cos(a) * r * wig;
      const y = b.y + Math.sin(a) * r * wig;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  return {
    resize(nw, nh, dpr) {
      // A transient 0-size measurement (a hidden tab, a mid-layout frame) would
      // make every world coord NaN and silently eat all input. Ignore it and
      // wait for a real one.
      if (nw <= 0 || nh <= 0) return;
      w = nw;
      h = nh;
      canvas.width = Math.round(nw * dpr);
      canvas.height = Math.round(nh * dpr);
      canvas.style.width = `${nw}px`;
      canvas.style.height = `${nh}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    camera: () => cam,

    toWorld(px, py) {
      return {
        x: (px - w / 2) / cam.zoom + cam.x,
        y: (py - h / 2) / cam.zoom + cam.y,
      };
    },

    draw(g, me, fx, _alpha, dt) {
      t += dt;

      // ── camera ───────────────────────────────────────────────────────────
      const self = g.blobs[me];
      const r = self ? radiusOf(self.mass) : 10;
      // Being big literally widens your view. It is the only "you are winning"
      // feedback that never needs a number, and it doubles as the drawback:
      // the dish gets bigger and emptier-looking exactly as you get slower.
      const want = Math.max(360, r * 9);
      const zoom = Math.min(h, w) / 2 / want;
      const ease = 1 - Math.exp(-3 * dt);
      cam.zoom += (zoom - cam.zoom) * ease;
      if (self) {
        cam.x += (self.x - cam.x) * (1 - Math.exp(-9 * dt));
        cam.y += (self.y - cam.y) * (1 - Math.exp(-9 * dt));
      }

      // ── the dish ─────────────────────────────────────────────────────────
      // The background warms as the bloom ramps, so "it's getting late" is
      // something you feel rather than read off the clock.
      const heat = (g.bloom() - 1) / Math.max(0.001, g.mode.bloomMax - 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const dpr = canvas.width / w;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#070b14';
      ctx.fillRect(0, 0, w, h);

      const off = fx.offset();
      ctx.save();
      ctx.translate(w / 2 + off.x, h / 2 + off.y);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cam.x, -cam.y);

      const R = g.mode.dishR;
      const grad = ctx.createRadialGradient(0, 0, R * 0.1, 0, 0, R);
      grad.addColorStop(0, `rgba(${18 + heat * 40}, ${28 + heat * 14}, ${52 + heat * 8}, 1)`);
      grad.addColorStop(1, '#0b1220');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(120, 190, 255, ${0.18 + heat * 0.3})`;
      ctx.lineWidth = 3 / cam.zoom;
      ctx.stroke();

      // ── pellets ──────────────────────────────────────────────────────────
      // Spill is drawn in the colour of whoever bled it, so the dish tells the
      // story of the round: a trail of orange means someone chased hard and lost.
      for (const p of g.pellets.values()) {
        if (!inView(p.x, p.y, 40)) continue;
        if (p.food) {
          ctx.fillStyle = `rgba(240, 228, 66, ${0.55 + heat * 0.45})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4 + heat * 2.2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = colorOf(p.c);
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3 + Math.min(6, p.v * 0.22), 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      // ── blobs ────────────────────────────────────────────────────────────
      // Smallest first, so the thing about to eat you is drawn on top of you.
      const order = [...g.blobs].sort((a, b) => a.mass - b.mass);
      for (const b of order) {
        if (b.ghost > 0) continue;
        const br = radiusOf(b.mass);
        if (!inView(b.x, b.y, br + 20)) continue;
        const speed = Math.hypot(b.vx, b.vy);
        const c = colorOf(b.i);

        if (b.dashT > 0) {
          // A lunge streak, so a dash is legible from across the dish.
          ctx.globalAlpha = 0.28;
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.arc(b.x - b.vx * 0.06, b.y - b.vy * 0.06, br * 1.05, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        blobPath(b, br, speed);
        ctx.fillStyle = c;
        ctx.fill();

        // Nucleus: a darker core, so a blob has depth and a readable centre —
        // and the centre is what the engulf rule actually cares about.
        ctx.globalAlpha = 0.32;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(b.x, b.y, br * 0.46, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        if (b.i === me) {
          // The local blob is never identified by colour alone.
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = Math.max(2, 3 / cam.zoom);
          blobPath(b, br, speed);
          ctx.stroke();
        }

        // Name + mass, size-clamped so it stays legible at any zoom.
        const fs = Math.max(11, Math.min(20, 13 / cam.zoom));
        ctx.font = `600 ${fs}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.fillText(b.name, b.x + 1, b.y + 1);
        ctx.fillStyle = '#fff';
        ctx.fillText(b.name, b.x, b.y);
      }

      fx.draw(ctx);
      ctx.restore();

      function inView(x: number, y: number, pad: number): boolean {
        const sx = (x - cam.x) * cam.zoom + w / 2;
        const sy = (y - cam.y) * cam.zoom + h / 2;
        const p = pad * cam.zoom + 8;
        return sx > -p && sx < w + p && sy > -p && sy < h + p;
      }
    },
  };
}
