/**
 * rng.test.ts — the P2P-sync determinism invariant.
 *
 * Morsel's netcode broadcasts INTENT, not truth. The opening food field and the
 * spawn ring are DERIVED from the shared seed on each peer independently; not one
 * byte of either crosses the wire at the start of a round. That is only safe
 * while two peers holding the same seed compute byte-identical results.
 *
 * If that ever stops being true the failure is silent and total: two players look
 * at different dishes while agreeing on the mass, and nothing appears broken
 * until someone eats a pellet the other player never saw. So this proves
 * determinism at both levels — the shared RNG itself, and the dish game.ts builds
 * on top of it.
 */

import { describe, expect, it } from 'vitest';
import { hashSeed, makeRng, pick, randInt, shuffle } from '../src/engine/rng';
import { Game, type Pellet, type Seat } from '../src/game';
import { MODES, MODE_LIST, type Mode } from '../src/modes';

const PETRI: Mode = MODES.petri;

// ── the generator itself ────────────────────────────────────────────────────

describe('makeRng determinism (P2P sync invariant)', () => {
  it('produces an identical stream for the same numeric seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    expect(Array.from({ length: 200 }, () => a())).toEqual(Array.from({ length: 200 }, () => b()));
  });

  it('produces an identical stream for the same string seed', () => {
    const a = makeRng('room-AB12');
    const b = makeRng('room-AB12');
    expect(Array.from({ length: 50 }, () => a())).toEqual(Array.from({ length: 50 }, () => b()));
  });

  it('diverges for different seeds', () => {
    const a = Array.from({ length: 20 }, makeRng(1));
    const b = Array.from({ length: 20 }, makeRng(2));
    expect(a).not.toEqual(b);
  });

  it('stays within [0, 1)', () => {
    const r = makeRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashSeed', () => {
  it('is stable and unsigned 32-bit', () => {
    const h = hashSeed('MORSEL-K7QP');
    expect(h).toBe(hashSeed('MORSEL-K7QP'));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });
});

describe('shuffle / randInt / pick are deterministic per seed', () => {
  it('shuffles identically across two peers, and leaves the input alone', () => {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const p1 = shuffle(makeRng('seed'), deck);
    const p2 = shuffle(makeRng('seed'), deck);
    expect(p1).toEqual(p2);
    // A true permutation, not a no-op — and the source array is untouched.
    expect([...p1].sort((x, y) => x - y)).toEqual(deck);
    expect(p1).not.toEqual(deck);
    expect(deck).toEqual(Array.from({ length: 52 }, (_, i) => i));
  });

  it('randInt stays in range and matches across peers', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    for (let i = 0; i < 100; i++) {
      const x = randInt(a, 1, 6);
      expect(randInt(b, 1, 6)).toBe(x);
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(6);
    }
  });

  it('pick agrees across peers', () => {
    const a = makeRng('x');
    const b = makeRng('x');
    const arr = ['skirmish', 'petri', 'famine', 'bloom', 'dash', 'spill'];
    expect(pick(a, arr)).toBe(pick(b, arr));
  });
});

// ── the dish: the thing two peers must literally see the same of ────────────

/** A roster is part of the shared setup — the same seats on every peer. */
function seatsOf(n: number): Seat[] {
  return Array.from({ length: n }, (_, i) => ({ name: `P${i}`, bot: i > 0 }));
}

/** Everything about a pellet a peer could disagree about. Object identity and
 *  Map internals are not the claim; these five fields are. */
const pelletKey = (p: Pellet): string => `${p.id}:${p.x}:${p.y}:${p.food}:${p.v}`;
const dishOf = (g: Game): string[] => g.pelletList().map(pelletKey);
/** Where each blob opens. A rotation of the ring is drawn from the seed. */
const spawnsOf = (g: Game): string[] => g.blobs.map((b) => `${b.i}:${b.x}:${b.y}`);

describe('the opening dish is derived, never transmitted', () => {
  it('gives two peers on the same seed a byte-identical food field', () => {
    for (const seed of [0, 1, 42, 65535, 0xffffffff]) {
      for (const mode of MODE_LIST) {
        const seats = seatsOf(mode.seats);
        const host = new Game({ seed, mode, seats });
        const peer = new Game({ seed, mode, seats });
        expect(dishOf(host)).toEqual(dishOf(peer));
        // Not an empty dish agreeing with an empty dish.
        expect(host.pelletList().length).toBeGreaterThan(0);
      }
    }
  });

  it('gives two peers on the same seed identical blob spawn positions', () => {
    // The ring phase is a random draw. Two peers disagreeing about it is two
    // peers driving blobs that stand somewhere else — every collision after the
    // whistle resolves differently.
    for (const seed of [0, 7, 4242, 0xffffffff]) {
      for (const mode of MODE_LIST) {
        const seats = seatsOf(mode.seats);
        const host = new Game({ seed, mode, seats });
        const peer = new Game({ seed, mode, seats });
        expect(spawnsOf(host)).toEqual(spawnsOf(peer));
        expect(host.blobs).toHaveLength(mode.seats);
      }
    }
  });

  it('agrees on the whole opening state, seats and dish together', () => {
    for (let seed = 0; seed < 40; seed++) {
      const seats = seatsOf(6);
      const host = new Game({ seed, mode: PETRI, seats });
      const peer = new Game({ seed, mode: PETRI, seats });
      expect({ dish: dishOf(host), spawns: spawnsOf(host) }).toEqual({
        dish: dishOf(peer),
        spawns: spawnsOf(peer),
      });
    }
  });

  it('gives different seeds different dishes', () => {
    const seen = new Set(
      Array.from({ length: 40 }, (_, s) =>
        dishOf(new Game({ seed: s * 7919 + 1, mode: PETRI, seats: seatsOf(6) })).join('|'),
      ),
    );
    // Not a strict guarantee — but 40 identical dishes would mean the seed is
    // being ignored, which is precisely the bug worth catching here.
    expect(seen.size).toBeGreaterThan(35);
  });

  it('gives different seeds different spawn rings', () => {
    const seen = new Set(
      Array.from({ length: 40 }, (_, s) =>
        spawnsOf(new Game({ seed: s * 2654435761 + 1, mode: PETRI, seats: seatsOf(6) })).join('|'),
      ),
    );
    expect(seen.size).toBeGreaterThan(35);
  });

  it('gives the same seed a different dish per mode, since the mode sizes it', () => {
    // A guest that played its own menu's mode off the host's seed would lay food
    // over a dish of the wrong radius entirely.
    const a = new Game({ seed: 555, mode: MODES.skirmish, seats: seatsOf(6) });
    const b = new Game({ seed: 555, mode: MODES.famine, seats: seatsOf(6) });
    expect(dishOf(a)).not.toEqual(dishOf(b));
    expect(a.mode.dishR).not.toBe(b.mode.dishR);
  });

  it('re-derives an identical dish on a second construction much later', () => {
    // A peer that joins late builds its dish from the seed alone, with a
    // different call history behind it. Nothing may be carried in a closure.
    const seats = seatsOf(6);
    const first = new Game({ seed: 31337, mode: PETRI, seats });
    const firstDish = dishOf(first);
    const firstSpawns = spawnsOf(first);

    for (let i = 0; i < 50; i++) new Game({ seed: i, mode: MODES.skirmish, seats: seatsOf(6) });

    const later = new Game({ seed: 31337, mode: PETRI, seats });
    expect(dishOf(later)).toEqual(firstDish);
    expect(spawnsOf(later)).toEqual(firstSpawns);
  });

  it('keeps pellet ids stable across peers, since the host deletes them by id', () => {
    // Eating is broadcast as "pellet 41 is gone". If two peers numbered their
    // food differently the guest would delete somebody else's lunch.
    const seats = seatsOf(6);
    const host = new Game({ seed: 909, mode: PETRI, seats });
    const peer = new Game({ seed: 909, mode: PETRI, seats });
    const ids = host.pelletList().map((p) => p.id);
    expect(ids).toEqual(peer.pelletList().map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length); // and they are unique
  });
});
