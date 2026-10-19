# 🎤 SFX RECORDING LIST — the 14 silent sounds

Current state: **35 gun recordings loaded, 0 SFX recorded.** So the game is fully playable
but every UI/impact/event cue is silent (synth is OFF by design — Spe's rule: only real
recordings make noise).

Status: 0/14 recorded.

## How it works
Drop a file into this folder (`audio/sfx/`), named EXACTLY as listed. Auto-discovery picks it
up on next refresh — **zero code edits**. `.mp3` preferred (small), `.wav`/`.ogg` also work.

## The list (record in one session, 2 minutes of beatboxing)

| # | File name | When it plays | Mouth recipe |
|---|-----------|---------------|--------------|
| 1 | `wave_start.mp3` | wave begins | Military horn: "BA-DA-DAAAH!" |
| 2 | `cant_afford.mp3` | can't buy (no gold) | Two low tongue clucks: "tch-tch" / "buh-BUM" |
| 3 | `tower_place.mp3` | gun placed + unmute blip | Heavy "KA-CHUNK!" (short, punchy) |
| 4 | `tower_upgrade.mp3` | upgrade bought (U key) | Rising "da-DING!" (sparkly) |
| 5 | `tower_sell.mp3` | gun sold | Cash-out "cha-CHING" |
| 6 | `cash.mp3` | enemy pays out | Quick coin "CHING!" (very short) |
| 7 | `enemy_death.mp3` | enemy dies | Grunt "AUGH!" / wet "UGH" |
| 8 | `boss_appear.mp3` | boss wave spawns | Ominous "BWOOOOM..." (deep, long) |
| 9 | `explosion_small.mp3` | small splash (RPG-ish) | Quick "PFUT!" |
| 10 | `explosion_large.mp3` | big splash / rocket / boss death | "KABOOM!" |
| 11 | `explosion_massive.mp3` | BFG impacts | Long "KABLAAAAM!" with rumble |
| 12 | `hit_flesh.mp3` | bullet connects | Wet "THWACK!" (very short, plays a LOT) |
| 13 | `game_over.mp3` | lives hit 0 | Sad "wah-wah-wah-WAAH" |
| 14 | `victory.mp3` | wave 50 cleared | Triumphant "DA-DA-DA-DAAA!" |

## Mixing tips (from Spe's own rules)
- Keep them SHORT: 1s or less for 2, 3, 6, 9, 12 (they fire often)
- `hit_flesh` at 0.15 volume in-game — don't make it harsh
- `explosion_massive` and `boss_appear` can be 1.5–2s (they're rare moments)
- Mono is fine, and it keeps files tiny
- No clipping — leave headroom, the game applies its own volumes (EFFECTS bar in ⚙)

## Verify
⚙ gear icon in-game -> TEST A GUN (weapons) + the counter shows how many recordings loaded.
F12 console lists any still-missing SFX after load.
