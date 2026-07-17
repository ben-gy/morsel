/**
 * takeover.test.ts — CONTRACT GATE: the host leaving must not freeze the round.
 *
 * This is the automated half of the gate (the other half is closing the host tab
 * in a two-tab smoke test). It exists because rhythm-relay shipped with host
 * transfer impossible-by-construction — `createNet` was called with no
 * `onHostChange` — and every test was green.
 *
 * The design that makes this testable at all: `createSession` takes an optional
 * `net`, so the whole thing can be exercised with no network, no relay and no
 * browser. Promotion is `setHost(true)`, which is exactly what net.ts's
 * `onHostChange` calls.
 *
 * What must be true:
 *   before promotion — a client does NOT drive the shared world (no bots, no
 *     pellet spawning, no clock; it defers to 'w').
 *   after promotion  — it does, and the round can still REACH game-over. A
 *     survivor stuck on a frozen board is the failure this gate is named after.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSession, type SessionSeat } from '../src/net-game';
import { Game, type Seat } from '../src/game';
import { MODES } from '../src/modes';
import type { Net, PeerId } from '../src/engine/net';

/**
 * A Net that is connected to nothing. The session under test is the only peer
 * that exists; nobody answers, which is precisely the situation a peer is in one
 * millisecond after the host's tab closes.
 */
function silentNet(
  selfId: PeerId,
  host: PeerId | null,
  sent?: Record<string, unknown[]>,
): Net {
  return {
    selfId,
    peers: () => [selfId],
    host: () => host,
    isHost: () => host === selfId,
    hostSettled: () => host !== null,
    count: () => 1,
    channel: <T>(name: string) => {
      const send = ((d: T) => {
        if (sent) (sent[name] ??= []).push(d);
      }) as ((d: T, to?: PeerId | PeerId[]) => void) & { off: () => void };
      send.off = () => {};
      return send;
    },
    ping: async () => 0,
    leave: async () => {},
  };
}

const seats = (n: number): Seat[] =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i}`, bot: i > 0 }));

const sseats = (n: number): SessionSeat[] =>
  Array.from({ length: n }, (_, i) => (i === 0 ? { id: 'me', bot: false } : { bot: true }));

function mk(isHost: boolean) {
  const mode = MODES.skirmish;
  const g = new Game({ seed: 5, mode, seats: seats(mode.seats) });
  const onEnd = vi.fn();
  const onHostChange = vi.fn();
  const sent: Record<string, unknown[]> = {};
  const s = createSession({
    game: g,
    me: 0,
    seats: sseats(mode.seats),
    net: silentNet('me', isHost ? 'me' : 'other', sent),
    host: isHost,
    seed: 5,
    onEnd,
    onHostChange,
  });
  return { g, s, onEnd, onHostChange, mode, sent };
}

/** Drive `secs` of wall clock through the session, as rAF + the HUD timer would. */
function pump(s: { pump: (n: number) => void }, from: number, secs: number, stepMs = 16): number {
  let t = from;
  const end = from + secs * 1000;
  while (t < end) {
    s.pump(t);
    t += stepMs;
  }
  s.pump(t);
  return t;
}

describe('before promotion, a client does not drive the shared world', () => {
  it('does not run the bots — they would be in two places at once', () => {
    const { g, s } = mk(false);
    const bot = g.blobs[1];
    const at = { x: bot.x, y: bot.y };
    pump(s, 1000, 3);
    // The client never sets a bot's intent, so the bot only carries whatever
    // velocity it had: none. Its pose is the host's to send on 'w'.
    expect(bot.ax).toBe(0);
    expect(bot.ay).toBe(0);
    expect(bot.x).toBe(at.x);
    expect(bot.y).toBe(at.y);
  });

  it('does not own the clock — it waits to be told', () => {
    const { g, s } = mk(false);
    pump(s, 1000, 5);
    // The local sim still ticks (that is the prediction), but the client never
    // overwrites g.t from its own wall clock the way a host does. A guest that
    // trusted its own clock could call the whistle early and disagree.
    const drift = Math.abs(g.t - 5);
    expect(drift).toBeLessThan(0.6);
  });
});

describe('after promotion, the survivor takes over and the round can finish', () => {
  it('setHost(true) makes it host', () => {
    const { s, onHostChange } = mk(false);
    expect(s.isHost()).toBe(false);
    s.setHost(true);
    expect(s.isHost()).toBe(true);
    expect(onHostChange).toHaveBeenCalledWith(true);
  });

  it('starts driving the bots the moment it is promoted', () => {
    const { g, s } = mk(false);
    pump(s, 1000, 2);
    const bot = g.blobs[1];
    expect(bot.ax === 0 && bot.ay === 0).toBe(true);

    s.setHost(true);
    pump(s, 1000 + 2000, 2);
    // A promoted host runs the bots: they now have a heading and have moved.
    const moving = g.blobs.slice(1).some((b) => b.ax !== 0 || b.ay !== 0);
    expect(moving).toBe(true);
  });

  it('starts BROADCASTING the world — the duty that actually transfers', () => {
    // This is the assertion that catches a broken takeover. Verified by
    // mutation: make setHost a no-op and this goes red.
    //
    // The obvious-looking assertions do NOT catch it, which is worth knowing:
    // "the round still reaches game-over" and "pellets still spawn" both stay
    // green with promotion completely broken, because every peer runs the full
    // sim locally. That is a real robustness win (see the freeze test below) and
    // it is exactly why it would have hidden the bug. Narrating the world is the
    // one thing only a host does.
    const { s, sent } = mk(false);
    pump(s, 1000, 3);
    expect(sent.w ?? [], 'a guest must never narrate the world').toHaveLength(0);

    s.setHost(true);
    pump(s, 4000, 3);
    expect((sent.w ?? []).length, 'a promoted host must broadcast').toBeGreaterThan(0);
  });

  it('the round can still REACH game-over after the host vanishes', () => {
    const { g, s, onEnd, mode } = mk(false);
    let t = pump(s, 1000, 5);
    expect(g.over).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();

    s.setHost(true);
    // A survivor must be able to run the round out — never a frozen board.
    t = pump(s, t, mode.secs + 2);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
    void t;
  });

  it('cannot freeze even if NOBODY is ever promoted', () => {
    // The stronger property that falls out of every-peer-predicts: an orphaned
    // guest still reaches the whistle and still gets its summary. No player is
    // ever left staring at a dead dish, promotion or not.
    const { g, s, onEnd, mode } = mk(false);
    pump(s, 1000, mode.secs + 2);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('re-anchors the clock so the round keeps its REMAINING time', () => {
    // The bug this guards: a naive takeover restarts the clock from zero and the
    // survivor plays a whole extra round on their own.
    const { g, s, mode } = mk(false);
    // Fast-forward the guest's local sim to near the end.
    g.t = mode.secs - 4;
    const t = pump(s, 1000, 0.1);
    s.setHost(true);
    pump(s, t, 6);
    expect(g.over).toBe(true);
  });

  it('a promoted host spawns pellets again', () => {
    const { g, s } = mk(false);
    // Strip the dish bare, as if the old host had never topped it up.
    g.setPellets([]);
    expect(g.pelletList()).toHaveLength(0);
    s.setHost(true);
    pump(s, 1000, 3);
    expect(g.pelletList().length).toBeGreaterThan(0);
  });

  it('demotion is honoured too — two hosts must never both narrate', () => {
    const { s, onHostChange } = mk(true);
    expect(s.isHost()).toBe(true);
    s.setHost(false);
    expect(s.isHost()).toBe(false);
    expect(onHostChange).toHaveBeenCalledWith(false);
  });

  it('setHost is idempotent — a repeated announce must not re-anchor the clock', () => {
    const { s, onHostChange } = mk(false);
    s.setHost(true);
    s.setHost(true);
    s.setHost(true);
    expect(onHostChange).toHaveBeenCalledTimes(1);
  });
});

describe('a peer leaving degrades, never freezes', () => {
  it("dissolves the leaver's blob into food rather than deleting them", () => {
    const mode = MODES.skirmish;
    const g = new Game({ seed: 5, mode, seats: seats(mode.seats) });
    const s = createSession({
      game: g,
      me: 0,
      seats: [{ id: 'me', bot: false }, { id: 'them', bot: false }, ...sseats(mode.seats).slice(2)],
      net: silentNet('me', 'me'),
      host: true,
      seed: 5,
      onEnd: vi.fn(),
    });
    g.blobs[1].mass = 300;
    const pelletsBefore = g.pelletList().length;

    s.onPeerLeave('them');

    expect(g.blobs[1].left).toBe(true);
    expect(g.score(g.blobs[1])).toBe(0);
    // Their mass went into the dish — free food, not evaporation.
    expect(g.pelletList().length).toBeGreaterThan(pelletsBefore);
  });

  it('ignores a leave from someone who was never seated', () => {
    const { g, s } = mk(true);
    const before = g.blobs.map((b) => b.left);
    s.onPeerLeave('a-stranger');
    expect(g.blobs.map((b) => b.left)).toEqual(before);
  });

  it('the round still ends after everyone else has gone', () => {
    // Solo-complete, the hard way: a host alone in a room must still finish.
    const { g, s, onEnd, mode } = mk(true);
    pump(s, 1000, mode.secs + 2);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('solo is the same code path', () => {
  // rhythm-relay broke because its co-op shape got bespoke netcode with no host
  // transfer. Solo here is just a Session with no net, so it cannot drift.
  it('runs with no net at all and reaches the whistle', () => {
    const mode = MODES.skirmish;
    const g = new Game({ seed: 9, mode, seats: seats(mode.seats) });
    const onEnd = vi.fn();
    const s = createSession({
      game: g,
      me: 0,
      seats: sseats(mode.seats),
      seed: 9,
      onEnd,
    });
    expect(s.isHost()).toBe(true); // solo is always its own authority
    pump(s, 0, mode.secs + 2);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
    // ...and it was a real game, not an empty dish.
    expect(g.blobs.some((b) => b.stats.pellets > 0)).toBe(true);
  });

  it('the local player can act, and the bots play against them', () => {
    const mode = MODES.skirmish;
    const g = new Game({ seed: 9, mode, seats: seats(mode.seats) });
    const s = createSession({
      game: g,
      me: 0,
      seats: sseats(mode.seats),
      seed: 9,
      onEnd: vi.fn(),
    });
    s.intent(1, 0, false);
    pump(s, 0, 2);
    expect(g.blobs[0].ax).toBeCloseTo(1, 3);
    expect(g.blobs.slice(1).some((b) => b.stats.pellets > 0)).toBe(true);
  });
});
