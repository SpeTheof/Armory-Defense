# 🔫 Weapon Sounds Folder

**Drop a recording in → it plays. No code changes, ever.**

## Naming pattern

```
NN_Weapon_Name_Take.mp3
```

- `NN` = recording order (01, 02, 03...) — just for your own organization
- `Weapon_Name` = the weapon (auto-matched to the game's guns)
- `Take` = rotation number (`_1`, `_2`, `_3`...)

## Rotation

All takes play in order, looping forever:

- 1 file → same sound every shot
- 2 files → `1-2-1-2-1-2...`
- 3 files → `1-2-3-1-2-3...`
- 5 files → `1-2-3-4-5-1-2-3-4-5...` (any count works)

**Take counts can differ per weapon** — Glock has 3, Remington has 2, both work.

## Current recordings

| Files | Weapon | Status |
|-------|--------|--------|
| `01_Glock_17_1/2/3.mp3` | Glock 17 | ✅ |
| `02_Desert_Eagle_1/2/3.mp3` | Desert Eagle | ✅ |
| `03_MP5_1/2/3.mp3` | MP5 | ✅ |
| `04_UZI_1/2/3.mp3` | UZI | ✅ |
| `05_Remington_870_1/2.mp3` | Remington 870 | ✅ |
| `06_AA-12_1/2.mp3` | AA-12 | ✅ |

**Still needed (next in line):** AK-47, M4A1, Barrett, AWP, RPG, M2 Browning,
Minigun, BFG, Railgun — pattern: `07_AK47_1.mp3`, `08_M4A1_1.mp3`, etc.

## Tips

- Keep takes **under 1 second** — sound in the first ~300ms, no trailing dead air
- One sound event per file (no re-takes or mic bumps after the shot!)
- Loud, punchy, consistent across takes

See `../SOUND_RECORDING_LIST.md` for the full recording guide with mouth-sound
descriptions for every weapon + SFX.
