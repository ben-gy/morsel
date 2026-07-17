# Morsel

**Everything smaller than you is lunch, everything bigger is a predator — and the only way to catch anything is to spit out the mass you were winning with.**

🎮 Play: https://morsel.benrichardson.dev

## What it is

Morsel is a petri-dish arena game. You are a blob. Scattered pellets make you
bigger, you can swallow anything smaller than you whole, and you must run from
anything bigger. Getting eaten just drops you back to a speck for a second and a
half — nobody is ever knocked out. Whoever is holding the most mass when the
round-ending whistle blows wins.

The twist that makes it a game rather than a farming race is one rule: **big
blobs are slow**, so the only way for a leader to catch anyone is to **dash** —
and a dash costs 15% of your mass, sprayed out behind you as food for the very
blob you are chasing. The only way to grow your lead is to spend your lead.
Chasing the small guy feeds the small guy. Being tiny is fast, cheap and safe;
being huge is a slow, bleeding target. There is no rubber-band and no catch-up
bonus — the pressure to fall back is a consequence of the movement rule, so it
reads as physics rather than pity.

Pellets are worth more and more as the round runs down (the "bloom"), so an early
lucky cluster is worth almost nothing and the last stretch is where it is
decided. Play solo against bots, share a room code with up to eight friends in
the same dish, or share a seed so a friend plays the identical dish and compares
their final mass.

The balance was not eyeballed — it was simulated. A few hundred AI-vs-AI rounds
per mode referee `P(the leader at time T eventually wins)`, every seat's win
rate, blowout rate and how often blobs actually eat each other. The design
document was wrong about which way the game would break, and the sim is what said
so (see `tests/balance.test.ts`).

## How to play

- **Move:** aim — the blob always swims toward your mouse pointer, or toward your
  thumb on a touchscreen. There is no "hold to move".
- **Dash:** Space, click, or the on-screen DASH button.
- **Pause / mute:** P / M (solo only — a live room does not stop for one player).
- **Goal:** be the biggest blob at the whistle. Eat pellets, swallow smaller
  blobs, run from bigger ones, and dash only when the catch is worth the mass.

## Multiplayer

Live **peer-to-peer** for 2–8 players. Create a room and share the 4-character
code (or the invite link), or type a friend's code to join. Empty seats fill with
AI blobs, so even a 2-player dish is busy and a solo game is never lonely.

It is genuinely serverless: your browsers form a direct WebRTC mesh, and a free
public signaling relay only brokers the initial handshake. After that nothing
about your game touches anyone's server, and nothing is stored. Authority is
split so nothing is ever contested — **each peer owns its own blob's motion and
its own death** (you never die to another machine's lag), while the host owns the
shared world: the pellet field, the AI blobs, the round clock and the mass
ledger. If the host leaves, a surviving peer is promoted and keeps the round
running to the whistle — it already holds a complete live world, so the takeover
is seamless. "Play again" starts a fresh round inside the same room without ever
leaving it, and the end-of-round summary shows every player's breakdown, not just
yours.

## Tech

- Vite 6 + vanilla TypeScript
- Canvas 2D rendering, procedural audio, membrane-wobble juice
- Shared engine: fixed-timestep loop, unified input, Trystero P2P netcode,
  seedable deterministic RNG
- Vitest for logic, P2P-sync determinism, host-transfer takeover, and a mandatory
  AI-vs-AI balance simulation
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less
page-view counts via Cloudflare Web Analytics.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
npm run icons   # regenerate the home-screen icons from the game's own mark
```

## License

MIT
