/**
 * modes.ts — the three shapes a round of Morsel can take.
 *
 * A mode must change how the game PLAYS, not just a number. The spread here is
 * mostly about ONE question: where does your mass come from?
 *
 *  - Skirmish  small dish, 4 blobs, 90s, dense food — a knife fight. The dish is
 *              small enough that you are never out of anyone's reach, so it is
 *              almost pure threat-assessment. Short bloom, so it resolves fast.
 *  - Petri     medium dish, 6 blobs, 150s, normal food — the default. Room to
 *              farm a corner of the dish if you want, at the cost of the middle.
 *  - Famine    big dish, 8 blobs, 180s, a THIRD of the food and a steep bloom.
 *              That is the real difference: you cannot farm your way to a win
 *              here, because the pellets are not there. Mass has to come out of
 *              somebody else, so Famine is a hunting game wearing the same rules.
 *
 * `bloomMax` is the ramp from principle #18: a pellet is worth 1 at the whistle
 * and `bloomMax` at the end. Early luck cannot bank a lead; the last stretch is
 * where the round is decided. It is a pure function of round time — no state, so
 * nothing to sync.
 */

export interface Mode {
  id: string;
  name: string;
  /** One line, player-facing. */
  blurb: string;
  /** Radius of the circular dish, in world units. */
  dishR: number;
  /** Total blobs in the dish. Humans first, AI fills the rest. */
  seats: number;
  /** Round length, seconds. */
  secs: number;
  /** Food pellets the dish maintains. */
  food: number;
  /** A food pellet is worth 1 at t=0 and this at the whistle. */
  bloomMax: number;
}

export const MODES: Record<string, Mode> = {
  skirmish: {
    id: 'skirmish',
    name: 'Skirmish',
    blurb: 'Tiny dish · 6 blobs · 110s — nowhere to hide, no time to farm.',
    // MEASURED. This mode was 4 blobs in a 620 dish and it was the weakest thing
    // in the game: 5.0 swallows a round and the halftime leader won 43% of the
    // time (chance 25%) — six people farming pellets in parallel. The fix was
    // not the food density (sweeping 90 -> 35 made it strictly worse, blowouts
    // up to 40%); it was that FOUR BLOBS IN A SMALL DISH IS NOT CROWDED. Six
    // blobs in a dish 47% the area of Petri's tripled the swallows to 14.2 and
    // gives the mode the highest violence-per-second in the game, which is the
    // only thing "Skirmish" was ever supposed to mean.
    dishR: 560,
    seats: 6,
    secs: 110,
    food: 80,
    bloomMax: 3.5,
  },
  petri: {
    id: 'petri',
    name: 'Petri',
    blurb: 'Medium dish · 6 blobs · 150s — the classic. Farm or hunt, your call.',
    dishR: 820,
    seats: 6,
    secs: 150,
    food: 150,
    bloomMax: 4,
  },
  famine: {
    id: 'famine',
    name: 'Famine',
    blurb: 'Big dish · 8 blobs · 180s — barely any food. Eat each other.',
    dishR: 1000,
    seats: 8,
    secs: 180,
    // A third of Petri's density over a bigger dish: you cannot farm a win here.
    food: 55,
    // Steeper, because the little food there is has to be worth crossing for.
    bloomMax: 6,
  },
};

export const DEFAULT_MODE = MODES.petri;

export const MODE_LIST: Mode[] = [MODES.skirmish, MODES.petri, MODES.famine];

/** Highest seat count any mode offers — the room cap. */
export const MAX_PLAYERS = 8;

/**
 * Resolve a mode id that arrived off the wire or out of storage.
 *
 * `MODES[id] || DEFAULT` is a trap: 'constructor' and 'toString' are truthy
 * inherited properties, so an untrusted id can hand the generator an object with
 * no `dishR`. Object.hasOwn is the guard, and an unknown id falls back rather
 * than reaching the sim as undefined.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id];
  return DEFAULT_MODE;
}
