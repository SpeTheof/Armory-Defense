# 🔫 ARMORY DEFENSE

A gun-themed tower defense for the browser. 15 weapons, 3 maps, 50 waves, and **every gunshot
is a real mouth recording**.

**A collab: SpeTheof 🎤 × Aura 🔮**

**▶ Play it now — https://spetheof.github.io/Armory-Defense/** (nothing to install)

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
- **3 difficulties** — RECRUIT (classic), VETERAN (default), HARDCORE
- **1×/2×/3× speed**, pause, hotkeys, auto-wave
- **Local high-score board** — top 10 runs, per-difficulty score multipliers, BEST line on the menu
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
| `A` | Toggle auto-wave |
| `1` `2` `3` | Game speed 1× / 2× / 3× (numpad works too) |
| `⚙` gear | Settings: volume bars + credits |

## High scores

- Finished runs (win **or** loss) are saved to localStorage: top 10 by score, then wave.
- Score multiplier: **Recruit ×1.0**, **Veteran ×1.5**, **Hardcore ×2.0**.
- The main menu shows **BEST <mode>** for the selected difficulty; **🏆 HIGH SCORES**
  opens the board (rank · score · mode · map · wave · kills).
- The result screen shows **🏆 NEW HIGH SCORE!** or your rank on the board.
- Scores are local to the browser (no account, no network) — they survive reloads but
  not clearing site data.

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

### Mix protection (v1.1.0)

Late waves put 30 guns, hundreds of impacts and explosions into the same second. The
master bus now runs through a **limiter** (DynamicsCompressor, -8 dB / 20:1) so it stays
loud without clipping.

- Gunshot audio is throttled on a **real-time clock** (~110 ms per tower), so 3× game
  speed no longer triples the sound rate.
- Hard caps: **18 active gun voices** (40 total), **26 SFX events/sec**, plus per-sound
  cooldowns for hits, deaths, explosions and UI blips.
- Noise buffers are cached — fast guns no longer allocate a fresh buffer per hit and
  stutter/drop out.
- Recordings load **6 files in parallel**; on GitHub Pages the old sequential loader
  took ~16 s and left the Railgun (last in line) silent. The hint bar shows load progress
  (`🔊 12/35` → `🔊 35/35 ready`).

## Balance (verified by simulation)

| Mode | Build | Result |
|------|-------|--------|
| RECRUIT | 20× ★5 maxed | wins wave 50 with 20/20 lives (old v1.0.1 balance) |
| VETERAN | 16× ★5 maxed | dies on wave 50 |
| VETERAN | 20× ★5 maxed | wins Desert with **10/20 lives**; Urban is tighter |
| VETERAN | 24× ★5 maxed | wins wave 50 with 20/20 lives |
| VETERAN | 30× ★5 maxed | wins wave 50 with 20/20 lives |
| HARDCORE | 24× ★5 maxed | dies on wave 50 |
| HARDCORE | 30× ★5 maxed | wins wave 50 with 15/15 lives |

Enemy HP scaling per mode:

```
waveScale = 1 + (wave-1)*hpLin + max(0, wave-30)² * hpLate

RECRUIT   hpLin 0.08   hpLate 0.05   →  wave-50 infantry   2,492 HP
VETERAN   hpLin 0.10   hpLate 0.16   →  wave-50 infantry   6,990 HP
HARDCORE  hpLin 0.10   hpLate 0.22   →  wave-50 infantry   9,390 HP
```

The quadratic term only bites after wave 30. Early waves are unchanged; the last ten are
where the build gets checked. In simulation the **Urban** path is the tightest (shortest
time in tower range), and **Arctic**'s long winding path is the most forgiving.

## Dev notes

- Starting gold: **$1,500** (Recruit/Veteran) or **$1,250** (Hardcore); kill rewards scale
  ×1.05 per wave, wave bonus `100 + wave*25`
- Towers are grid-snapped (`GRID = 50`) — road tiles are blocked, one tower per cell
- Bullets use **lead prediction** (fixed-point intercept solve) so fast movers get hit
  (measured 33% → 100% accuracy vs scouts) and **segment-swept collision** so 3× speed can't
  tunnel through hitboxes
- Railgun is hitscan (no bullet objects — damages along the beam). v1.1.0 adds a thicker
  two-pass beam, impact rings and floating damage numbers so the hit is unmistakable
- Auto-wave is a real feature now (it was only in the README before v1.1.0): `AUTO` button,
  `A` hotkey, 1.5 s breather
- Audio: master limiter + real-time gunshot throttle + voice caps (see Audio system)
- `updateUI()` is rAF-coalesced (many kills per frame = one DOM update); particles cap at 800
- Fit-to-screen scaling keeps the 1270px game layout usable on 720p laptops
- localStorage keys: `armory_settings` (volumes), `armory_difficulty`, `armory_scores` (top 10)
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
