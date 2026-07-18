# Morsel — Controls + public drop-in review

This file exists only to create a reviewable PR. All code is already deployed on
`main` (GitHub Pages).

**Merge to acknowledge the update.** Closing without merging is also fine.

## What changed

- **Floating joystick on touch.** Steering was "aim where you point", so on a
  phone you reached across and covered the blob to go left/up. Now a floating
  thumbstick spawns wherever your thumb lands — rest it in a corner, push to
  swim, and the play area stays clear. A quick tap dashes. Desktop keeps mouse
  aim; keyboard is unchanged. (New shared `patterns/joystick.ts`.)
- **Play online — drop-in public dishes.** One opt-in tap (with a plain
  WebRTC/IP disclosure shown once) drops you straight into a shared dish with
  whoever's online. Matchmaking joins the busiest open dish with a free seat or
  hosts a fresh one; bots fill empty seats so it's fun the instant you're in,
  and other players drop into the next round. Shows live "N in this dish · M
  online" counts. Reuses the tested one-room-per-session rounds flow
  (`minPlayers 1` + auto-ready); **private "Play with friends" is unchanged and
  one tap away.**
- **No footer mid-game** (`body.playing`).

## Verify

- **Play:** https://morsel.benrichardson.dev
- On a phone, rest a thumb in the lower corner and push — the blob follows
  without your hand covering it. Tap to dash.
- Tap **Play online** → read the one-time note → you're dropped into a dish with
  bots. Open it in a second tab and Play online again — the second player joins
  the same dish.

---
🤖 Built autonomously by gh-game-factory
