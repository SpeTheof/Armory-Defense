# Changelog

## v1.1.1 — 2026-10-26

### High scores & layout
- **Local top-10 high-score board.** Each finished run (win or loss) is saved to
  localStorage with score, mode, map, wave and kills. Open it from the main menu with
  **🏆 HIGH SCORES**.
- **Difficulty score multipliers:** RECRUIT ×1.0, VETERAN ×1.5, HARDCORE ×2.0 — a
  Hardcore win is worth more than a Recruit win.
- Main menu shows **BEST <mode>** for the selected difficulty (score · wave · map).
- New high score = **🏆 NEW HIGH SCORE!** banner on the result screen; other board
  entries show their rank.
- Score formatting with thousands separators; top 10 kept, sorted by score then wave.
- **Fit-to-screen scaling** for the menu and game screen (1280×720 laptops and browser
  zoom no longer clip the bottom of the UI). Modal boxes cap at 94vw/92vh.
- Menu spacing tightened so the difficulty selector + best line + high-score button fit
  a 720p screen without scaling.

### Verified
- High-score record/sort/trim: 10-entry cap, duplicate-record guard, per-mode best line.
- Score multipliers: 100-reward kill gives 200 / 300 / 400 on Recruit / Veteran / Hardcore.
- Empty board state, new-high banner, rank banner, and modal rendering.
- Menu content 698×581 (fits 720p); game screen 1270×739 scales to 0.96 at 720p.

## v1.1.0 — 2026-10-26

The "make it hurt (but not your ears)" update.

### Audio — limiter, voice caps, real-time throttle
- **Master limiter** (`DynamicsCompressorNode`) after `masterGain`: 30 guns + explosions
  can no longer hard-clip the output. Threshold -8 dB, ratio 20:1, 3 ms attack.
- **Real-time gunshot throttle:** each tower gets one sound every ~110 ms of *wall*
  time. Previously the throttle used game time, so 3× speed fired 3× the audio and
  stacked 100+ voices/sec. That was the ear-rape / drop-out combo.
- **Voice budget:** max 18 active gun-recording voices (40 total). Extras are dropped
  instead of piling up. SFX (impacts, deaths) are capped at 26 trigger events/sec.
- **Per-sound cooldowns** for `hit_flesh`, `enemy_death`, explosions, cash, UI blips.
- **Noise-buffer cache:** synth SFX reuse cached noise buffers instead of allocating
  a fresh one per hit — kills the GC stutter that made fast guns sound "muted".
- **Parallel audio loading:** 6 files at a time instead of one-by-one. On GitHub Pages
  the 35 recordings used to take ~16 s; the railgun loaded dead last and was silent
  long after players bought it. Now it's ready in a few seconds.
- Added a live audio status readout (`🔊 12/35` → `🔊 35/35 ready`) in the hint bar.

### Railgun — it actually *feels* like a railgun now
- Verified on the live site: hitscan damage was working (400 at ★1), but the old beam
  was thin, 0.3 s, and the gun was the last recording to load — it read as "broken".
- Thicker two-pass beam (glow + white-hot core), 0.45 s, stronger screen shake.
- Impact rings on every enemy hit + floating damage numbers, so there is zero doubt
  that it fired and hit.
- Fixed synth `rpg` / `bfg` / `railgun` noise paths that bypassed `masterGain`.

### Difficulty — three modes
- **RECRUIT** — the v1.0.1 balance (20 lives, 1500 gold, original HP curve). For the
  little brother / chill runs.
- **VETERAN (new default)** — same economy, 20 lives, HP curve
  `1 + (wave-1)*0.10 + (wave-30)²*0.16`. A 20-tower ★5 build wins wave 50 with
  ~10/20 lives on Desert; 24+ towers clears it. Urban is the real final exam.
- **HARDCORE** — 15 lives, 1250 starting gold, HP curve with `0.22` late term. A
  24-tower maxed build dies on wave 50; 30 towers wins with 15/15.
- Mode is selectable on the main menu and remembered in localStorage.
- Result screen shows the mode played.

### Auto-wave (finally)
- The README promised auto-wave since v1.0.0 but the code never had it. Added:
  `AUTO` button in the controls bar + `A` hotkey, 1.5 s breather between waves,
  disabled at wave 50.

### Performance / correctness
- `updateUI()` is now rAF-coalesced: a hundred kills in one frame = one DOM update
  instead of a hundred. Big help at 3× speed.
- Particle hard cap (800) so late waves can't drown the renderer.
- `startNextWave()` and gameplay hotkeys are guarded to the `playing` state.
- `startGame()` resets `paused`, auto-wave, and the speed button UI.
- Audio settings counter shows load progress.

### Verified before release
- Live-site railgun test: 400 damage, beam + impact + damage number particles, no errors.
- 35/35 recordings decoded; parallel load; `audioStatus` reaches ready.
- Voice cap proof: 200 buffer starts → 18 weapon voices active, never more.
- SFX cap proof: 100 rapid `hit_flesh` calls → 26 events in the rolling second.
- Difficulty HP at wave 50 (infantry): Recruit 2,492 / Veteran 6,990 / Hardcore 9,390.
- Auto-wave: 0 → wave 1 after 1.5 s of game time; button state + hotkey work.
- Full 50-wave simulation per mode (see README balance table).

## v1.0.1 — 2026-10-19

Playable straight from the git URL (GitHub Pages).

### Hosting
- **3-tier audio discovery:** `audio/manifest.json` → directory listing → built-in fallback.
  Static hosts (GitHub Pages) have no directory listings, so the recordings couldn't be
  auto-discovered before — now they load everywhere.
- Added `tools/make-manifest.js` — run `node tools/make-manifest.js` after adding or removing
  a recording to refresh the manifest.
- Enabled GitHub Pages deploy from `main` → https://spetheof.github.io/Armory-Defense/
- Fixed the audio diagnostic message (it claimed the unrecorded SFX were silent; they now use
  Aura's synth fallbacks).

## v1.0.0 — 2026-10-19

First release. A collab: **SpeTheof** (design, all 35 weapon recordings) × **Aura** (code, SFX synthesis).

### Game
- 15 weapons across 7 categories, ★1–★5 with per-gun upgrade curves
- Armory Lab: one-time global Tier 4 ($10,000) / Tier 5 ($15,000, requires Tier 4) unlocks
- 6 enemy types, 50 waves, bosses at 10/20/30/35/40/45/50
- 3 maps, grid-snapped building, road cells blocked
- Progressive late-wave difficulty (quadratic ramp past wave 30)
- 1×/2×/3× speed (buttons + number row/numpad), pause, hotkeys
- Toast notifications, screen shake, particles, per-weapon gun renderers

### Audio
- Auto-discovery loader: drop `NN_Weapon_Name_Take.mp3` in `audio/weapons/` → rotated per shot
- 35 recordings (15 weapons) loaded and verified
- SFX synth fallbacks for 14 unrecorded sounds; **recordings override synth automatically**
- Real master bus (masterGain) — MASTER/WEAPONS/EFFECTS volume buses + mute
- Settings modal (⚙): volume bars, mute, "TEST A GUN", loaded-recording counter, credits
- Settings persist in localStorage
- Console diagnostic lists which SFX still have no recording
- Fixed: `wave_start` played before async decode finished → deferred until audio ready

### Combat accuracy
- Added lead prediction (fixed-point intercept solve) — scouts were dodging slow bullets
  (measured **33% → 100%** accuracy vs fast movers)
- Added segment-swept bullet collision — fast bullets at 3× speed can no longer tunnel
  through hitboxes
- Railgun correctly stays hitscan (no lead, no bullet objects)

### UI
- Upgrade panel is now properly nerdy: DPS, alpha/volley, bullet speed, lineup DPS (pierce),
  next-tier preview with % gain, invested total + DPS per $1k
- Fixed stale upgrade button state; U key respects the Lab gate
- `startGame()` now resets armory unlocks and gold (no state leaks between runs)

### Verified before release
- Full 50-wave run: **victory, 20/20 lives, 2,904 kills, 73,326 frames, zero JS errors**
- All 15 guns: place → ★5 → fire verified on all 3 maps
- Placement rules, sell refunds (60% of real total), Lab gates, double-buy guards
- Settings persistence, mute, volume buses, recording-overrides-synth
- Edge cases: no-selection upgrade/sell/deselect, broke Lab purchase, maxed-gun upgrade
