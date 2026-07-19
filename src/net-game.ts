/**
 * net-game.ts — one Session drives a round, solo or peer-to-peer.
 *
 * ONE path, deliberately. rhythm-relay shipped broken because its co-op shape
 * got its own bespoke netcode that never had host transfer wired into it. So
 * solo here is simply "a Session whose net is undefined and whose seats are all
 * bots" — it is the same code, and it cannot drift away from the multiplayer one.
 *
 * ── who owns what ───────────────────────────────────────────────────────────
 *
 * Split authority, one owner per concern, so nothing is ever contested:
 *
 *   EVERY PEER owns its own blob's MOTION and its own DEATH. You die when YOUR
 *     screen says you were caught — never because the host's copy of you lagged
 *     into somebody's mouth. In a game whose whole subject is being eaten, dying
 *     to another machine's latency is the one unforgivable outcome.
 *
 *   THE HOST owns the shared world: the pellet field, the bot blobs, the round
 *     clock and the mass ledger. It broadcasts them; peers correct toward them.
 *
 * The eat rule is asymmetric (`canEat` needs a 1.15x edge), so of any two blobs
 * at most one can ever be the eater. That is what makes victim-authority safe:
 * an eat is never a race, so there is nothing to arbitrate.
 *
 * ── prediction ──────────────────────────────────────────────────────────────
 *
 * Every peer runs the FULL sim locally, including bots and pellets. The host's
 * 'w' is a correction, not a source of truth to wait for. So the dish never
 * stutters at 12Hz, and — the reason this matters far more than smoothness — a
 * promoted host already holds a complete, live world. Taking over is "start
 * broadcasting", not "reconstruct the game from a snapshot".
 *
 * ── the clock ───────────────────────────────────────────────────────────────
 *
 * The round's end is derived from WALL CLOCK, never from accumulated rAF steps.
 * A backgrounded tab pauses rAF; if the round's end lived in the step loop, a
 * host that glanced at another tab would hang everyone else's round forever.
 */

import { Game, canEat, radiusOf, type Pellet } from './game';
import { botIntent, personalities, BOT_HZ, type Personality } from './bot';
import { makeRng } from '@ben-gy/game-engine/rng';
import type { Net, PeerId } from '@ben-gy/game-engine/net';

/** Host -> all: the shared world. */
interface WorldMsg {
  /** Round seconds elapsed, host-authoritative. */
  t: number;
  /** Mass per seat. */
  m: number[];
  /** Ghost seconds per seat — 0 = alive. */
  g: number[];
  /** Bot poses: [seat, x, y] triples, flattened. */
  a: number[];
  /** Pellet ids removed since the last 'w'. */
  rm: number[];
  /** Pellets added: [id, x, y, food?1:0, v, c] sextuples, flattened. */
  ad: number[];
  /** 1 = `ad` is the WHOLE field, replace rather than merge. */
  fl?: 1;
}

/** Peer -> all: I am here, this is where I am. */
interface PoseMsg {
  i: number;
  x: number;
  y: number;
  /** Dashing right now — peers render the streak without waiting for 'w'. */
  d?: 1;
}

/** Victim -> all: I concede. */
interface AteMsg {
  /** Victim seat. */
  v: number;
  /** Eater seat. */
  e: number;
}

export interface SessionSeat {
  /** Peer id for a human seat; undefined for a bot. */
  id?: PeerId;
  bot: boolean;
}

export interface SessionCfg {
  game: Game;
  /** The local player's seat, or -1 for a pure spectator. */
  me: number;
  /** Index-aligned with game.blobs. */
  seats: SessionSeat[];
  /** Absent = solo. */
  net?: Net;
  /** True if this peer starts the round as host. Ignored when solo. */
  host?: boolean;
  /** Shared seed — bots must not diverge from the dish. */
  seed: number;
  /** Fires once, on every peer, when the round is over. */
  onEnd: () => void;
  /** A peer was promoted/demoted, so the UI can say so. */
  onHostChange?: (isHost: boolean) => void;
}

export interface Session {
  /** Advance to `nowMs`. Called by rAF AND by the keepalive interval. */
  pump(nowMs: number): void;
  /** The local player's input for this frame. */
  intent(ax: number, ay: number, dash: boolean): void;
  /**
   * Host transfer. Wire this to net.onHostChange — a live-P2P game that calls
   * createNet without it is broken by construction.
   */
  setHost(isHost: boolean): void;
  /** A peer left: their blob dissolves into food. */
  onPeerLeave(id: PeerId): void;
  isHost(): boolean;
  /** Seconds of hit-stop owed, so the caller can freeze the sim. */
  destroy(): void;
}

/** Host broadcast rate. */
const W_HZ = 12;
/** Peer pose rate. */
const P_HZ = 15;
/** Full pellet-field resync interval, ms. Heals joiners and packet loss. */
const RESYNC_MS = 2500;
/** Cap sim catch-up so a stalled tab cannot spiral. */
const MAX_STEP = 1 / 60;
const MAX_CATCHUP = 8;

export function createSession(cfg: SessionCfg): Session {
  const { game: g, me, seats, net } = cfg;
  let host = net ? !!cfg.host : true;

  const brng = makeRng(cfg.seed ^ 0x5bf03635);
  const persons: Personality[] = personalities(brng, seats.length);
  const seatOf = new Map<PeerId, number>();
  for (const [i, s] of seats.entries()) if (s.id) seatOf.set(s.id, i);

  let started = 0;
  let acc = 0;
  let last = 0;
  let botAcc = 0;
  let wAcc = 0;
  let pAcc = 0;
  let resyncAcc = 0;
  let ended = false;
  /** Local player's intent for this step. */
  let ax = 0;
  let ay = 0;
  let dash = false;
  /** Pellet churn since the last 'w', host only. */
  const rm: number[] = [];
  const ad: number[] = [];
  let lastIds = new Set<number>();

  // ── wire ──────────────────────────────────────────────────────────────────

  const sendW = net?.channel<WorldMsg>('w', (msg, from) => {
    // Only the elected host may narrate the world. Without this check a stale
    // message from a demoted peer would fight the real host for the ledger.
    if (host || from !== net.host()) return;
    applyWorld(msg);
  });

  const sendP = net?.channel<PoseMsg>('p', (msg, from) => {
    const i = seatOf.get(from);
    // A peer may only ever move its OWN blob.
    if (i == null || i !== msg.i || i === me) return;
    const b = g.blobs[i];
    if (!b) return;
    b.x = msg.x;
    b.y = msg.y;
    if (msg.d) b.dashT = Math.max(b.dashT, 0.12);
  });

  const sendAte = net?.channel<AteMsg>('ate', (msg, from) => {
    const claimed = seatOf.get(from);
    // Only the VICTIM concedes, and only for itself. Anything else is a peer
    // claiming a kill, which is not a thing this protocol has.
    if (claimed == null || claimed !== msg.v) return;
    applyAte(msg.v, msg.e);
  });

  function applyAte(vi: number, ei: number): void {
    const v = g.blobs[vi];
    const e = g.blobs[ei];
    if (!v || !e || v.ghost > 0) return; // already down — idempotent
    if (!canEat(e.mass, v.mass)) return; // not a legal meal; ignore
    g.swallow(e, v);
  }

  function applyWorld(msg: WorldMsg): void {
    // The clock is the host's. Snapping rather than easing is right: it is only
    // ever used for the HUD and the whistle, and a smoothed clock can disagree
    // with the host about whether the round is over.
    g.t = msg.t;

    for (const [i, b] of g.blobs.entries()) {
      if (msg.m[i] != null) b.mass = msg.m[i];
      if (msg.g[i] != null) {
        const gh = msg.g[i];
        // Never resurrect the local blob from a snapshot: we own our own death,
        // and a stale 'w' would otherwise pop us back to life for a frame.
        if (i !== me || gh > 0) b.ghost = gh;
      }
    }

    // Bot poses. The host owns them, so they are simply assigned.
    for (let k = 0; k + 2 < msg.a.length; k += 3) {
      const b = g.blobs[msg.a[k]];
      if (b) {
        b.x = msg.a[k + 1];
        b.y = msg.a[k + 2];
      }
    }

    if (msg.fl) {
      g.setPellets(unpack(msg.ad));
    } else {
      if (msg.rm.length) g.dropPellets(msg.rm);
      if (msg.ad.length) g.addPellets(unpack(msg.ad));
    }
  }

  // ── the sim ───────────────────────────────────────────────────────────────

  function bots(): void {
    // Only the host runs bots. Everyone else takes their poses off 'w', so a
    // bot cannot be in two places at once.
    if (!host) return;
    for (const [i, s] of seats.entries()) {
      if (!s.bot) continue;
      const it = botIntent(g, i, persons[i], brng);
      g.setIntent(i, it.ax, it.ay, it.dash);
    }
  }

  /** Am I inside something bigger? Then I am dead, and I say so. */
  function concede(): void {
    if (me < 0) return;
    const v = g.blobs[me];
    if (!v || v.ghost > 0) return;
    const rv = radiusOf(v.mass);
    for (const e of g.blobs) {
      if (e.i === me || e.ghost > 0) continue;
      if (!canEat(e.mass, v.mass)) continue;
      if (Math.hypot(e.x - v.x, e.y - v.y) + rv * 0.15 > radiusOf(e.mass)) continue;
      sendAte?.({ v: me, e: e.i });
      applyAte(me, e.i);
      return;
    }
  }

  function pack(list: Pellet[]): number[] {
    const out: number[] = [];
    for (const p of list) out.push(p.id, Math.round(p.x), Math.round(p.y), p.food ? 1 : 0, p.v, p.c);
    return out;
  }

  function unpack(flat: number[]): Pellet[] {
    const out: Pellet[] = [];
    for (let k = 0; k + 5 < flat.length; k += 6) {
      out.push({
        id: flat[k],
        x: flat[k + 1],
        y: flat[k + 2],
        food: flat[k + 3] === 1,
        v: flat[k + 4],
        c: flat[k + 5],
      });
    }
    return out;
  }

  function broadcast(full: boolean): void {
    if (!net || !host) return;
    const a: number[] = [];
    for (const [i, s] of seats.entries()) {
      if (!s.bot) continue;
      const b = g.blobs[i];
      a.push(i, Math.round(b.x), Math.round(b.y));
    }
    const msg: WorldMsg = {
      t: g.t,
      m: g.blobs.map((b) => Math.round(b.mass * 10) / 10),
      g: g.blobs.map((b) => Math.round(b.ghost * 100) / 100),
      a,
      rm: full ? [] : rm.splice(0),
      ad: full ? pack(g.pelletList()) : ad.splice(0),
    };
    if (full) msg.fl = 1;
    sendW?.(msg);
  }

  /** Diff the pellet field so 'w' carries a delta rather than the whole dish. */
  function trackPellets(): void {
    if (!net || !host) return;
    const now = new Set<number>();
    for (const id of g.pellets.keys()) now.add(id);
    for (const id of lastIds) if (!now.has(id)) rm.push(id);
    for (const id of now) {
      if (!lastIds.has(id)) {
        const p = g.pellets.get(id)!;
        ad.push(p.id, Math.round(p.x), Math.round(p.y), p.food ? 1 : 0, p.v, p.c);
      }
    }
    lastIds = now;
  }

  return {
    pump(nowMs) {
      if (ended) return;
      if (!started) {
        started = nowMs;
        last = nowMs;
        if (net && host) broadcast(true);
        return;
      }
      const dt = Math.min(0.25, (nowMs - last) / 1000);
      last = nowMs;

      // ── sim ────────────────────────────────────────────────────────────────
      // Identical on host and guest — everyone predicts the whole world. The
      // ONLY difference is who runs the bots, because a bot must not be in two
      // places at once.
      acc += dt;
      let steps = 0;
      while (acc >= MAX_STEP && steps < MAX_CATCHUP) {
        botAcc += MAX_STEP;
        if (botAcc >= 1 / BOT_HZ) {
          botAcc = 0;
          bots();
        }
        if (me >= 0) g.setIntent(me, ax, ay, dash);
        dash = false;
        g.step(MAX_STEP);
        concede();
        acc -= MAX_STEP;
        steps++;
      }
      if (steps >= MAX_CATCHUP) acc = 0;

      // ── the clock ──────────────────────────────────────────────────────────
      // The host derives the round clock from WALL TIME, not from how many sim
      // steps rAF managed to run. If the tab stalled and we dropped steps above,
      // the round must still end on time — for everyone.
      if (host) {
        g.t = Math.min(g.mode.secs, (nowMs - started) / 1000);
        if (g.t >= g.mode.secs) g.over = true;
      }

      // ── talk ───────────────────────────────────────────────────────────────
      if (net && me >= 0) {
        pAcc += dt;
        if (pAcc >= 1 / P_HZ) {
          pAcc = 0;
          // Everyone broadcasts their own pose, host included: 'w' only carries
          // the bots, because a peer's own blob is never the host's to describe.
          const b = g.blobs[me];
          const msg: PoseMsg = { i: me, x: Math.round(b.x), y: Math.round(b.y) };
          if (b.dashT > 0) msg.d = 1;
          sendP?.(msg);
        }
      }

      if (net && host) {
        trackPellets();
        wAcc += dt;
        if (wAcc >= 1 / W_HZ) {
          wAcc = 0;
          resyncAcc += 1 / W_HZ;
          const full = resyncAcc >= RESYNC_MS / 1000;
          if (full) resyncAcc = 0;
          broadcast(full);
        }
      }

      if (g.over && !ended) {
        ended = true;
        cfg.onEnd();
      }
    },

    intent(nx, ny, d) {
      ax = nx;
      ay = ny;
      // Sticky until consumed by a step, so a tap between frames is never lost.
      dash = dash || d;
    },

    setHost(isHost) {
      if (isHost === host) return;
      host = isHost;
      if (host) {
        // THE TAKEOVER. This peer already holds a complete live world — it has
        // been simulating all along and correcting toward the old host's 'w'.
        // So promotion is not a reconstruction: adopt what we have as canonical,
        // re-anchor the clock so the round keeps its remaining time, and start
        // narrating. Bots and the pellet spawner resume on the next pump.
        started = last - g.t * 1000;
        acc = 0;
        lastIds = new Set(g.pellets.keys());
        rm.length = 0;
        ad.length = 0;
        broadcast(true);
      }
      cfg.onHostChange?.(host);
    },

    onPeerLeave(id) {
      const i = seatOf.get(id);
      if (i == null) return;
      // Every peer does this locally, not just the host: the round must degrade
      // identically everywhere even if the host is the one who just vanished.
      g.dissolve(i);
    },

    isHost: () => host,

    destroy() {
      ended = true;
      (sendW as unknown as { off?: () => void })?.off?.();
      (sendP as unknown as { off?: () => void })?.off?.();
      (sendAte as unknown as { off?: () => void })?.off?.();
    },
  };
}
