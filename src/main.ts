/**
 * main.ts — bootstrap and screen wiring. Owns no game logic.
 *
 * The shape: menu -> (solo | room entry -> lobby) -> countdown -> round ->
 * results -> (rematch inside the same room | back to lobby | menu).
 *
 * The rule that governs this file: ONE ROOM PER SESSION. The Net is created once
 * when you enter a room and lives until you leave for the menu. "Play again"
 * never touches it — rematch.ts versions rounds inside the living room. Two
 * games in this factory shipped broken by leaving and re-joining to "reset".
 */

import './styles/mobile.css';
import './styles/main.css';

import { Game, radiusOf, START_MASS, type Seat } from './game';
import { MODE_LIST, MAX_PLAYERS, modeOf, DEFAULT_MODE, type Mode } from './modes';
import { createSession, type Session, type SessionSeat } from './net-game';
import { createRenderer } from './render';
import { createFx, colorOf } from './fx';
import { createSfx } from './sound';
import { startCountdown, type Countdown } from './countdown';
import { summarize, tallyRound, emptyTally, renderSummary, shareText, type MatchTally } from './results';
import { createLoop } from './engine/loop';
import { createInput } from './engine/input';
import { createStore } from './engine/storage';
import { createNet, type Net } from './engine/net';
import { createRounds, type Rounds } from './engine/rematch';
import { resolveName, withName } from './engine/identity';
import { hardenViewport } from './engine/mobile';
import {
  createLobby,
  createRoomEntry,
  normalizeRoomCode,
  clearRoomInUrl,
  setRoomInUrl,
} from './engine/lobby';
import { newSeed } from './engine/rng';

hardenViewport();

const store = createStore('morsel');
const app = document.querySelector<HTMLDivElement>('#app')!;

const BLOB_NAMES = [
  'Nucleus', 'Vesicle', 'Plasm', 'Cilia', 'Flagella', 'Spore', 'Amoeba', 'Zoid',
];

const sfx = createSfx(store.get('muted', false));
let myName = resolveName(store, () => 'Blob');

// ── screens ─────────────────────────────────────────────────────────────────

let net: Net | null = null;
let rounds: Rounds | null = null;
let session: Session | null = null;
let game: Game | null = null;
let countdown: Countdown | null = null;
let tally: MatchTally = emptyTally();
let roundNo = 0;
/** Our seat in the current round, taken from the host's frozen roster. */
let mySeat = 0;
let roomCode = '';
let mode: Mode = modeOf(store.get('mode', DEFAULT_MODE.id));
/** Host-gossiped mode for the current room; null until heard. */
let liveMode: Mode = mode;
let deepLinkUsed = false;

const el = (html: string): HTMLElement => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
};

const FOOTER = `<footer class="site-footer">
  Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
  · <a class="hub-link" href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
</footer>`;

function shell(inner: string): void {
  app.innerHTML = `<div class="main-content">${inner}</div>${FOOTER}`;
  const hub = app.querySelector<HTMLAnchorElement>('.hub-link');
  if (hub) hub.href = withName('https://hub.benrichardson.dev', myName);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// ── menu ────────────────────────────────────────────────────────────────────

function showMenu(): void {
  teardownRoom();
  clearRoomInUrl();

  shell(`
    <div class="menu">
      <h1 class="title">Morsel</h1>
      <p class="tagline">Eat the small ones. Outrun the big ones.<br/>Catching anyone costs you the mass you were winning with.</p>

      <div class="modes" role="radiogroup" aria-label="Mode">
        ${MODE_LIST.map(
          (m) => `<button class="mode${m.id === mode.id ? ' on' : ''}" role="radio"
            aria-checked="${m.id === mode.id}" data-mode="${m.id}">
            <b>${m.name}</b><span>${esc(m.blurb)}</span></button>`,
        ).join('')}
      </div>

      <div class="menu-actions">
        <button class="btn primary" id="play">Play</button>
        <button class="btn" id="friends">Play with friends</button>
      </div>

      <label class="namebox">Your name
        <input id="name" maxlength="12" value="${esc(myName)}" autocomplete="off" spellcheck="false" />
      </label>

      <div class="menu-links">
        <button class="btn ghost" id="how">How to play</button>
        <button class="btn ghost" id="about">About</button>
        <button class="btn ghost" id="mute">${sfx.muted() ? 'Sound off' : 'Sound on'}</button>
      </div>
      <p class="best">${bestLine()}</p>
    </div>`);

  for (const b of app.querySelectorAll<HTMLElement>('.mode')) {
    b.addEventListener('click', () => {
      mode = modeOf(b.dataset.mode);
      liveMode = mode;
      store.set('mode', mode.id);
      sfx.unlock();
      sfx.play('select');
      showMenu();
    });
  }

  app.querySelector('#play')!.addEventListener('click', () => {
    sfx.unlock();
    startSolo();
  });
  app.querySelector('#friends')!.addEventListener('click', () => {
    sfx.unlock();
    showRoomEntry();
  });
  app.querySelector('#how')!.addEventListener('click', () => showHelp());
  app.querySelector('#about')!.addEventListener('click', showAbout);
  app.querySelector('#mute')!.addEventListener('click', () => {
    sfx.setMuted(!sfx.muted());
    store.set('muted', sfx.muted());
    sfx.unlock();
    sfx.play('select');
    showMenu();
  });

  const name = app.querySelector<HTMLInputElement>('#name')!;
  name.addEventListener('change', () => {
    myName = name.value.trim().slice(0, 12) || 'Blob';
    store.set('name', myName);
    name.value = myName;
  });

  if (!store.get('seen-help', false)) showHelp();
}

function bestLine(): string {
  const best = store.get<number>(`best:${mode.id}`, 0);
  return best > 0 ? `Your best ${mode.name}: ${Math.round(best)} mass` : '';
}

// ── help / about ────────────────────────────────────────────────────────────

function modal(title: string, body: string, onClose?: () => void): void {
  const m = el(`<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-card">
      <h2>${esc(title)}</h2>
      ${body}
      <button class="btn primary modal-x">Got it</button>
    </div>
  </div>`);
  document.body.appendChild(m);
  const close = (): void => {
    m.remove();
    onClose?.();
  };
  m.querySelector('.modal-x')!.addEventListener('click', close);
  m.addEventListener('click', (e) => {
    if (e.target === m) close();
  });
}

function showHelp(): void {
  store.set('seen-help', true);
  modal(
    'How to play',
    `<ul class="how">
      <li><b>Eat the pellets.</b> They are worth more and more as the round runs down, so the last stretch decides it.</li>
      <li><b>Swallow anything smaller.</b> Run from anything bigger. Size is the only thing that matters, and you can see it.</li>
      <li><b>Big blobs are slow.</b> So the only way to catch anyone is to <b>DASH</b> — and a dash costs 15% of your mass, sprayed out behind you as food for whoever you are chasing.</li>
      <li><b>Whoever is biggest at the whistle wins.</b> Getting eaten just costs you a moment — you are never out.</li>
    </ul>
    <p class="how-ctl"><b>Move:</b> aim with the mouse, or drag your thumb.
    <b>Dash:</b> space, click, or the DASH button.</p>`,
  );
}

function showAbout(): void {
  modal(
    'About Morsel',
    `<p>A petri dish, eight blobs and one rule: everything smaller than you is lunch.</p>
     <p>Play solo against bots, or share a room code with friends — up to ${MAX_PLAYERS} of you in the same dish.</p>
     <p class="fine">Multiplayer is <b>peer-to-peer</b>: your browsers talk directly to each other over WebRTC and there is no game server.
     A free public signaling relay only brokers the initial handshake — after that, nothing about your game touches anyone's server, and nothing is stored.</p>
     <p class="fine">No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.</p>
     <p class="fine">Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>.</p>`,
  );
}

// ── room entry + lobby ──────────────────────────────────────────────────────

function showRoomEntry(): void {
  teardownRoom();
  shell('<div class="screen" id="entry"></div>');
  createRoomEntry({
    container: app.querySelector<HTMLElement>('#entry')!,
    onSubmit: (code, created) => enterRoom(normalizeRoomCode(code), created),
    onCancel: showMenu,
    subtitle: `Start a room and share the code, or type a friend's. Up to ${MAX_PLAYERS} blobs.`,
  });
}

/**
 * Join the room ONCE. Everything after this — the lobby, round 1, every
 * rematch — happens inside this Net. It is torn down only on the way back to
 * the menu.
 */
function enterRoom(code: string, created: boolean): void {
  teardownRoom();
  roomCode = code;
  setRoomInUrl(code);

  net = createNet(
    // `claimHost` ONLY for the peer that minted the code. A typed code or a
    // link joins as a guest and waits to hear from the incumbent — otherwise
    // two peers race to host the same room.
    { appId: 'morsel', roomId: code, claimHost: created },
    {
      onHostChange: (_id, isSelfHost) => {
        session?.setHost(isSelfHost);
        if (session && isSelfHost) flashHud("The host left — you're the host now");
      },
      onPeerLeave: (id) => session?.onPeerLeave(id),
    },
  );

  rounds = createRounds({
    net,
    playerName: myName,
    minPlayers: 2,
    // The host's mode travels FROZEN inside the round start. A setting each peer
    // reads from its own UI is a setting two peers can disagree about — and here
    // it would mean two players in differently-sized dishes on the same seed.
    roundOpts: () => ({ mode: mode.id }),
    onRound: (info) => {
      const opts = info.opts as { mode?: unknown } | undefined;
      // Always validate an id off the wire: an unknown one must fall back, never
      // reach the sim as undefined.
      liveMode = modeOf(opts?.mode);
      startRound(info.seed, liveMode, info.players, info.isHost);
    },
  });

  showLobby();
}

function showLobby(): void {
  if (!net || !rounds) return showMenu();
  shell('<div class="screen" id="lobby"></div>');
  const box = app.querySelector<HTMLElement>('#lobby')!;
  const lobby = createLobby({
    container: box,
    net,
    rounds,
    roomCode,
    minPlayers: 2,
    maxPlayers: MAX_PLAYERS,
    onCancel: showMenu,
  });

  // The lobby view owns the roster; this strip shows what the HOST has picked,
  // which is the only mode that matters. Guests see the gossiped value — never
  // their own local pick dressed up as the host's.
  const strip = el('<div class="lobby-mode"></div>');
  box.appendChild(strip);
  const paint = (): void => {
    if (!rounds || !net) return;
    const s = rounds.state();
    const hostOpts = s.hostOpts as { mode?: unknown } | null;
    const shown = modeOf(hostOpts?.mode);
    strip.innerHTML = net.isHost()
      ? `<span class="lm-label">Your dish (everyone plays this)</span>
         <div class="lm-modes">${MODE_LIST.map(
           (m) =>
             `<button class="lm${m.id === mode.id ? ' on' : ''}" data-mode="${m.id}">${m.name}</button>`,
         ).join('')}</div>
         <span class="lm-blurb">${esc(mode.blurb)}</span>`
      : hostOpts
        ? `<span class="lm-label">The host picked</span>
           <div class="lm-modes"><button class="lm on" disabled>${shown.name}</button></div>
           <span class="lm-blurb">${esc(shown.blurb)}</span>`
        : `<span class="lm-label"><span class="spinner sm"></span> Waiting for the host's dish…</span>`;
    for (const b of strip.querySelectorAll<HTMLElement>('.lm[data-mode]')) {
      b.addEventListener('click', () => {
        mode = modeOf(b.dataset.mode);
        store.set('mode', mode.id);
        sfx.play('select');
        paint();
      });
    }
  };
  paint();
  const poll = setInterval(paint, 700);

  cleanupLobby = () => {
    clearInterval(poll);
    lobby.destroy();
  };
}

let cleanupLobby: (() => void) | null = null;

// ── the round ───────────────────────────────────────────────────────────────

function startSolo(): void {
  teardownRoom();
  roundNo++;
  const seed = newSeed();
  startRound(seed, mode, [{ id: 'solo', name: myName }], true);
}

function startRound(
  seed: number,
  m: Mode,
  players: { id: string; name: string }[],
  isHost: boolean,
): void {
  cleanupLobby?.();
  cleanupLobby = null;
  countdown?.cancel();

  const humans = players.length;
  // Empty seats fill with bots, so a 2-player room is still a busy dish and a
  // solo player is never alone in a lake.
  const total = Math.max(m.seats, humans);
  const seats: Seat[] = [];
  const sseats: SessionSeat[] = [];
  const taken = new Set(players.map((p) => p.name));
  let botN = 0;
  for (let i = 0; i < total; i++) {
    if (i < humans) {
      seats.push({ name: players[i].name, bot: false });
      sseats.push({ id: players[i].id, bot: false });
    } else {
      let nm = BLOB_NAMES[botN % BLOB_NAMES.length];
      while (taken.has(nm)) nm = `${nm}${++botN}`;
      taken.add(nm);
      botN++;
      seats.push({ name: nm, bot: true });
      sseats.push({ bot: true });
    }
  }

  // Our seat comes from the HOST'S FROZEN ROSTER, never from a local lookup by
  // name: two players called "Blob" would otherwise land on the same seat and
  // watch each other's score.
  const me = net ? players.findIndex((p) => p.id === net!.selfId) : 0;
  mySeat = me >= 0 ? me : 0;
  game = new Game({ seed, mode: m, seats });
  const g = game;

  session = createSession({
    game: g,
    me,
    seats: sseats,
    net: net ?? undefined,
    host: isHost,
    seed,
    onEnd: () => showResults(),
  });

  showGame(g, me, m);
}

function showGame(g: Game, me: number, m: Mode): void {
  shell(`
    <div class="play">
      <canvas id="cv" class="drag-surface"></canvas>
      <div class="hud">
        <div class="hud-l">
          <div class="clock" id="clock">0:00</div>
          <div class="bloom" id="bloom"></div>
        </div>
        <ol class="board" id="board"></ol>
        <div class="hud-r">
          <button class="icon" id="pause" aria-label="Pause">II</button>
        </div>
      </div>
      <div class="dashwrap"><button class="dashbtn" id="dash" aria-label="Dash">DASH</button></div>
      <div class="flash" id="flash" role="status" aria-live="polite"></div>
      <div class="big" id="big" hidden></div>
      <div class="overlay" id="pausebox" hidden>
        <div class="modal-card">
          <h2>Paused</h2>
          <button class="btn primary" id="resume">Resume</button>
          <button class="btn" id="restart">Restart</button>
          <button class="btn ghost" id="quit">Menu</button>
        </div>
      </div>
    </div>`);

  const canvas = app.querySelector<HTMLCanvasElement>('#cv')!;
  const renderer = createRenderer(canvas);
  const fx = createFx();
  const input = createInput({
    target: canvas,
    keys: {
      Space: 'dash',
      KeyP: 'pause',
      Escape: 'pause',
      KeyM: 'mute',
    },
    // This game aims; it does not step. The D-pad overlay would be wrong, so we
    // use input.ts's pointer path and give dash its own big button below.
    touch: false,
  });

  const clockEl = app.querySelector<HTMLElement>('#clock')!;
  const bloomEl = app.querySelector<HTMLElement>('#bloom')!;
  const boardEl = app.querySelector<HTMLElement>('#board')!;
  const bigEl = app.querySelector<HTMLElement>('#big')!;
  const pauseBox = app.querySelector<HTMLElement>('#pausebox')!;
  let paused = false;
  let dashQueued = false;

  const dashBtn = app.querySelector<HTMLElement>('#dash')!;
  const fireDash = (e: Event): void => {
    e.preventDefault();
    dashQueued = true;
  };
  dashBtn.addEventListener('pointerdown', fireDash);
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') dashQueued = true;
  });

  app.querySelector('#pause')!.addEventListener('click', () => setPaused(true));
  app.querySelector('#resume')!.addEventListener('click', () => setPaused(false));
  app.querySelector('#restart')!.addEventListener('click', () => {
    if (net) {
      setPaused(false);
      return; // a shared round is not one player's to restart
    }
    loop.stop();
    input.destroy();
    startSolo();
  });
  app.querySelector('#quit')!.addEventListener('click', () => {
    loop.stop();
    input.destroy();
    showMenu();
  });

  function setPaused(p: boolean): void {
    // In a live room the world does not stop for you — pause is a menu, not a
    // freeze, or one player could hold the round hostage.
    paused = p && !net;
    pauseBox.hidden = !p;
    if (!p) hudTouch();
  }

  const resize = (): void => {
    const r = canvas.parentElement!.getBoundingClientRect();
    renderer.resize(r.width, r.height, Math.min(2, window.devicePixelRatio || 1));
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement!);
  resize();

  // 3-2-1-GO. The audio carries it: players watch the dish, not the overlay.
  let running = false;
  bigEl.hidden = false;
  countdown = startCountdown({
    onBeat: (n) => {
      bigEl.textContent = n > 0 ? String(n) : 'GO';
      bigEl.className = 'big pop';
      void bigEl.offsetWidth;
      bigEl.className = 'big pop go';
      sfx.play(n > 0 ? 'beat' : 'go');
    },
    onDone: () => {
      running = true;
      bigEl.hidden = true;
    },
  });

  function hudTouch(): void {
    const secs = Math.ceil(g.remaining());
    clockEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    clockEl.classList.toggle('urgent', secs <= 15);
    const b = g.bloom();
    bloomEl.textContent = `Pellets ×${b.toFixed(1)}`;
    bloomEl.style.opacity = String(0.5 + ((b - 1) / (m.bloomMax - 1)) * 0.5);

    const top = g.standings().slice(0, 5);
    boardEl.innerHTML = top
      .map(
        (bl) =>
          `<li class="${bl.i === me ? 'me' : ''}"><i style="background:${colorOf(bl.i)}"></i>
           <span>${esc(bl.name)}</span><b>${Math.round(g.score(bl))}</b></li>`,
      )
      .join('');
  }

  // The HUD and the round's end run off setInterval, NOT rAF: a backgrounded
  // tab pauses rAF, and a clock that freezes when you glance away is worse than
  // no clock at all.
  const hudTimer = setInterval(() => {
    hudTouch();
    if (!paused) session?.pump(performance.now());
  }, 250);

  const loop = createLoop({
    update: () => {},
    render: () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;

      if (!paused && running) {
        // Aim at the pointer. There is no "hold to move" — the blob always swims
        // toward where you are pointing, which is the only control scheme that
        // works identically for a mouse and a thumb.
        const p = input.state.pointer;
        const self = g.blobs[me];
        if (p && self) {
          const w = renderer.toWorld(p.x, p.y);
          const dx = w.x - self.x;
          const dy = w.y - self.y;
          // A dead zone inside the blob, or it jitters when you point at yourself.
          const d = Math.hypot(dx, dy);
          if (d > radiusOf(self.mass) * 0.35) session?.intent(dx, dy, false);
          else session?.intent(0, 0, false);
        }
        const wantDash = dashQueued || input.state.pressed.has('dash');
        if (wantDash) session?.intent(self ? self.ax : 0, self ? self.ay : 0, true);
        dashQueued = false;

        if (fx.stopped() <= 0) session?.pump(now);
      }

      if (input.state.pressed.has('pause')) setPaused(!pauseBox.hidden ? false : true);
      if (input.state.pressed.has('mute')) {
        sfx.setMuted(!sfx.muted());
        store.set('muted', sfx.muted());
      }

      fx.step(dt);
      drainEvents(g, me, fx);
      renderer.draw(g, me, fx, 0, dt);
      input.endFrame();
    },
  });

  let lastFrame = performance.now();
  loop.start();

  cleanupGame = () => {
    loop.stop();
    input.destroy();
    ro.disconnect();
    clearInterval(hudTimer);
    countdown?.cancel();
    countdown = null;
  };
  hudTouch();
}

let cleanupGame: (() => void) | null = null;

/** Turn sim events into noise and light. The sim stays pure; this is the theatre. */
function drainEvents(g: Game, me: number, fx: ReturnType<typeof createFx>): void {
  for (const e of g.events) {
    switch (e.k) {
      case 'pellet': {
        fx.burst(e.x, e.y, e.food ? 3 : 4, e.food ? '#f0e442' : colorOf(g.blobs[e.i].i), 60, 2);
        // Only the local player's grazing makes a sound, or a busy dish is a
        // wall of blips. Pitch falls as you grow — growth you can hear.
        if (e.i === me) sfx.play('pellet', g.blobs[me].mass);
        break;
      }
      case 'dash':
        fx.burst(e.x, e.y, 8, colorOf(e.i), 150, 3);
        if (e.i === me) sfx.play('dash');
        break;
      case 'eat': {
        const big = Math.min(1, e.mass / 200);
        fx.burst(e.x, e.y, 14 + Math.round(big * 20), colorOf(e.j), 200 + big * 200, 4);
        fx.ring(e.x, e.y, colorOf(e.j), radiusOf(e.mass));
        if (e.j === me) {
          // You were eaten. It should sting.
          fx.shake(16);
          fx.stop(0.09);
          sfx.play('eaten');
          flashHud('Swallowed! Back in a moment…');
        } else if (e.i === me) {
          fx.shake(3 + big * 7);
          fx.stop(0.09); // the frame that makes a swallow land
          sfx.play('swallow');
        }
        break;
      }
      case 'spawn':
        fx.ring(e.x, e.y, colorOf(e.i), radiusOf(START_MASS) * 2);
        if (e.i === me) sfx.play('spawn');
        break;
      case 'bloom':
        sfx.play('bloom');
        break;
    }
  }
  g.events.length = 0;
}

function flashHud(msg: string): void {
  const f = document.querySelector<HTMLElement>('#flash');
  if (!f) return;
  f.textContent = msg;
  f.classList.add('show');
  setTimeout(() => f.classList.remove('show'), 2200);
}

// ── results ─────────────────────────────────────────────────────────────────

function showResults(): void {
  cleanupGame?.();
  cleanupGame = null;
  const g = game;
  if (!g) return showMenu();

  sfx.play('whistle');
  const s = summarize(g, mySeat, tally);
  tally = tallyRound(tally, s);
  roundNo++;

  const mine = s.rows.find((r) => r.isSelf);
  if (mine && !net) {
    const best = store.get<number>(`best:${g.mode.id}`, 0);
    if (mine.mass > best) store.set(`best:${g.mode.id}`, mine.mass);
  }
  if (s.winner?.isSelf) sfx.play('win');

  shell(`
    <div class="results">
      <h2 class="rs-title">${esc(g.mode.name)} — round over</h2>
      <div id="rsbody">${renderSummary(s, g, tally, roundNo)}</div>
      <div class="rs-wait" id="rswait" hidden></div>
      <div class="rs-actions">
        <button class="btn primary" id="again">Play again</button>
        <button class="btn" id="share">Share</button>
        ${net ? '<button class="btn ghost" id="tolobby">Back to lobby</button>' : ''}
        <button class="btn ghost" id="menu">Menu</button>
      </div>
    </div>`);

  app.querySelector('#share')!.addEventListener('click', () => void share(shareText(s, g)));
  app.querySelector('#menu')!.addEventListener('click', showMenu);
  app.querySelector('#tolobby')?.addEventListener('click', () => {
    // Back to the lobby does NOT leave the room — the Net and the whole mesh
    // stay up. Leaving would re-arm the rejoin trap.
    rounds?.finish();
    showLobby();
  });

  const again = app.querySelector<HTMLElement>('#again')!;
  const wait = app.querySelector<HTMLElement>('#rswait')!;

  if (!net) {
    again.addEventListener('click', () => startSolo());
    return;
  }

  rounds?.finish();
  again.addEventListener('click', () => {
    rounds?.vote();
    again.setAttribute('disabled', '');
    again.textContent = 'Waiting…';
    paintWait();
  });

  // A silent wait is indistinguishable from a hang. Show who is in, and the
  // countdown that will start the round without the stragglers.
  function paintWait(): void {
    if (!rounds || !net) return;
    const st = rounds.state();
    if (st.phase === 'playing') return;
    const votes = st.votes.map((v) => esc(v.name)).join(', ');
    const missing = st.present.length - st.votes.length;
    wait.hidden = st.votes.length === 0;
    wait.innerHTML = `
      <span class="spinner sm" aria-hidden="true"></span>
      <span>${votes || 'Nobody'} ready${missing > 0 ? ` · waiting on ${missing}` : ''}${
        st.startsInMs != null
          ? ` · starting in ${Math.ceil(st.startsInMs / 1000)}s`
          : st.votes.length >= 2
            ? ''
            : ' · need 2 to play'
      }</span>
      ${st.isHost && st.canStart ? '<button class="btn sm" id="force">Start now</button>' : ''}`;
    wait.querySelector('#force')?.addEventListener('click', () => rounds?.go());
  }
  const poll = setInterval(paintWait, 400);
  cleanupGame = () => clearInterval(poll);
  paintWait();
}

async function share(text: string): Promise<void> {
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Morsel', text });
      return;
    }
  } catch {
    /* cancelled — fall through to copy */
  }
  try {
    await navigator.clipboard.writeText(text);
    flashHud('Copied!');
  } catch {
    flashHud('Copy failed — select and copy manually');
  }
}

// ── teardown ────────────────────────────────────────────────────────────────

function teardownRoom(): void {
  cleanupGame?.();
  cleanupGame = null;
  cleanupLobby?.();
  cleanupLobby = null;
  countdown?.cancel();
  countdown = null;
  session?.destroy();
  session = null;
  rounds?.destroy();
  rounds = null;
  if (net) {
    // Genuinely leaving. `leave()` resolves only once Trystero has really let
    // go, so a later join of the same code cannot alias the dying room.
    void net.leave();
    net = null;
  }
  game = null;
  roundNo = 0;
  tally = emptyTally();
}

window.addEventListener('beforeunload', () => {
  void net?.leave();
});

// ── boot ────────────────────────────────────────────────────────────────────

// A ?room= link is honoured ONCE, then cleared. Leave it in the URL and a reload
// — or reopening from a home-screen icon — silently drags the player back into a
// room they left, with no way to start a new one.
const url = new URL(location.href);
const deep = url.searchParams.get('room');
if (deep && !deepLinkUsed) {
  deepLinkUsed = true;
  const code = normalizeRoomCode(deep);
  if (code.length >= 3) enterRoom(code, false);
  else showMenu();
} else {
  showMenu();
}
