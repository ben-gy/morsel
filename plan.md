# Game Plan: Morsel

## Overview
- **Name:** Morsel
- **Repo name:** morsel
- **Tagline:** Everything smaller than you is lunch, everything bigger is a predator — and the only way to catch anything is to spit out the mass you were winning with.
- **Genre (directory category):** arcade

## Core Loop

You are a blob in a petri dish. Scattered pellets make you bigger. Any blob can
swallow any smaller blob whole on overlap. Bigger blobs move slower. Dying drops
you back to a speck and you are straight back in — nobody is ever out.

That much is the well-worn agar-like. The problem with the well-worn agar-like is
that **it is over once someone is biggest**: they can't be eaten, so they just
win. And the reason it's over is a geometry fact, not a balance number — a big
blob is slow, so it cannot catch anything, so its lead is safe *and* frozen. Both
halves of that are boring.

So Morsel has exactly one added verb, and the verb is the whole game:

> **DASH — a half-second burst of speed that costs you 15% of your mass, and the
> mass you spend sprays out behind you as pellets anyone can eat.**

That single rule does all the work:

- The leader is the only blob slow enough to *need* dash to catch anyone. So the
  only way to grow your lead is to **spend your lead**.
- A missed dash is a pure loss: you're smaller, and you just fed the dish.
- The blob you were chasing is faster than you and is running *away from you*
  through the pellets you're spraying. **Chasing the small guy feeds the small guy.**
- A small blob dashes cheaply (15% of very little) and can dash again sooner. Being
  tiny is fast, agile, and safe. Being huge is a slow, bleeding target.

There is no rubber-band, no catch-up bonus, no invisible hand. The negative
feedback is a consequence of the movement rule and the mass economy, so it reads
as physics rather than as the game taking pity on you.

**Win condition:** highest mass at the final whistle. Not cumulative, not "most
kills" — *what you are holding when the timer hits zero*. That makes the endgame
the game: being biggest with 10 seconds left paints a target on you, and everyone
knows it.

**Lose condition:** there isn't one. Being swallowed costs you your mass and 1.5s,
then you respawn as a speck somewhere safe. The tension is the timer, not death.

### The bloom (the early-small / late-big ramp)

Hexbloom's lesson generalises: *make the early game small and the late game big.*
Morsel's version is **the bloom** — pellet value ramps over the round, from 1 at
the whistle to `bloomMax` at the end (Petri: 1 → 4).

- Early luck can't bank a lead — a lucky pellet cluster on second 5 is worth a
  rounding error by minute 2.
- The round still resolves decisively, because late pellets and late kills are
  where the mass actually is.
- It is a **pure function of round time**: zero new state, nothing to sync, no P2P
  cost. (Hexbloom's tide taught this too.)

Thematically it's the dish blooming richer as the agar warms. Mechanically it is
the thing that keeps `P(leader at t=15s wins)` near chance.

### Absorption is a partial transfer

Swallowing a blob grants the eater **55%** of the victim's mass. The other **45%
scatters as pellets around the corpse.** So:

- Killing the leader doesn't crown a new leader — it **spills the leader's lead
  into the dish** for everyone nearby.
- A kill is worth chasing but never decisive on its own.
- Mass leaks out of the top of the economy constantly, which is what stops a
  runaway from ever fully closing.

### Decay

Every blob bleeds mass at a rate that scales with its size (a floor protects
specks — a starting blob decays at ~0). Big blobs starve if they only farm; they
have to hunt; hunting costs dashes. Same loop, tightened.

## Controls
- **Desktop:** move toward the mouse pointer (hold or just aim — the blob always
  swims toward the cursor); **Space / left-click** to dash. `P` pause, `M` mute.
- **Mobile:** drag anywhere on the dish — the blob swims toward your thumb (a
  floating aim, no fixed stick, so your thumb never covers the action). A single
  large **DASH** button bottom-right (≥64px). No D-pad: this game aims, it doesn't
  step, so `patterns/input.ts`'s pointer path is used and its D-pad overlay is not.

## Multiplayer
- **Mode:** live P2P (2–8), plus fully-playable solo vs AI blobs, plus an
  async-seed share link (same dish, same AI, compare final mass).
- **If live P2P — shape:** **versus** — and here is the justification, because
  versus is not the default:

  Morsel is *free-for-all*, which is a third thing from the co-op/versus binary and
  is the reason versus is right here. Nobody is eliminated, so a "loss" costs you
  1.5 seconds rather than your evening; there is no knocking a friend out of the
  game and watching them sit there. And the mechanic is fundamentally about
  **relative** size — a co-op version of "everything smaller than you is lunch"
  has no content, because the whole verb is aimed at other players. Co-op would
  mean inventing an AI predator for everyone to gang up on, which is a *different
  game* wearing this one's costume. Shared-world/non-hostile is likewise empty:
  two blobs that can't eat each other are two people farming pellets in silence.
  The eating **is** the interaction. So: versus, but versus with no elimination and
  a scoreboard that resets to "what are you holding right now" every second.

- **Players:** 2–8. Empty seats fill with AI blobs, so a 2-player room still has a
  busy dish. AI blobs seek pellets, flee anything bigger, and chase anything
  meaningfully smaller (they dash only when the maths favours it).
- **Topology: split authority, one owner per concern.** The idea sketch asked for
  fully distributed absorption. I'm taking the half of that which matters and
  leaving the half that fights the host-transfer contract:
  - **Each peer owns its own blob's MOTION and its own DEATH.** You die when *your*
    screen says you were caught — never because the host's copy of you lagged into
    a mouth. In an eat-or-be-eaten game, dying to someone else's latency is the
    single most infuriating outcome there is, and victim-authority removes it
    entirely.
  - **The host owns the shared world: the pellet field, the AI blobs, the round
    clock, and the mass ledger.** One authority per concern, so nothing is
    contested. A peer's *speed* derives from its host-ledgered mass, which can be a
    frame stale — invisible, and the alternative is two ledgers that disagree.
  - Absorption is asymmetric and therefore race-free: eater must be `EAT_RATIO`
    (1.15×) bigger, so of any two blobs at most one can ever be the eater. Only the
    victim concedes. No arbitration needed.
- **Channels (≤12 bytes each):**
  - `p` — pose. Peer → all, 15Hz. `{x, y, aim, dash}`. Its own blob only.
  - `w` — world. Host → all, 15Hz. `{t, pellets(delta), ai[], mass[], bloom}`.
  - `ate` — concede. Victim → all. `{v, e}` (victim idx, eater idx). Host applies
    the ledger transfer + scatter and it lands in the next `w`.
  - plus `rv`/`rs`/`rq` (rematch), `__h`/`ping` (net.ts).
- **Room entry:** `createRoomEntry` — **Create a room** *or* type a code. Invite
  link is a convenience. `?room=` honoured once, `clearRoomInUrl()` on the way out.
- **Late joiner:** joins as a speck at a safe spot on the next `w`. No catch-up
  needed — there is nothing to catch up *to*, since score is current mass and the
  bloom means late mass is the valuable mass. A late joiner is genuinely live.
  This is a nice property that falls out of "score = what you hold".
- **Peer leave:** their blob dissolves into pellets (a real, visible event — free
  food, and it reads as an in-world thing rather than a disconnect). Roster drops
  them. No freeze.
- **If the host leaves:** `net.ts` re-elects; `NetGame.onHostChanged(true)` fires
  the takeover — the promoted peer **adopts its last `w` snapshot as canonical**
  (pellets, AI, ledger, clock), starts owning the AI blobs and the pellet spawner,
  resumes the round clock on `setInterval`, and re-broadcasts `w`. The round keeps
  running and can still reach the whistle. Flashed as "you're the host now".
  Covered by `tests/takeover.test.ts` **and** the two-tab smoke test.

## End of round → rematch (live P2P)

The round ends at the whistle on **every** peer (each counts the host's clock
locally; the host's `w.t` is authoritative and corrects drift), so nobody is left
staring at a live board while others are on the summary.

**"Play again" never touches the room.** One `Net` for the room's whole life;
`patterns/rematch.ts` `createRounds` versions the rounds inside it. Play again =
`rounds.vote()`.

- **Waiting:** the summary shows each player's vote state live, plus the grace
  countdown ("Starting in 6s…") the instant quorum is reached — `state().startsInMs`,
  rendered, never a silent spinner.
- **One player declines / closes the tab:** quorum + grace starts the round without
  them (`rematch.ts` drops absent peers from `voters()`). No deadlock. The host can
  also **force start**.
- **The host leaves on the results screen:** the promoted peer inherits no tally,
  and `rq` resync makes every peer re-declare, so the new host can run the rematch.
- **Persists across rounds:** a **match tally** — rounds won per player, plus a
  running "biggest blob of the match". That's the thing worth keeping; mass itself
  resets.
- "Back to lobby" (does *not* leave the room) and "Menu" (does) are both offered.

## The summary (everyone's result, every time)

Not a winner and a number. A per-player row for every player *and* every AI:
**final mass, peak mass, pellets eaten, blobs swallowed, times eaten, mass fed to
others** (the dash-spray + scatter you donated — this is the funny one and it's
the stat that explains the round). Plus the round's **biggest single swallow** and
who made it. Every peer reaches this screen, including one who was a speck at the
whistle.

## Juice Plan
- **Sound** (`sound.ts`, extended patches): `pellet` (short blip, pitch rises with
  your mass so growth is *audible*), `dash` (whoosh), `swallow` (wet descending
  gulp), `eaten` (your death — a low, ugly slurp), `bloom` (a soft chime each time
  pellet value ticks up), `whistle`, countdown beats.
- **Screen shake** on being swallowed (hard) and on swallowing (soft, scaled by the
  victim's size). Hit-stop: 90ms freeze on a swallow — the single most satisfying
  frame in the game.
- **Particles:** pellet burst on eat; a spray of real (edible) pellets on dash; a
  corpse-burst on a swallow; a soft pulse ring on respawn.
- **Tweens:** blob radius eases toward its target mass (never snaps) — growing
  *feels* like swelling. The camera zooms out smoothly as you grow, so being big
  literally changes your view of the dish.
- **Membrane wobble:** each blob's outline is a ring of springy vertices perturbed
  by velocity — cheap (12 verts), and it's what makes them read as *alive* rather
  than as circles. Damped to nothing under `prefers-reduced-motion`.
- **The bloom** recolours the dish's background gradient as it ramps, so lateness
  is a thing you can *feel* without reading the HUD.

## Style Direction
**Vibe:** clean-minimal meets neon — a dark microscope field with luminous
organisms.
**Palette:** deep slate-navy dish (`#0b1220`), with blob colours drawn from an
8-way **colour-blind-safe** set (Okabe–Ito derived): orange `#e69f00`, sky
`#56b4e9`, green `#009e73`, yellow `#f0e442`, blue `#0072b2`, vermillion `#d55e00`,
rose `#cc79a7`, and white for the local player's ring. Okabe–Ito is the standard
deuteranopia/protanopia-safe set; **and blobs are never distinguished by colour
alone** — the local blob has a white ring + a permanent name tag, and *size* (the
only thing that matters for eat/flee) is geometric, not chromatic.
**Theme:** dark.
**Reference feel:** the tactile wobble of a good iOS toy; the readable-at-a-glance
minimalism of a Google Doodle game. Feel only, no IP.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite. No React — this is one canvas and a
  handful of screens.
- **Render:** **Canvas 2D.** Continuous motion, dozens of entities, particles,
  camera zoom — exactly the case Canvas is for.
- **Engine modules copied from patterns/:** `net`, `rematch`, `lobby`, `rng`,
  `loop`, `input` (pointer path only), `sound`, `storage`, `mobile`, `identity`.
- **Persistence:** localStorage via `storage.ts` — name, mute, mode, help-seen,
  and a per-mode personal best (highest final mass).
- **Sim:** `src/game.ts` is a **pure, headless, deterministic** class — no DOM, no
  canvas, no `Math.random` (seeded `rng.ts` only). That is what makes
  `tests/balance.test.ts` possible, and the balance sim is what referees the design.

## Non-Goals
- No splitting / ejecting-to-feed (agar's virus/split meta). Dash is the one verb;
  a second mass-spending verb would blur it and double the netcode surface.
- No viruses/obstacles/terrain. Empty dish, round 1.
- No teams. Free-for-all only.
- No public room board (`noticeboard.ts`) this run — private rooms only, so the
  IP-exposure disclosure in principle #16 doesn't arise.
- No persistent global leaderboard (no backend, and a local one is honest).

## How To Play (player-facing copy)

> **Eat the pellets. Swallow anything smaller than you. Run from anything bigger.**
> Big blobs are slow — so the only way to catch anyone is to **DASH**, and dashing
> costs 15% of your mass, sprayed out behind you as food for whoever you're chasing.
> Pellets are worth more and more as the round runs down, so the last twenty
> seconds decide it. Whoever is biggest at the whistle wins. Getting eaten just
> costs you a moment — you're never out.

## Balance plan (built FIRST, per principle #18)

`tests/balance.test.ts` runs a few hundred fixed-seed AI-vs-AI rounds headless and
asserts the *shape* of the outcome. **Written and baselined before a single
constant is tuned** — Hexbloom's five confident designers were nearly all wrong,
and the only thing that told them so was the sim.

Assertions:
1. **P(leader at t=T wins)** sampled across the round — flat and near chance early
   (t=10%, t=25%), only spiking near the end (t=90%). This curve *is* the drama.
2. **Seat win rate** — every seat within a few points of `100/players`, for 2/4/6/8.
   Spawn geometry and turn order are a fairness bug you cannot see by playing.
3. **Blowout rate** bounded, and **lead changes per round** floored — a "fix" that
   makes every round a coin-flip tie is also a failure.
4. **Round terminates** and the mass economy stays in a sane band (no runaway
   inflation, no starvation to zero).
5. **Feel metrics**, so a fix that flattens the curve by flattening the fun is
   caught: swallows per round, biggest-swallow distribution, dashes per round.
   If the numbers get pretty while nobody ever eats anyone, that's a failed fix.
6. **Pinned constants:** any constant fairness depends on gets its own assertion
   with the measured reason next to it.
