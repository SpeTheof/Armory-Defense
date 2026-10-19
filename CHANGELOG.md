# Changelog

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
