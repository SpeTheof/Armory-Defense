# 🔫 ARMORY DEFENSE

A gun-themed tower defense for the browser. 15 weapons, 3 maps, 50 waves, and **every gunshot
is a real mouth recording**.

**A collab: SpeTheof 🎤 × Aura 🔮**

**▶ Play it now — https://speetheof.github.io/Armory-Defense/** (nothing to install)

---

## What is it

Build a firing line of real firearms along a road, mow down waves of infantry, scouts, heavies,
APCs, helis and bosses, and unlock the Armory Lab to push every gun to ★5.

- **15 guns** across 7 categories (sidearms → SMGs → shotguns → assault rifles → snipers → heavy → experimental)
- **5 upgrade stars per gun**, each with its own price curve
- **Armory Lab** — one-time global unlocks: Tier 4 ($10,000, unlocks ★4 for ALL guns), then
  Tier 5 ($15,000, requires Tier 4)
- **6 enemy types** + bosses at waves 10/20/30/35/40/45/50 (wave 50 is a war crime)
- **3 maps**, grid-snapped building (towers only go on cell centers)
- **1×/2×/3× speed**, pause, hotkeys, auto-wave
- **Zero libraries** — plain HTML5 Canvas + Web Audio API

## Run it

Needs to be served over HTTP (audio auto-discovery needs directory listings):

```bash
cd "Armory Defense"
npx http-server -p 8391 -c-1
# open http://localhost:8391/
```

`file://` works for gameplay but the recordings won't auto-load — use a server.

## Controls

| Input | Action |
|-------|--------|
| `LMB` | Place / select tower |
| `RMB` / `ESC` | Deselect / cancel |
| `SPACE` | Start next wave |
| `U` | Upgrade selected tower |
| `P` | Pause |
| `1` `2` `3` | Game speed 1× / 2× / 3× (numpad works too) |
| `⚙` gear | Settings: volume bars + credits |

## Audio system

Two sources, one rule: **recordings always win, synthesizers fill the gaps.**

| Folder | Contents | Played as |
|--------|----------|-----------|
| `audio/weapons/` | `NN_Weapon_Name_Take.mp3` — 35 takes, 15 weapons | Rotated per shot (1-2-3-1-2-3) |
| `audio/sfx/` | `sound_key.mp3` (UI, impacts, explosions) | Direct sounds |

- Drop files in and they **auto-load — zero code edits**. Take counts are unlimited.
- Discovery order: `audio/manifest.json` → directory listing → built-in list. Static hosts
  (GitHub Pages) can't list folders, so after adding/removing a recording run
  `node tools/make-manifest.js` and commit the refreshed manifest.
- Guns play **only** real recordings (no synth fallbacks).
- SFX fall back to Aura's oscillator synthesis when a recording doesn't exist yet, and a real
  recording in `audio/sfx/` **overrides the synth automatically**. See
  `audio/sfx/RECORD_THESE.md` for the 14 file names.
- Settings (⚙) has MASTER / WEAPONS / EFFECTS bars, mute, a "TEST A GUN" button, and a live
  count of loaded recordings. All persisted to localStorage.

## Balance (verified by simulation)

| Build | Result |
|-------|--------|
| ★1 guns, no upgrades, no Lab | dies ~wave 30 |
| ★3 guns, no Lab | dies ~wave 44 |
| 30× ★5 with Lab | **wins wave 50 with 20/20 lives**, 2,904 kills |

Progressive late-game scaling: `1 + (wave-1)*0.08 + ((wave-30)²)*0.05` — smooth handoff at 30,
~25× HP by wave 50.

## Dev notes

- Started gold **$1,500**, kill rewards scale ×1.05 per wave, wave bonus `100 + wave*25`
- Towers are grid-snapped (`GRID = 50`) — road tiles are blocked, one tower per cell
- Bullets use **lead prediction** (fixed-point intercept solve) so fast movers get hit
  (measured 33% → 100% accuracy vs scouts) and **segment-swept collision** so 3× speed can't
  tunnel through hitboxes
- Railgun is hitscan (no bullet objects — damages along the beam)
- Upgrade panel shows DPS, alpha/volley, bullet speed, lineup DPS for pierce guns, next-tier
  preview with % gain, and DPS-per-$1k efficiency

## Credits

- **ALL WEAPON SOUNDS** — SpeTheof 🎤 (every gun is his actual mouth)
- **GAME DESIGN & VISION** — SpeTheof
- **CODE & ENGINE** — Aura 💜
- **SOUND DESIGN (SFX)** — Aura 🔮 oscillator sorcery, zero samples
- **TECH** — HTML5 Canvas + Web Audio API, no libraries

[youtube.com/SpeTheof](https://youtube.com/SpeTheof) · [github.com/SpeTheof](https://github.com/SpeTheof)

*vibe coded, no cap*
