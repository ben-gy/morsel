// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * results.ts — the end-of-round summary.
 *
 * The rule this file exists to satisfy: show EVERYONE's result, every time. This
 * is the one moment players compare themselves, and a summary that only reflects
 * you back at yourself wastes it.
 *
 * So every seat gets a row — humans and bots, the winner and the player who
 * spent the round as a speck — and each row says what that blob actually DID,
 * not just what it scored. The stat that makes the screen worth reading is
 * `fed`: the mass you sprayed into the dish chasing people. It is usually the
 * line that explains the round, and it is frequently the funniest thing on it.
 */

import type { Blob, Game } from './game';
import { colorOf } from './fx';

export interface MatchTally {
  /** Rounds won, by seat name. Survives across rematches; mass does not. */
  wins: Record<string, number>;
  /** Biggest blob anyone has held all match. */
  biggest: number;
  biggestBy: string;
}

export interface Row {
  i: number;
  name: string;
  bot: boolean;
  left: boolean;
  isSelf: boolean;
  mass: number;
  peak: number;
  pellets: number;
  swallows: number;
  timesEaten: number;
  fed: number;
  biggest: number;
  wins: number;
}

export interface Summary {
  rows: Row[];
  winner: Row | null;
  /** Biggest single swallow of the round, and who landed it. */
  bestSwallow: { mass: number; by: string } | null;
  /** True when the top two are within a hair — worth calling out. */
  photoFinish: boolean;
}

export function summarize(g: Game, me: number, tally: MatchTally): Summary {
  const rows: Row[] = g.blobs.map((b: Blob) => ({
    i: b.i,
    name: b.name,
    bot: b.bot,
    left: b.left,
    isSelf: b.i === me,
    mass: g.score(b),
    peak: b.stats.peak,
    pellets: b.stats.pellets,
    swallows: b.stats.swallows,
    timesEaten: b.stats.timesEaten,
    fed: b.stats.fed,
    biggest: b.stats.biggest,
    wins: tally.wins[b.name] ?? 0,
  }));
  rows.sort((a, b) => b.mass - a.mass || b.peak - a.peak);

  const winner = rows.length && !rows[0].left ? rows[0] : (rows.find((r) => !r.left) ?? null);

  let bestSwallow: { mass: number; by: string } | null = null;
  for (const r of rows) {
    if (r.biggest > 0 && (!bestSwallow || r.biggest > bestSwallow.mass)) {
      bestSwallow = { mass: r.biggest, by: r.name };
    }
  }

  const photoFinish =
    rows.length > 1 && rows[0].mass > 0 && (rows[0].mass - rows[1].mass) / rows[0].mass < 0.05;

  return { rows, winner, bestSwallow, photoFinish };
}

/** Fold a finished round into the running match tally. */
export function tallyRound(tally: MatchTally, s: Summary): MatchTally {
  const wins = { ...tally.wins };
  if (s.winner) wins[s.winner.name] = (wins[s.winner.name] ?? 0) + 1;
  let biggest = tally.biggest;
  let biggestBy = tally.biggestBy;
  for (const r of s.rows) {
    if (r.peak > biggest) {
      biggest = r.peak;
      biggestBy = r.name;
    }
  }
  return { wins, biggest, biggestBy };
}

export const emptyTally = (): MatchTally => ({ wins: {}, biggest: 0, biggestBy: '' });

const n0 = (v: number): string => Math.round(v).toLocaleString();

/**
 * One line naming what actually happened to this player. A number tells you the
 * result; this tells you the story, and it is what makes a losing row worth
 * reading rather than a rebuke.
 */
export function verdict(r: Row, s: Summary): string {
  if (r.left) return 'left the dish';
  if (s.winner && r.i === s.winner.i) {
    if (s.photoFinish) return 'won it by a membrane';
    if (r.swallows === 0) return 'won without eating a soul';
    return `won it — ${r.swallows} swallowed`;
  }
  if (r.timesEaten === 0 && r.swallows === 0) return 'kept to itself';
  if (r.peak > r.mass * 3) return `peaked at ${n0(r.peak)}, then lost it`;
  if (r.timesEaten >= 4) return `eaten ${r.timesEaten} times — a popular snack`;
  if (r.fed > r.mass) return `fed the dish ${n0(r.fed)} chasing people`;
  if (r.swallows >= 3) return `${r.swallows} swallowed, still not enough`;
  return `${n0(r.pellets)} pellets grazed`;
}

export function renderSummary(s: Summary, g: Game, tally: MatchTally, rounds: number): string {
  const head = s.winner
    ? `<p class="rs-head"><b style="color:${colorOf(s.winner.i)}">${esc(s.winner.name)}</b> ${
        s.winner.isSelf ? 'win' : 'wins'
      } with ${n0(s.winner.mass)}${s.photoFinish ? ' — by a membrane!' : ''}</p>`
    : '<p class="rs-head">Nobody made it.</p>';

  const best = s.bestSwallow
    ? `<p class="rs-note">Biggest swallow: <b>${n0(s.bestSwallow.mass)}</b> by ${esc(
        s.bestSwallow.by,
      )}</p>`
    : '';

  const matchLine =
    rounds > 1
      ? `<p class="rs-note">Match after ${rounds} rounds — ${Object.entries(tally.wins)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${esc(k)} ${v}`)
          .join(' · ')}</p>`
      : '';

  // Every seat, always. The bar is drawn against the round's biggest so the
  // shape of the result is legible before you read a single number.
  const top = Math.max(1, ...s.rows.map((r) => r.mass));
  const body = s.rows
    .map((r) => {
      const pct = Math.max(1.5, (r.mass / top) * 100);
      return `<li class="rs-row${r.isSelf ? ' is-self' : ''}${r.left ? ' has-left' : ''}">
        <div class="rs-bar" style="width:${pct}%;background:${colorOf(r.i)}"></div>
        <div class="rs-line">
          <span class="rs-dot" style="background:${colorOf(r.i)}"></span>
          <span class="rs-name">${esc(r.name)}${r.isSelf ? ' (you)' : ''}${
            r.bot ? '<span class="rs-tag">BOT</span>' : ''
          }</span>
          <span class="rs-mass">${n0(r.mass)}</span>
        </div>
        <div class="rs-sub">
          <span>${esc(verdict(r, s))}</span>
          <span class="rs-stats" aria-label="round breakdown">
            peak ${n0(r.peak)} · ${r.pellets} pellets · ${r.swallows} swallowed ·
            eaten ${r.timesEaten} · fed ${n0(r.fed)}
          </span>
        </div>
      </li>`;
    })
    .join('');

  return `${head}${best}${matchLine}
    <ul class="rs-rows">${body}</ul>
    <p class="rs-foot">Dish held ${n0(
      g.blobs.reduce((a, b) => a + g.score(b), 0),
    )} between ${s.rows.length} blobs.</p>`;
}

/** Shareable one-liner. No link shorteners, no tracking, just the result. */
export function shareText(s: Summary, g: Game): string {
  const mine = s.rows.find((r) => r.isSelf);
  const place = mine ? s.rows.indexOf(mine) + 1 : 0;
  const bits = [
    `Morsel — ${g.mode.name}`,
    mine ? `I finished #${place} of ${s.rows.length} with ${n0(mine.mass)} mass` : '',
    mine && mine.swallows ? `${mine.swallows} blobs swallowed` : '',
    mine && mine.fed > 50 ? `${n0(mine.fed)} mass fed to everyone else 😬` : '',
  ].filter(Boolean);
  return `${bits.join(' · ')}\nhttps://morsel.benrichardson.dev`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
