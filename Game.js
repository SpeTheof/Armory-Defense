// ============================================================
// ARMORY DEFENSE v1.1.1 - Complete Game Engine
// Vibe Coded by Aura & Spe 🔫
// ============================================================

// ============================================================
// AUDIO ENGINE - Web Audio API + auto-discovered recordings
// Drop .mp3/.wav files into audio/weapons/ or audio/sfx/ - they
// load themselves and override everything. Synth = off (Spe's FX only)
// ============================================================
const AudioEngine = {
    ctx: null,
    masterGain: null,
    loadedSounds: {},
    variantGroups: {},   // sound name -> array of variant keys (played in rotation)
    variantIndex: {},    // rotation counter per group
    soundCat: {},        // sound key -> 'weapons' | 'sfx' (which volume bus it rides)
    synthEnabled: false, // false = ONLY recorded FX play; unrecorded sounds are silent
    masterVolume: 1.0,   // overall loudness (settings MASTER bar)
    weaponVolume: 0.8,   // gun recordings bus (settings WEAPONS bar)
    effectsVolume: 0.8,  // UI / impact / explosion bus (settings EFFECTS bar)
    muted: false,
    loadedCount: 0,      // total decoded recordings (shown in settings)
    pendingStartSound: false, // startGame's wave_start ran before decode finished

    // ---- MIX PROTECTION (v1.1.0) ----
    // 35 guns + 3 fast-fire speeds + hundreds of hits = a clipped, drop-out
    // mess. A limiter on the master bus + voice/rate caps keeps it loud but
    // clean instead of ear rape.
    limiter: null,
    voices: 0,               // active recorded buffer voices (all categories)
    weaponVoices: 0,         // active gun-recording voices
    maxVoices: 40,
    maxWeaponVoices: 18,
    lastPlayed: {},          // sound key -> ctx time of last trigger
    eventTimes: [],          // rolling SFX trigger timestamps (CPU/rate guard)
    noiseCache: {},          // reused noise buffers (stops GC stutter on fast hits)
    audioTotal: 0,
    audioLoaded: 0,

    init() {
        if (this.ctx) return;
        this.loadSettings(); // restore bars BEFORE the context opens
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        // Master chain: per-sound gain -> masterGain -> limiter -> speakers.
        // The limiter catches the sum of every gun + impact; no hard clipping.
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -8;   // start squashing above -8 dBFS
        this.limiter.knee.value = 0;         // hard knee = limiter, not glue
        this.limiter.ratio.value = 20;       // ~brick wall
        this.limiter.attack.value = 0.003;   // fast enough for gun transients
        this.limiter.release.value = 0.18;   // but not pumping
        this.masterGain.connect(this.limiter);
        this.limiter.connect(this.ctx.destination);

        this.loadFiles();
    },

    // ============================================================
    // SETTINGS PERSISTENCE (gear menu volume bars)
    // ============================================================
    loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem('armory_settings') || '{}');
            if (typeof s.master === 'number') this.masterVolume = s.master;
            if (typeof s.weapons === 'number') this.weaponVolume = s.weapons;
            if (typeof s.effects === 'number') this.effectsVolume = s.effects;
            if (typeof s.muted === 'boolean') this.muted = s.muted;
        } catch (e) { /* corrupted / private mode -> defaults */ }
    },

    applyVolumes() {
        if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
        try {
            localStorage.setItem('armory_settings', JSON.stringify({
                master: this.masterVolume,
                weapons: this.weaponVolume,
                effects: this.effectsVolume,
                muted: this.muted,
            }));
        } catch (e) { /* private mode -> volumes live for the session only */ }
    },

    setStatus(text) {
        const el = document.getElementById('audioStatus');
        if (el) el.textContent = text;
    },

    async loadFiles() {
        this.setStatus('🔊 loading…');
        // ============================================================
        // AUTO-DISCOVERY - drop recordings in, they just work:
        //   audio/weapons/  NN_Weapon_Name_Take.mp3  -> grouped per weapon,
        //                   rotated in take order (1-2-1-2... / 1-2-3-1-2-3...)
        //   audio/sfx/      sound_key.mp3            -> direct single sound
        // Take count is unlimited: 1, 2, 3, 5 files - rotation handles it all.
        // ============================================================
        const DIRS = ['audio/weapons/', 'audio/sfx/'];
        const groups = {}; // game sound key -> [{take, file}, ...]

        // Map a recording's name onto the game's sound key
        // ("Glock_17" / "AA-12" / "Remington_870" -> "glock" / "aa12" / "remington")
        const towerKeys = (typeof TOWERS !== 'undefined') ? Object.keys(TOWERS) : [];
        const resolveKey = (name) => {
            const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
            let best = null, bestScore = 0;
            for (const k of towerKeys) {
                const kn = k.toLowerCase().replace(/[^a-z0-9]/g, '');
                // exact > starts-with > contains; longest match wins within a tier
                const score = n === kn ? 3 : n.startsWith(kn) ? 2 : n.includes(kn) ? 1 : 0;
                if (score > bestScore || (score > 0 && score === bestScore && kn.length > (best ? best.length : 0))) {
                    best = k; bestScore = score;
                }
            }
            return best || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        };

        // ---- FILE DISCOVERY (3 sources, best first) ----
        //   1. audio/manifest.json -> works EVERYWHERE, incl. GitHub Pages (no dir listing there)
        //   2. directory listing   -> local dev servers (npx http-server, python -m http.server)
        //   3. built-in fallback   -> last resort, so a shipped build is never silent
        // After adding/removing a recording run:  node tools/make-manifest.js
        const fileNames = {};
        for (const d of DIRS) fileNames[d] = [];
        let src = 'none';

        // 1) manifest.json
        try {
            const mr = await fetch('audio/manifest.json', { cache: 'no-store' });
            if (mr.ok) {
                const m = await mr.json();
                for (const dir of DIRS) {
                    const list = m[dir] || m[dir.replace(/\/$/, '')];
                    if (Array.isArray(list)) fileNames[dir] = list.map(f => String(f).split('/').pop());
                }
                if (DIRS.some(d => fileNames[d].length)) {
                    src = 'manifest';
                    console.log('[Audio] discovery: audio/manifest.json');
                }
            }
        } catch (e) { /* no manifest - try directory listing */ }

        // 2) directory listing
        if (src === 'none') {
            for (const dir of DIRS) {
                try {
                    const resp = await fetch(dir);
                    if (resp.ok) {
                        const html = await resp.text();
                        fileNames[dir] = [...html.matchAll(/<a href="\.\/([^"]+\.(?:mp3|wav|ogg))"/gi)]
                            .map(m => decodeURIComponent(m[1]));
                    }
                } catch (e) { /* dir not listable - try next */ }
            }
            if (DIRS.some(d => fileNames[d].length)) {
                src = 'listing';
                console.log('[Audio] discovery: directory listing');
            }
        }

        // 3) turn discovered file names into rotation groups
        if (src !== 'none') {
            for (const dir of DIRS) {
                for (const f of fileNames[dir]) {
                    const base = f.replace(/\.(mp3|wav|ogg)$/i, '');
                    const takeMatch = base.match(/^(\d+)_(.+)_(\d+)$/);
                    if (dir.includes('weapons') && takeMatch) {
                        // NN_Name_Take -> weapon rotation group
                        const key = resolveKey(takeMatch[2]);
                        this.soundCat[key] = 'weapons';
                        (groups[key] = groups[key] || []).push({ take: parseInt(takeMatch[3], 10), file: dir + f });
                    } else {
                        // Plain key (sfx or single-file weapon)
                        const key = resolveKey(base);
                        this.soundCat[key] = dir.includes('weapons') ? 'weapons' : 'sfx';
                        (groups[key] = groups[key] || []).push({ take: 1, file: dir + f });
                    }
                }
            }
        }

        // Fallback: nothing discoverable -> use the known recordings directly
        if (Object.keys(groups).length === 0) {
            console.log('[Audio] discovery: built-in fallback list');
            const FALLBACK = {
                'glock': ['01_Glock_17_1.mp3', '01_Glock_17_2.mp3', '01_Glock_17_3.mp3'],
                'desert_eagle': ['02_Desert_Eagle_1.mp3', '02_Desert_Eagle_2.mp3', '02_Desert_Eagle_3.mp3'],
                'mp5': ['03_MP5_1.mp3', '03_MP5_2.mp3', '03_MP5_3.mp3'],
                'uzi': ['04_UZI_1.mp3', '04_UZI_2.mp3', '04_UZI_3.mp3'],
                'remington': ['05_Remington_870_1.mp3', '05_Remington_870_2.mp3'],
                'aa12': ['06_AA-12_1.mp3', '06_AA-12_2.mp3'],
                'ak47': ['07_AK-47_1.mp3', '07_AK-47_2.mp3', '07_AK-47_3.mp3'],
                'm4a1': ['08_M4A1_1.mp3', '08_M4A1_2.mp3', '08_M4A1_3.mp3'],
                'barrett': ['09_Barrett_M82_1.mp3'],
                'awp': ['10_AWP_1.mp3'],
                'rpg': ['11_RPG-7_1.mp3', '11_RPG-7_2.mp3'],
                'm2browning': ['12_M2-Browning_1.mp3', '12_M2-Browning_2.mp3'],
                'minigun': ['13_M134-Minigun_1.mp3', '13_M134-Minigun_2.mp3', '13_M134-Minigun_3.mp3'],
                'bfg': ['14_BFG-9000_1.mp3', '14_BFG-9000_2.mp3'],
                'railgun': ['15_Railgun_1.mp3', '15_Railgun_2.mp3'],
            };
            for (const [key, list] of Object.entries(FALLBACK)) {
                groups[key] = list.map((f, i) => ({ take: i + 1, file: 'audio/weapons/' + f }));
                this.soundCat[key] = 'weapons';
            }
        }

        // Decode everything + register rotation groups.
        // v1.1.0: load in PARALLEL (6 at a time). The old sequential loop took
        // ~16s on GitHub Pages and the railgun (last in the list) was silent
        // long after players had bought it. Parallel cuts that to ~3s.
        const jobs = [];
        for (const [key, list] of Object.entries(groups)) {
            list.sort((a, b) => a.take - b.take);
            list.forEach((item, i) => jobs.push({ key, item, vk: `${key}__v${i + 1}` }));
        }
        this.audioTotal = jobs.length;
        this.audioLoaded = 0;
        this.setStatus(`🔊 0/${this.audioTotal}`);
        let cursor = 0;
        const worker = async () => {
            while (cursor < jobs.length) {
                const job = jobs[cursor++];
                try {
                    const resp = await fetch(job.item.file);
                    if (!resp.ok) continue;
                    const buf = await resp.arrayBuffer();
                    this.loadedSounds[job.vk] = await this.ctx.decodeAudioData(buf);
                    this.audioLoaded++;
                    if (this.audioLoaded % 5 === 0 || this.audioLoaded === this.audioTotal) {
                        this.setStatus(`🔊 ${this.audioLoaded}/${this.audioTotal}`);
                    }
                } catch (e) { /* broken file - skip */ }
            }
        };
        await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));

        const loaded = [];
        for (const [key, list] of Object.entries(groups)) {
            const variantKeys = list
                .map((_, i) => `${key}__v${i + 1}`)
                .filter(vk => this.loadedSounds[vk]);
            if (variantKeys.length) {
                this.variantGroups[key] = variantKeys;
                this.variantIndex[key] = 0;
                loaded.push(`${key}(${variantKeys.length})`);
            }
        }
        console.log(`[Audio] Loaded ${loaded.length} sounds: ${loaded.join(', ')}`);
        this.loadedCount = Object.keys(this.loadedSounds).length;
        this.setStatus(this.loadedCount ? `🔊 ${this.loadedCount}/${this.audioTotal} ready` : '🔇 no recordings');

        // ---- MISSING SOUND DIAGNOSTIC ----
        // Every key the game asks for but has NO recording (= silent, since synth is off)
        const EXPECTED = [
            'wave_start', 'cant_afford', 'tower_place', 'tower_upgrade', 'tower_sell',
            'boss_appear', 'cash', 'explosion_small', 'explosion_large', 'explosion_massive',
            'hit_flesh', 'enemy_death', 'game_over', 'victory',
        ];
        const missing = EXPECTED.filter(k => !this.loadedSounds[k] && !this.variantGroups[k]);
        if (missing.length) {
            const synthCovered = missing.filter(k => this.synth && this.synth[k]).length;
            console.warn(`[Audio] ${missing.length} SFX have no recording -> ${synthCovered} covered by Aura's synth fallback, ${missing.length - synthCovered} silent.`);
            console.warn(`[Audio] Drop recordings in audio/sfx/<name>.mp3 (see audio/sfx/RECORD_THESE.md) - they auto-load and override the synth.`);
        }

        // startGame() plays wave_start before decode finishes -> replay it now if we missed it
        if (this.pendingStartSound) {
            this.pendingStartSound = false;
            this.play('wave_start');
        }
    },

    cooldownFor(name, cat) {
        const table = {
            hit_flesh: 0.055, enemy_death: 0.06,
            explosion_small: 0.08, explosion_large: 0.12, explosion_massive: 0.2,
            cash: 0.09, tower_place: 0.06, tower_upgrade: 0.06, tower_sell: 0.06,
            cant_afford: 0.25, wave_start: 0.5, boss_appear: 0.5,
            game_over: 1, victory: 1,
        };
        return table[name] !== undefined ? table[name] : (cat === 'weapons' ? 0.06 : 0.05);
    },

    play(name, vol = 1.0) {
        if (!this.ctx) return;
        if (this.muted) return; // settings mute
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const cat = this.soundCat[name] || 'sfx';

        // ---- real-time mix guard (v1.1.0) ----
        // Game speed must NEVER speed up audio. Per-key cooldown caps each gun
        // at ~16 shots/sec of sound, even at 3x speed with 30 towers. The voice
        // budget stops a wall of overlapping buffers from turning into mush.
        const now = this.ctx.currentTime;
        if (now - (this.lastPlayed[name] ?? -999) < this.cooldownFor(name, cat)) return;
        if (cat === 'weapons' && this.weaponVoices >= this.maxWeaponVoices) return;
        if (this.voices >= this.maxVoices) return;

        // SFX (synth) events: hard cap ~26/sec. Late waves trigger hundreds of
        // hit/death sounds per second - without this the AudioContext chokes.
        if (cat === 'sfx') {
            const ms = performance.now();
            while (this.eventTimes.length && ms - this.eventTimes[0] > 1000) this.eventTimes.shift();
            if (this.eventTimes.length >= 26) return;
            this.eventTimes.push(ms);
        }
        this.lastPlayed[name] = now;

        // Variant rotation: cycle loaded variants in order (1-2-3-1-2-3...)
        const group = this.variantGroups[name];
        if (group) {
            const total = group.length;
            // find the next variant that's actually loaded (start at current index)
            for (let i = 0; i < total; i++) {
                const idx = (this.variantIndex[name] + i) % total;
                const buf = this.loadedSounds[group[idx]];
                if (buf) {
                    this.variantIndex[name] = (idx + 1) % total; // advance for next shot
                    this._playBuffer(buf, vol, cat);
                    return;
                }
            }
            // none loaded -> fall through to synth
        }

        if (this.loadedSounds[name]) {
            this._playBuffer(this.loadedSounds[name], vol, cat);
        } else if (this.synth[name] && (this.synthEnabled || cat === 'sfx')) {
            // SFX fall back to Aura's oscillators until a real recording exists
            // (a recording in audio/sfx/ ALWAYS wins). Guns stay recordings-only.
            const busVol = cat === 'weapons' ? this.weaponVolume : this.effectsVolume;
            const sc = vol * busVol;
            if (sc > 0.001) this.synth[name](sc); // exp ramp needs non-zero start
        }
    },

    _playBuffer(buf, vol, cat = 'sfx') {
        if (this.voices >= this.maxVoices) return;
        if (cat === 'weapons' && this.weaponVoices >= this.maxWeaponVoices) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.ctx.createGain();
        // per-sound vol x its bus volume; MASTER rides the shared masterGain
        g.gain.value = vol * (cat === 'weapons' ? this.weaponVolume : this.effectsVolume);
        src.connect(g);
        g.connect(this.masterGain);

        // voice accounting - freed when the buffer finishes
        this.voices++;
        if (cat === 'weapons') this.weaponVoices++;
        let freed = false;
        src.onended = () => {
            if (freed) return;
            freed = true;
            this.voices = Math.max(0, this.voices - 1);
            if (cat === 'weapons') this.weaponVoices = Math.max(0, this.weaponVoices - 1);
            try { g.disconnect(); } catch (e) { /* already gone */ }
        };
        src.start();
    },

    // Create/cache noise buffer for gun sounds. Reusing the same buffer per
    // duration avoids allocating (and GC-stuttering) hundreds of buffers per
    // second when 30 fast guns are shredding a wave.
    _noise(dur) {
        const key = dur.toFixed(3);
        if (this.noiseCache[key]) return this.noiseCache[key];
        const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noiseCache[key] = buf;
        return buf;
    },

    synth: {
        // ============ WEAPON SOUNDS ============
        glock(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.06, 3000, 1, 0.4 * v, t);
            A._playOsc('sine', 700, 80, 0.04, 0.3 * v, t);
        },
        desert_eagle(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.1, 2000, 1, 0.6 * v, t);
            A._playOsc('sine', 400, 50, 0.08, 0.5 * v, t);
            A._playOsc('triangle', 150, 40, 0.12, 0.4 * v, t);
        },
        mp5(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.04, 4000, 1.5, 0.3 * v, t);
            A._playOsc('square', 900, 200, 0.03, 0.2 * v, t);
        },
        uzi(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.03, 5000, 2, 0.25 * v, t);
            A._playOsc('square', 1200, 300, 0.02, 0.15 * v, t);
        },
        remington(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.15, 1500, 0.5, 0.7 * v, t);
            A._playOsc('sine', 200, 30, 0.15, 0.6 * v, t);
            A._playOsc('triangle', 100, 25, 0.2, 0.5 * v, t);
        },
        aa12(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.12, 1800, 0.6, 0.6 * v, t);
            A._playOsc('sine', 180, 35, 0.12, 0.5 * v, t);
        },
        ak47(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.07, 2500, 1.2, 0.5 * v, t);
            A._playOsc('sine', 500, 60, 0.06, 0.4 * v, t);
        },
        m4a1(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.05, 3500, 1.5, 0.4 * v, t);
            A._playOsc('sine', 650, 80, 0.04, 0.3 * v, t);
        },
        barrett(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.25, 1200, 0.4, 0.9 * v, t);
            A._playOsc('sine', 300, 30, 0.2, 0.8 * v, t);
            A._playOsc('triangle', 80, 20, 0.35, 0.7 * v, t);
        },
        awp(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.2, 2000, 0.5, 0.8 * v, t);
            A._playOsc('sine', 350, 40, 0.15, 0.6 * v, t);
            A._playOsc('triangle', 120, 30, 0.25, 0.5 * v, t);
        },
        rpg(v) {
            const t = A.ctx.currentTime;
            // Whoosh
            const noise = A.ctx.createBufferSource();
            noise.buffer = A._noise(0.3);
            const filt = A.ctx.createBiquadFilter();
            filt.type = 'bandpass';
            filt.frequency.setValueAtTime(200, t);
            filt.frequency.exponentialRampToValueAtTime(2000, t + 0.3);
            filt.Q.value = 2;
            const g = A.ctx.createGain();
            g.gain.setValueAtTime(0.5 * v, t);
            g.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
            noise.connect(filt); filt.connect(g); g.connect(A.masterGain);
            noise.start(t); noise.stop(t + 0.35);
            A._playOsc('sine', 100, 400, 0.2, 0.3 * v, t);
        },
        m2browning(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.09, 1800, 0.8, 0.6 * v, t);
            A._playOsc('sine', 250, 40, 0.08, 0.5 * v, t);
            A._playOsc('triangle', 90, 25, 0.1, 0.4 * v, t);
        },
        minigun(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.02, 4500, 2, 0.2 * v, t);
            A._playOsc('square', 1500, 400, 0.015, 0.1 * v, t);
        },
        bfg(v) {
            const t = A.ctx.currentTime;
            // Charge up
            const o1 = A.ctx.createOscillator();
            o1.type = 'sawtooth';
            o1.frequency.setValueAtTime(80, t);
            o1.frequency.exponentialRampToValueAtTime(800, t + 0.4);
            const g1 = A.ctx.createGain();
            g1.gain.setValueAtTime(0.2 * v, t);
            g1.gain.exponentialRampToValueAtTime(0.01, t + 0.4);
            o1.connect(g1); g1.connect(A.masterGain);
            o1.start(t); o1.stop(t + 0.45);
            // Discharge
            const t2 = t + 0.4;
            A._playNoise(0.3, 800, 0.3, 0.8 * v, t2);
            A._playOsc('sine', 60, 15, 0.4, 0.7 * v, t2);
            A._playOsc('sawtooth', 200, 30, 0.2, 0.4 * v, t2);
        },
        railgun(v) {
            const t = A.ctx.currentTime;
            // Electric hum
            const o = A.ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.setValueAtTime(2000, t);
            o.frequency.exponentialRampToValueAtTime(4000, t + 0.2);
            const g = A.ctx.createGain();
            g.gain.setValueAtTime(0.15 * v, t);
            g.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
            o.connect(g); g.connect(A.masterGain);
            o.start(t); o.stop(t + 0.25);
            // Crack
            const t2 = t + 0.2;
            A._playNoise(0.15, 6000, 3, 0.7 * v, t2);
            A._playOsc('sine', 800, 50, 0.1, 0.5 * v, t2);
        },

        // ============ EXPLOSIONS ============
        explosion_small(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.15, 1000, 0.5, 0.4 * v, t);
            A._playOsc('sine', 150, 30, 0.12, 0.3 * v, t);
        },
        explosion_medium(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.3, 800, 0.4, 0.6 * v, t);
            A._playOsc('sine', 100, 20, 0.25, 0.5 * v, t);
            A._playOsc('triangle', 60, 15, 0.3, 0.4 * v, t);
        },
        explosion_large(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.5, 600, 0.3, 0.8 * v, t);
            A._playOsc('sine', 80, 12, 0.4, 0.7 * v, t);
            A._playOsc('triangle', 40, 10, 0.5, 0.6 * v, t);
        },
        explosion_massive(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.8, 500, 0.2, 1.0 * v, t);
            A._playOsc('sine', 60, 8, 0.7, 0.9 * v, t);
            A._playOsc('triangle', 30, 8, 0.8, 0.7 * v, t);
        },

        // ============ IMPACT/HIT ============
        hit_flesh(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.06, 1500, 1, 0.3 * v, t);
            A._playOsc('sine', 200, 60, 0.05, 0.2 * v, t);
        },
        hit_armor(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.04, 6000, 3, 0.4 * v, t);
            A._playOsc('sine', 2000, 500, 0.06, 0.3 * v, t);
        },

        // ============ UI SOUNDS ============
        tower_place(v) {
            const t = A.ctx.currentTime;
            A._playOsc('sine', 300, 100, 0.1, 0.3 * v, t);
            A._playOsc('sine', 500, 200, 0.08, 0.2 * v, t + 0.05);
        },
        tower_upgrade(v) {
            const t = A.ctx.currentTime;
            A._playOsc('sine', 400, 600, 0.1, 0.3 * v, t);
            A._playOsc('sine', 600, 800, 0.1, 0.2 * v, t + 0.08);
        },
        tower_sell(v) {
            const t = A.ctx.currentTime;
            A._playOsc('sine', 800, 400, 0.08, 0.3 * v, t);
            A._playOsc('sine', 600, 200, 0.1, 0.2 * v, t + 0.05);
        },
        cant_afford(v) {
            const t = A.ctx.currentTime;
            A._playOsc('square', 200, 150, 0.15, 0.2 * v, t);
            A._playOsc('square', 150, 100, 0.2, 0.2 * v, t + 0.1);
        },
        wave_start(v) {
            const t = A.ctx.currentTime;
            A._playOsc('sawtooth', 440, 440, 0.3, 0.3 * v, t);
            A._playOsc('sawtooth', 554, 554, 0.3, 0.25 * v, t + 0.15);
            A._playOsc('sawtooth', 659, 659, 0.5, 0.3 * v, t + 0.3);
        },
        cash(v) {
            const t = A.ctx.currentTime;
            A._playOsc('sine', 1200, 800, 0.06, 0.2 * v, t);
            A._playOsc('sine', 1600, 1200, 0.06, 0.15 * v, t + 0.04);
        },
        enemy_death(v) {
            const t = A.ctx.currentTime;
            A._playNoise(0.1, 1200, 1, 0.3 * v, t);
            A._playOsc('sine', 300, 80, 0.1, 0.2 * v, t);
        },
        boss_appear(v) {
            const t = A.ctx.currentTime;
            A._playOsc('sine', 60, 50, 0.8, 0.6 * v, t);
            A._playOsc('sawtooth', 40, 30, 0.6, 0.4 * v, t);
        },
        game_over(v) {
            const t = A.ctx.currentTime;
            A._playOsc('sine', 440, 440, 0.3, 0.4 * v, t);
            A._playOsc('sine', 415, 415, 0.3, 0.4 * v, t + 0.3);
            A._playOsc('sine', 370, 370, 0.3, 0.4 * v, t + 0.6);
            A._playOsc('sine', 311, 311, 0.6, 0.4 * v, t + 0.9);
        },
        victory(v) {
            const t = A.ctx.currentTime;
            [523, 659, 784, 1047].forEach((f, i) => {
                A._playOsc('sine', f, f, 0.2, 0.3 * v, t + i * 0.15);
            });
        },

        // ============ SFX SYNTH — Aura's oscillator work (Spe handles the guns) ============
        // Every one of these is OVERRIDDEN the moment a real recording lands in audio/sfx/.
        wave_start(v) {
            const t = A.ctx.currentTime;
            // military horn: BA - DA - DAAAH
            A._playOsc('sawtooth', 220, 220, 0.14, 0.2 * v, t);
            A._playOsc('sawtooth', 277, 277, 0.14, 0.2 * v, t + 0.16);
            A._playOsc('sawtooth', 330, 330, 0.5, 0.24 * v, t + 0.32);
            A._playOsc('sawtooth', 165, 165, 0.5, 0.16 * v, t + 0.32);
        },
        cant_afford(v) {
            const t = A.ctx.currentTime;
            // low double cluck: "tch-tch"
            A._playOsc('square', 150, 110, 0.08, 0.16 * v, t);
            A._playOsc('square', 150, 90, 0.13, 0.16 * v, t + 0.11);
        },
        tower_place(v) {
            const t = A.ctx.currentTime;
            // heavy bolt-thunk "KA-CHUNK"
            A._playNoise(0.09, 900, 1, 0.3 * v, t);
            A._playOsc('triangle', 180, 60, 0.13, 0.34 * v, t);
        },
        tower_upgrade(v) {
            const t = A.ctx.currentTime;
            // rising power-up "da-DING"
            A._playOsc('sine', 400, 900, 0.18, 0.2 * v, t);
            A._playOsc('sine', 800, 1600, 0.24, 0.13 * v, t + 0.12);
        },
        tower_sell(v) {
            const t = A.ctx.currentTime;
            // cash-out "cha-CHING"
            A._playOsc('sine', 1200, 900, 0.1, 0.18 * v, t);
            A._playOsc('sine', 900, 1500, 0.24, 0.16 * v, t + 0.09);
        },
        cash(v) {
            const t = A.ctx.currentTime;
            // quick coin "CHING!" (fires a lot - keep it snappy)
            A._playOsc('sine', 1400, 1900, 0.07, 0.14 * v, t);
            A._playOsc('sine', 1900, 2400, 0.09, 0.09 * v, t + 0.05);
        },
        enemy_death(v) {
            const t = A.ctx.currentTime;
            // grunt "AUGH" - noise burst pitched down
            A._playNoise(0.14, 700, 1, 0.28 * v, t);
            A._playOsc('sawtooth', 220, 70, 0.18, 0.18 * v, t);
        },
        explosion_small(v) {
            const t = A.ctx.currentTime;
            // "PFUT!"
            A._playNoise(0.18, 900, 0.8, 0.4 * v, t);
            A._playOsc('sine', 160, 45, 0.22, 0.4 * v, t);
        },
        explosion_large(v) {
            const t = A.ctx.currentTime;
            // "KABOOM!"
            A._playNoise(0.35, 600, 0.7, 0.55 * v, t);
            A._playOsc('sine', 110, 35, 0.4, 0.55 * v, t);
            A._playNoise(0.5, 220, 0.6, 0.18 * v, t + 0.05);
        },
        explosion_massive(v) {
            const t = A.ctx.currentTime;
            // "KABLAAAAM!" with rumble
            A._playNoise(0.6, 500, 0.6, 0.6 * v, t);
            A._playOsc('sine', 80, 28, 0.7, 0.6 * v, t);
            A._playNoise(0.9, 160, 0.5, 0.26 * v, t + 0.1);
            A._playOsc('triangle', 55, 30, 0.9, 0.3 * v, t + 0.12);
        },
        hit_flesh(v) {
            const t = A.ctx.currentTime;
            // wet "THWACK" - very short, plays constantly
            A._playNoise(0.06, 500, 1.2, 0.4 * v, t);
            A._playOsc('triangle', 180, 70, 0.07, 0.24 * v, t);
        },
    },

    _playNoise(dur, freq, q, vol, t) {
        const noise = this.ctx.createBufferSource();
        noise.buffer = this._noise(dur);
        const filt = this.ctx.createBiquadFilter();
        filt.type = 'bandpass';
        filt.frequency.value = freq;
        filt.Q.value = q;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        noise.connect(filt); filt.connect(g); g.connect(this.masterGain);
        noise.start(t); noise.stop(t + dur + 0.01);
    },

    _playOsc(type, freqStart, freqEnd, dur, vol, t) {
        const o = this.ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freqStart, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t + dur);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g); g.connect(this.masterGain);
        o.start(t); o.stop(t + dur + 0.01);
    }
};
const A = AudioEngine; // Shorthand

// ============================================================
// GAME CONSTANTS & TOWER DEFINITIONS
// ============================================================
const CANVAS_W = 1000, CANVAS_H = 650;

// ============================================================
// DIFFICULTY (v1.1.0)
// Recruit = the v1.0.1 balance (for the little brother).
// Veteran = new default: same economy, sharper late-wave HP curve.
// Hardcore = fewer lives, less seed money, wave 50 is a war crime.
// ============================================================
const DIFFICULTIES = {
    recruit:  { label: 'RECRUIT',  lives: 20, gold: 1500, hpLin: 0.08, hpLate: 0.05, scoreMult: 1.0, blurb: 'Classic balance' },
    veteran:  { label: 'VETERAN',  lives: 20, gold: 1500, hpLin: 0.10, hpLate: 0.16, scoreMult: 1.5, blurb: 'Sharper late game' },
    hardcore: { label: 'HARDCORE', lives: 15, gold: 1250, hpLin: 0.10, hpLate: 0.22, scoreMult: 2.0, blurb: 'No mercy' },
};
const DEFAULT_DIFFICULTY = 'veteran';
const SCORE_KEY = 'armory_scores';
const MAX_SCORES = 10;

const TOWER_CATEGORIES = [
    { name: 'SIDEARMS', weapons: ['glock', 'desert_eagle'] },
    { name: 'SMGs', weapons: ['mp5', 'uzi'] },
    { name: 'SHOTGUNS', weapons: ['remington', 'aa12'] },
    { name: 'ASSAULT RIFLES', weapons: ['ak47', 'm4a1'] },
    { name: 'SNIPER RIFLES', weapons: ['barrett', 'awp'] },
    { name: 'HEAVY WEAPONS', weapons: ['rpg', 'm2browning', 'minigun'] },
    { name: 'EXPERIMENTAL', weapons: ['bfg', 'railgun'] },
];

const TOWERS = {
    glock: {
        name: 'Glock 17', type: 'Pistol', icon: '🔫',
        cost: 100, range: 120, fireRate: 0.35, damage: 15, bulletSpeed: 8,
        bulletType: 'tracer', color: '#aaaaaa',
        upgrades: [
            { cost: 75, damage: 25, fireRate: 0.3, range: 135 },
            { cost: 150, damage: 40, fireRate: 0.25, range: 150 },
            { cost: 300, damage: 75, fireRate: 0.2, range: 170 },
            { cost: 550, damage: 140, fireRate: 0.15, range: 195 },
        ]
    },
    desert_eagle: {
        name: 'Desert Eagle', type: 'Hand Cannon', icon: '🔫',
        cost: 250, range: 140, fireRate: 0.8, damage: 50, bulletSpeed: 8,
        bulletType: 'tracer', color: '#cc9944',
        upgrades: [
            { cost: 150, damage: 80, fireRate: 0.7, range: 155 },
            { cost: 300, damage: 130, fireRate: 0.6, range: 170 },
            { cost: 550, damage: 240, fireRate: 0.5, range: 190 },
            { cost: 1000, damage: 450, fireRate: 0.4, range: 215 },
        ]
    },
    mp5: {
        name: 'MP5', type: 'SMG', icon: '🔫',
        cost: 200, range: 130, fireRate: 0.12, damage: 8, bulletSpeed: 9,
        bulletType: 'tracer', color: '#8888aa',
        upgrades: [
            { cost: 120, damage: 12, fireRate: 0.1, range: 145 },
            { cost: 250, damage: 18, fireRate: 0.08, range: 160 },
            { cost: 450, damage: 32, fireRate: 0.06, range: 180 },
            { cost: 850, damage: 55, fireRate: 0.05, range: 205 },
        ]
    },
    uzi: {
        name: 'UZI', type: 'SMG', icon: '🔫',
        cost: 180, range: 100, fireRate: 0.07, damage: 6, bulletSpeed: 9,
        bulletType: 'tracer', color: '#778899',
        upgrades: [
            { cost: 100, damage: 10, fireRate: 0.06, range: 110 },
            { cost: 200, damage: 14, fireRate: 0.05, range: 125 },
            { cost: 400, damage: 24, fireRate: 0.04, range: 140 },
            { cost: 750, damage: 40, fireRate: 0.03, range: 160 },
        ]
    },
    remington: {
        name: 'Remington 870', type: 'Shotgun', icon: '🔫',
        cost: 300, range: 100, fireRate: 1.0, damage: 25, bulletSpeed: 7,
        bulletType: 'pellet', pellets: 5, spread: 0.3, color: '#8b4513',
        upgrades: [
            { cost: 180, damage: 40, pellets: 7, range: 110 },
            { cost: 350, damage: 60, pellets: 9, range: 125, fireRate: 0.85 },
            { cost: 650, damage: 100, pellets: 11, range: 140, fireRate: 0.7 },
            { cost: 1200, damage: 170, pellets: 14, range: 160, fireRate: 0.6 },
        ]
    },
    aa12: {
        name: 'AA-12', type: 'Auto Shotgun', icon: '🔫',
        cost: 500, range: 110, fireRate: 0.5, damage: 20, bulletSpeed: 7,
        bulletType: 'pellet', pellets: 4, spread: 0.25, color: '#666655',
        upgrades: [
            { cost: 300, damage: 30, pellets: 5, range: 120, fireRate: 0.45 },
            { cost: 600, damage: 45, pellets: 7, range: 135, fireRate: 0.4 },
            { cost: 1100, damage: 75, pellets: 9, range: 150, fireRate: 0.35 },
            { cost: 2000, damage: 120, pellets: 12, range: 170, fireRate: 0.3 },
        ]
    },
    ak47: {
        name: 'AK-47', type: 'Assault Rifle', icon: '🔫',
        cost: 400, range: 160, fireRate: 0.22, damage: 22, bulletSpeed: 10,
        bulletType: 'tracer', color: '#8b6914',
        upgrades: [
            { cost: 250, damage: 35, fireRate: 0.18, range: 175 },
            { cost: 500, damage: 55, fireRate: 0.15, range: 200 },
            { cost: 950, damage: 95, fireRate: 0.12, range: 225 },
            { cost: 1750, damage: 160, fireRate: 0.1, range: 255 },
        ]
    },
    m4a1: {
        name: 'M4A1', type: 'Assault Rifle', icon: '🔫',
        cost: 450, range: 170, fireRate: 0.18, damage: 18, bulletSpeed: 10,
        bulletType: 'tracer', color: '#556677',
        upgrades: [
            { cost: 280, damage: 30, fireRate: 0.15, range: 185 },
            { cost: 550, damage: 48, fireRate: 0.12, range: 210 },
            { cost: 1000, damage: 80, fireRate: 0.1, range: 235 },
            { cost: 1850, damage: 135, fireRate: 0.08, range: 265 },
        ]
    },
    barrett: {
        name: 'Barrett M82', type: 'Sniper', icon: '🎯',
        cost: 700, range: 350, fireRate: 2.5, damage: 120, bulletSpeed: 16,
        bulletType: 'sniper', pierce: 3, color: '#333344',
        upgrades: [
            { cost: 450, damage: 200, pierce: 5, range: 400, fireRate: 2.2 },
            { cost: 900, damage: 350, pierce: 8, range: 500, fireRate: 1.8 },
            { cost: 1700, damage: 600, pierce: 12, range: 575, fireRate: 1.5 },
            { cost: 3000, damage: 1000, pierce: 16, range: 650, fireRate: 1.2 },
        ]
    },
    awp: {
        name: 'AWP', type: 'Sniper', icon: '🎯',
        cost: 800, range: 400, fireRate: 2.0, damage: 220, bulletSpeed: 16,
        bulletType: 'sniper', pierce: 1, color: '#2a3a2a',
        upgrades: [
            { cost: 500, damage: 380, pierce: 1, range: 450, fireRate: 1.8 },
            { cost: 1000, damage: 650, pierce: 1, range: 550, fireRate: 1.5 },
            { cost: 1900, damage: 1100, pierce: 2, range: 625, fireRate: 1.2 },
            { cost: 3400, damage: 1900, pierce: 3, range: 700, fireRate: 1.0 },
        ]
    },
    rpg: {
        name: 'RPG-7', type: 'Launcher', icon: '💥',
        cost: 900, range: 250, fireRate: 3.0, damage: 80, bulletSpeed: 5,
        bulletType: 'rocket', splash: 70, color: '#556b2f',
        upgrades: [
            { cost: 550, damage: 150, splash: 90, range: 275, fireRate: 2.5 },
            { cost: 1100, damage: 280, splash: 120, range: 300, fireRate: 2.0 },
            { cost: 2100, damage: 500, splash: 150, range: 330, fireRate: 1.7 },
            { cost: 3800, damage: 900, splash: 190, range: 365, fireRate: 1.4 },
        ]
    },
    m2browning: {
        name: 'M2 Browning', type: 'Heavy MG', icon: '🔫',
        cost: 800, range: 250, fireRate: 0.3, damage: 35, bulletSpeed: 12,
        bulletType: 'heavy_tracer', color: '#665544',
        upgrades: [
            { cost: 500, damage: 55, fireRate: 0.25, range: 280 },
            { cost: 1000, damage: 85, fireRate: 0.2, range: 320 },
            { cost: 1900, damage: 145, fireRate: 0.16, range: 350 },
            { cost: 3400, damage: 240, fireRate: 0.13, range: 390 },
        ]
    },
    minigun: {
        name: 'M134 Minigun', type: 'Minigun', icon: '🔥',
        cost: 1200, range: 180, fireRate: 0.04, damage: 8, bulletSpeed: 12,
        bulletType: 'tracer', color: '#555566',
        upgrades: [
            { cost: 700, damage: 12, fireRate: 0.03, range: 200 },
            { cost: 1500, damage: 18, fireRate: 0.025, range: 220 },
            { cost: 2800, damage: 30, fireRate: 0.02, range: 245 },
            { cost: 5000, damage: 50, fireRate: 0.015, range: 275 },
        ]
    },
    bfg: {
        name: 'BFG-9000', type: 'Energy', icon: '💚',
        cost: 2500, range: 280, fireRate: 4.0, damage: 300, bulletSpeed: 4,
        bulletType: 'energy', splash: 80, pierce: 999, color: '#00ff88',
        upgrades: [
            { cost: 1500, damage: 500, splash: 100, range: 320, fireRate: 3.5 },
            { cost: 3000, damage: 900, splash: 130, range: 360, fireRate: 3.0 },
            { cost: 5500, damage: 1600, splash: 165, range: 400, fireRate: 2.5 },
            { cost: 9500, damage: 2800, splash: 210, range: 450, fireRate: 2.0 },
        ]
    },
    railgun: {
        name: 'Railgun', type: 'Experimental', icon: '⚡',
        cost: 3000, range: 350, fireRate: 3.5, damage: 400, bulletSpeed: 20,
        bulletType: 'railgun', pierce: 999, color: '#00aaff',
        upgrades: [
            { cost: 2000, damage: 700, fireRate: 3.0, range: 400 },
            { cost: 4000, damage: 1200, fireRate: 2.5, range: 500 },
            { cost: 7000, damage: 2000, fireRate: 2.0, range: 560 },
            { cost: 12000, damage: 3500, fireRate: 1.6, range: 640 },
        ]
    },
};

// ============================================================
// ENEMY DEFINITIONS
// ============================================================
const ENEMIES = {
    infantry: { name: 'Infantry', hp: 100, speed: 1.2, reward: 20, size: 10, color: '#4a7a4a', shape: 'soldier' },
    scout:    { name: 'Scout',    hp: 60,  speed: 2.5, reward: 16, size: 8,  color: '#4a7aaa', shape: 'runner' },
    heavy:    { name: 'Heavy',    hp: 350, speed: 0.7, reward: 50, size: 14, color: '#aa4a4a', shape: 'armored' },
    apc:      { name: 'APC',      hp: 900, speed: 0.5, reward: 100, size: 18, color: '#666677', shape: 'vehicle' },
    heli:     { name: 'Helo',     hp: 250, speed: 1.8, reward: 70, size: 12, color: '#556655', shape: 'heli', flying: true },
    boss:     { name: 'BOSS',     hp: 6000, speed: 0.35, reward: 500, size: 24, color: '#8844aa', shape: 'boss', isBoss: true },
};

// ============================================================
// WAVE DEFINITIONS (30 waves)
// ============================================================
const WAVES = [
    [{ type: 'infantry', count: 6, interval: 1.0 }],
    [{ type: 'infantry', count: 10, interval: 0.8 }],
    [{ type: 'infantry', count: 8, interval: 0.8 }, { type: 'scout', count: 4, interval: 0.6 }],
    [{ type: 'infantry', count: 12, interval: 0.7 }],
    [{ type: 'scout', count: 12, interval: 0.5 }],
    [{ type: 'infantry', count: 10, interval: 0.6 }, { type: 'heavy', count: 3, interval: 1.5 }],
    [{ type: 'heavy', count: 8, interval: 1.2 }],
    [{ type: 'infantry', count: 15, interval: 0.5 }, { type: 'scout', count: 8, interval: 0.4 }],
    [{ type: 'infantry', count: 10, interval: 0.5 }, { type: 'heavy', count: 5, interval: 1.0 }, { type: 'scout', count: 8, interval: 0.4 }],
    [{ type: 'boss', count: 1, interval: 1 }, { type: 'infantry', count: 15, interval: 0.6 }],
    [{ type: 'scout', count: 20, interval: 0.35 }],
    [{ type: 'heavy', count: 8, interval: 1.0 }, { type: 'scout', count: 8, interval: 0.4 }],
    [{ type: 'infantry', count: 20, interval: 0.4 }, { type: 'scout', count: 12, interval: 0.3 }],
    [{ type: 'apc', count: 5, interval: 2.0 }],
    [{ type: 'heavy', count: 10, interval: 0.8 }, { type: 'apc', count: 3, interval: 2.5 }],
    [{ type: 'heli', count: 10, interval: 0.8 }],
    [{ type: 'scout', count: 15, interval: 0.3 }, { type: 'heavy', count: 10, interval: 0.8 }],
    [{ type: 'apc', count: 6, interval: 1.8 }, { type: 'heavy', count: 8, interval: 1.0 }],
    [{ type: 'heli', count: 12, interval: 0.6 }, { type: 'heavy', count: 10, interval: 0.8 }],
    [{ type: 'boss', count: 2, interval: 3 }, { type: 'heavy', count: 10, interval: 0.8 }, { type: 'scout', count: 10, interval: 0.4 }],
    [{ type: 'scout', count: 25, interval: 0.25 }, { type: 'heli', count: 10, interval: 0.7 }],
    [{ type: 'apc', count: 8, interval: 1.5 }, { type: 'heli', count: 8, interval: 0.8 }],
    [{ type: 'heavy', count: 20, interval: 0.5 }, { type: 'apc', count: 8, interval: 1.5 }],
    [{ type: 'heli', count: 15, interval: 0.5 }, { type: 'heavy', count: 12, interval: 0.7 }],
    [{ type: 'apc', count: 15, interval: 1.0 }],
    [{ type: 'heavy', count: 25, interval: 0.4 }, { type: 'heli', count: 15, interval: 0.5 }],
    [{ type: 'apc', count: 12, interval: 1.0 }, { type: 'heli', count: 15, interval: 0.5 }],
    [{ type: 'heavy', count: 30, interval: 0.35 }, { type: 'apc', count: 15, interval: 1.0 }],
    [{ type: 'heli', count: 20, interval: 0.4 }, { type: 'apc', count: 15, interval: 0.8 }, { type: 'heavy', count: 20, interval: 0.5 }],
    [{ type: 'boss', count: 3, interval: 3 }, { type: 'apc', count: 15, interval: 1.0 }, { type: 'heavy', count: 15, interval: 0.6 }, { type: 'heli', count: 15, interval: 0.5 }],
    // Waves 31-50: endgame. Bosses every 5, final stand on 50.
    // HP scales on the accelerating curve; counts/interval density scale linearly.
    [{ type: 'heli', count: 35, interval: 0.3 }, { type: 'heavy', count: 28, interval: 0.4 }],
    [{ type: 'apc', count: 24, interval: 0.8 }, { type: 'heavy', count: 34, interval: 0.4 }, { type: 'heli', count: 14, interval: 0.6 }],
    [{ type: 'heavy', count: 55, interval: 0.25 }, { type: 'heli', count: 26, interval: 0.35 }],
    [{ type: 'apc', count: 32, interval: 0.7 }, { type: 'heli', count: 34, interval: 0.35 }, { type: 'scout', count: 20, interval: 0.2 }],
    [{ type: 'boss', count: 3, interval: 3 }, { type: 'heavy', count: 40, interval: 0.35 }, { type: 'apc', count: 20, interval: 0.8 }],
    [{ type: 'scout', count: 85, interval: 0.15 }, { type: 'heli', count: 15, interval: 0.6 }],
    [{ type: 'heli', count: 45, interval: 0.25 }, { type: 'heavy', count: 35, interval: 0.35 }, { type: 'apc', count: 12, interval: 1.0 }],
    [{ type: 'apc', count: 40, interval: 0.6 }, { type: 'heavy', count: 45, interval: 0.3 }],
    [{ type: 'heli', count: 55, interval: 0.2 }, { type: 'apc', count: 26, interval: 0.7 }, { type: 'heavy', count: 28, interval: 0.4 }],
    [{ type: 'boss', count: 4, interval: 3 }, { type: 'apc', count: 26, interval: 0.7 }, { type: 'heli', count: 28, interval: 0.35 }, { type: 'heavy', count: 25, interval: 0.45 }],
    [{ type: 'heavy', count: 70, interval: 0.22 }, { type: 'heli', count: 32, interval: 0.3 }, { type: 'scout', count: 25, interval: 0.2 }],
    [{ type: 'apc', count: 48, interval: 0.5 }, { type: 'heavy', count: 50, interval: 0.28 }],
    [{ type: 'heli', count: 60, interval: 0.2 }, { type: 'scout', count: 55, interval: 0.15 }, { type: 'apc', count: 15, interval: 0.9 }],
    [{ type: 'apc', count: 55, interval: 0.45 }, { type: 'heavy', count: 55, interval: 0.28 }, { type: 'heli', count: 25, interval: 0.4 }],
    [{ type: 'boss', count: 5, interval: 3 }, { type: 'heavy', count: 50, interval: 0.3 }, { type: 'heli', count: 32, interval: 0.35 }, { type: 'apc', count: 20, interval: 0.8 }],
    [{ type: 'heli', count: 70, interval: 0.18 }, { type: 'heavy', count: 50, interval: 0.28 }, { type: 'scout', count: 30, interval: 0.18 }],
    [{ type: 'apc', count: 60, interval: 0.4 }, { type: 'heavy', count: 60, interval: 0.25 }, { type: 'heli', count: 35, interval: 0.3 }],
    [{ type: 'scout', count: 110, interval: 0.1 }, { type: 'heli', count: 40, interval: 0.28 }, { type: 'apc', count: 20, interval: 0.8 }],
    [{ type: 'apc', count: 70, interval: 0.35 }, { type: 'heavy', count: 70, interval: 0.22 }, { type: 'heli', count: 45, interval: 0.25 }],
    [{ type: 'boss', count: 8, interval: 3 }, { type: 'apc', count: 45, interval: 0.5 }, { type: 'heavy', count: 55, interval: 0.3 }, { type: 'heli', count: 55, interval: 0.25 }],
];

// ============================================================
// MAP DEFINITIONS
// ============================================================
const MAPS = {
    desert: {
        name: 'Desert Outpost', bg: '#c4a44a', pathColor: '#8b6f3a', gridColor: 'rgba(0,0,0,0.08)', gridDotColor: 'rgba(0,0,0,0.18)',
        decor: '#a08030',
        waypoints: [
            { x: -20, y: 175 }, { x: 275, y: 175 }, { x: 275, y: 375 },
            { x: 125, y: 375 }, { x: 125, y: 575 }, { x: 525, y: 575 },
            { x: 525, y: 275 }, { x: 775, y: 275 }, { x: 775, y: 475 },
            { x: 1020, y: 475 }
        ],
        pathWidth: 40
    },
    urban: {
        name: 'Urban Warfare', bg: '#3a3a3a', pathColor: '#555555', gridColor: 'rgba(255,255,255,0.05)', gridDotColor: 'rgba(255,255,255,0.14)',
        decor: '#444444',
        waypoints: [
            { x: -20, y: 325 }, { x: 175, y: 325 }, { x: 175, y: 125 },
            { x: 475, y: 125 }, { x: 475, y: 575 }, { x: 725, y: 575 },
            { x: 725, y: 225 }, { x: 1020, y: 225 }
        ],
        pathWidth: 40
    },
    arctic: {
        name: 'Arctic Base', bg: '#c8dae8', pathColor: '#8899aa', gridColor: 'rgba(0,0,0,0.06)', gridDotColor: 'rgba(0,0,0,0.16)',
        decor: '#b0c8d8',
        waypoints: [
            { x: -20, y: 125 }, { x: 375, y: 125 }, { x: 375, y: 275 },
            { x: 125, y: 275 }, { x: 125, y: 475 }, { x: 425, y: 475 },
            { x: 425, y: 575 }, { x: 725, y: 575 }, { x: 725, y: 375 },
            { x: 575, y: 375 }, { x: 575, y: 175 }, { x: 925, y: 175 },
            { x: 925, y: 525 }, { x: 1020, y: 525 }
        ],
        pathWidth: 40
    }
};

// ============================================================
// GAME STATE
// ============================================================
const game = {
    state: 'menu', // menu, playing, paused, gameover, victory
    paused: false,
    difficulty: DEFAULT_DIFFICULTY,
    gold: 1500,
    lives: 20,
    score: 0,
    scoreRecorded: false,
    wave: 0,
    maxWaves: 50,
    speed: 1,
    kills: 0,
    selectedMap: 'desert',
    armory: { unlock4: false, unlock5: false },
    selectedTowerType: null,
    selectedTower: null,
    towers: [],
    enemies: [],
    bullets: [],
    particles: [],
    spawnQueue: [],
    spawnTimer: 0,
    waveActive: false,
    autoWave: false,
    autoWaveTimer: 0,
    mouseX: 0,
    mouseY: 0,
    canPlace: false,
    shakeX: 0,
    shakeY: 0,
    shakeMag: 0,
    time: 0,
};

// Canvas & context
let canvas, ctx;

// ============================================================
// INITIALIZATION
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');

    // Menu map selection
    document.querySelectorAll('.map-card').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.map-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            game.selectedMap = card.dataset.map;
        });
    });

    // Difficulty selection (RECRUIT / VETERAN / HARDCORE)
    const diffCards = document.querySelectorAll('.diff-card');
    const selectDifficulty = (key) => {
        if (!DIFFICULTIES[key]) return;
        game.difficulty = key;
        diffCards.forEach(c => c.classList.toggle('selected', c.dataset.diff === key));
        try { localStorage.setItem('armory_difficulty', key); } catch (e) { /* private mode */ }
        updateBestLine();
    };
    diffCards.forEach(card => card.addEventListener('click', () => selectDifficulty(card.dataset.diff)));
    try {
        const saved = localStorage.getItem('armory_difficulty');
        if (saved && DIFFICULTIES[saved]) selectDifficulty(saved);
        else selectDifficulty(game.difficulty);
    } catch (e) { selectDifficulty(game.difficulty); }

    // Draw map previews on menu
    drawMapPreviews();
    fitLayout();
    window.addEventListener('resize', fitLayout);

    // Start button
    document.getElementById('startBtn').addEventListener('click', startGame);

    // Build tower panel
    buildTowerPanel();

    // Wave button
    document.getElementById('startWaveBtn').addEventListener('click', startNextWave);

    // Pause
    document.getElementById('pauseBtn').addEventListener('click', togglePause);

    // Auto-wave
    document.getElementById('autoWaveBtn').addEventListener('click', toggleAutoWave);

    // Speed buttons
    document.querySelectorAll('.speed-btn').forEach(btn => {
        btn.addEventListener('click', () => setGameSpeed(parseInt(btn.dataset.speed)));
    });

    // Upgrade/Sell buttons
    document.getElementById('upgradeBtn').addEventListener('click', upgradeSelectedTower);
    document.getElementById('sellBtn').addEventListener('click', sellSelectedTower);
    document.getElementById('unlock4Btn').addEventListener('click', () => buyTierUnlock(4));
    document.getElementById('unlock5Btn').addEventListener('click', () => buyTierUnlock(5));

    // Canvas mouse events
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); deselectAll(); });

    // Keyboard
    document.addEventListener('keydown', onKeyDown);

    // Settings (gear menu: sound bars + credits)
    wireSettings();

    // High-score board
    document.getElementById('scoresBtn').addEventListener('click', openScores);
    document.getElementById('scoresClose').addEventListener('click', closeScores);
    document.getElementById('scoresModal').addEventListener('click', (e) => {
        if (e.target.id === 'scoresModal') closeScores();
    });

    // Start render loop for menu
    requestAnimationFrame(menuLoop);
});

// ============================================================
// SETTINGS MODAL — gear menu: sound bars + credits
// ============================================================
let settingsPausedGame = false; // did WE pause it when opening? (then resume on close)

function openSettings() {
    // auto-pause so Spe can tweak bars without dying mid-wave
    settingsPausedGame = false;
    if (game.state === 'playing' && !game.paused) {
        togglePause();
        settingsPausedGame = true;
    }
    document.getElementById('settingsModal').style.display = 'flex';
    syncSettingsUI();
}

function closeSettings() {
    document.getElementById('settingsModal').style.display = 'none';
    if (settingsPausedGame && game.state === 'playing' && game.paused) togglePause();
    settingsPausedGame = false;
}

function syncSettingsUI() {
    const pct = v => Math.round(v * 100);
    document.getElementById('volMaster').value = pct(A.masterVolume);
    document.getElementById('volWeapons').value = pct(A.weaponVolume);
    document.getElementById('volEffects').value = pct(A.effectsVolume);
    document.getElementById('volMasterVal').textContent = pct(A.masterVolume) + '%';
    document.getElementById('volWeaponsVal').textContent = pct(A.weaponVolume) + '%';
    document.getElementById('volEffectsVal').textContent = pct(A.effectsVolume) + '%';
    document.getElementById('muteBtn').textContent = A.muted ? '🔇 MUTED — CLICK TO UNMUTE' : '🔊 SOUND ON — CLICK TO MUTE';
    document.getElementById('soundsLoadedCount').textContent = A.audioTotal && A.loadedCount < A.audioTotal
        ? `${A.loadedCount}/${A.audioTotal} (loading…)`
        : A.loadedCount;
}

function wireSettings() {
    const bindBar = (id, valId, prop) => {
        const el = document.getElementById(id);
        el.addEventListener('input', () => {
            A[prop] = parseInt(el.value, 10) / 100;
            A.applyVolumes();
            document.getElementById(valId).textContent = el.value + '%';
        });
    };
    bindBar('volMaster', 'volMasterVal', 'masterVolume');
    bindBar('volWeapons', 'volWeaponsVal', 'weaponVolume');
    bindBar('volEffects', 'volEffectsVal', 'effectsVolume');

    document.getElementById('muteBtn').addEventListener('click', () => {
        A.muted = !A.muted;
        A.applyVolumes();
        syncSettingsUI();
        if (!A.muted) A.play('tower_place'); // audible "we're back" blip
    });

    document.getElementById('testSoundBtn').addEventListener('click', () => {
        // fire a random RECORDED weapon take so you can hear the real mouth guns
        const weaponKeys = Object.keys(A.variantGroups).filter(k => A.soundCat[k] === 'weapons');
        if (weaponKeys.length) {
            const k = weaponKeys[Math.floor(Math.random() * weaponKeys.length)];
            A.play(k);
            showNotification('🔫 ' + (TOWERS[k] ? TOWERS[k].name : k), 'success');
        } else {
            showNotification('No recordings loaded — check audio/weapons/', 'error');
        }
    });

    document.getElementById('settingsBtn').addEventListener('click', openSettings);
    document.getElementById('settingsClose').addEventListener('click', closeSettings);
    document.getElementById('settingsModal').addEventListener('click', (e) => {
        if (e.target.id === 'settingsModal') closeSettings(); // backdrop click
    });
}

function startGame() {
    A.init();
    // First play happens before async decode finishes -> defer it until ready
    if (A.loadedCount === 0) A.pendingStartSound = true;
    else A.play('wave_start');

    const diff = DIFFICULTIES[game.difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY];
    game.state = 'playing';
    game.paused = false;
    game.gold = diff.gold;
    game.lives = diff.lives;
    game.score = 0;
    game.scoreRecorded = false;
    game.wave = 0;
    game.kills = 0;
    game.speed = 1;
    game.towers = [];
    game.enemies = [];
    game.bullets = [];
    game.particles = [];
    game.spawnQueue = [];
    game.waveActive = false;
    game.autoWave = false;
    game.autoWaveTimer = 0;
    game.selectedTowerType = null;
    game.selectedTower = null;
    game.armory = { unlock4: false, unlock5: false };

    document.getElementById('mainMenu').style.display = 'none';
    document.getElementById('gameScreen').style.display = 'block';
    fitLayout();
    const modeEl = document.getElementById('difficultyDisplay');
    if (modeEl) modeEl.textContent = diff.label;

    setGameSpeed(1);
    updateUI();
    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
}

// ============================================================
// MENU RENDER LOOP (for map preview animations)
// ============================================================
let menuAnimTime = 0;
function menuLoop(ts) {
    if (game.state !== 'menu') return;
    menuAnimTime = ts / 1000;
    requestAnimationFrame(menuLoop);
}

// ============================================================
// FIT TO SCREEN (1280x720 laptops / browser zoom)
// ============================================================
function fitLayout() {
    const menu = document.getElementById('mainMenu');
    if (menu && getComputedStyle(menu).display !== 'none') {
        const inner = menu.querySelector('.menu-inner');
        if (inner) {
            inner.style.transform = '';
            const s = Math.min(1,
                (window.innerWidth - 16) / Math.max(1, inner.scrollWidth),
                (window.innerHeight - 16) / Math.max(1, inner.scrollHeight));
            inner.style.transform = s < 0.999 ? `scale(${s.toFixed(4)})` : '';
        }
    }
    const gs = document.getElementById('gameScreen');
    if (gs && getComputedStyle(gs).display !== 'none') {
        gs.style.transform = '';
        const s = Math.min(1,
            (window.innerWidth - 8) / Math.max(1, gs.scrollWidth),
            (window.innerHeight - 8) / Math.max(1, gs.scrollHeight));
        gs.style.transform = s < 0.999 ? `scale(${s.toFixed(4)})` : '';
    }
}

function drawMapPreviews() {    document.querySelectorAll('.map-card').forEach(card => {
        const mapKey = card.dataset.map;
        const previewCanvas = card.querySelector('.map-preview');
        if (!previewCanvas || !MAPS[mapKey]) return;
        const pCtx = previewCanvas.getContext('2d');
        const map = MAPS[mapKey];
        const sx = 180 / CANVAS_W, sy = 120 / CANVAS_H;

        pCtx.fillStyle = map.bg;
        pCtx.fillRect(0, 0, 180, 120);

        // Draw path
        pCtx.strokeStyle = map.pathColor;
        pCtx.lineWidth = 40 * sx;
        pCtx.lineCap = 'round';
        pCtx.lineJoin = 'round';
        pCtx.beginPath();
        map.waypoints.forEach((wp, i) => {
            if (i === 0) pCtx.moveTo(wp.x * sx, wp.y * sy);
            else pCtx.lineTo(wp.x * sx, wp.y * sy);
        });
        pCtx.stroke();
    });
}

// ============================================================
// TOWER PANEL
// ============================================================
function buildTowerPanel() {
    const container = document.getElementById('towerButtons');
    container.innerHTML = '';

    TOWER_CATEGORIES.forEach(cat => {
        const catDiv = document.createElement('div');
        catDiv.className = 'tower-category';
        catDiv.textContent = cat.name;
        container.appendChild(catDiv);

        cat.weapons.forEach(key => {
            const t = TOWERS[key];
            const btn = document.createElement('button');
            btn.className = 'tower-btn';
            btn.dataset.type = key;
            btn.innerHTML = `
                <span class="t-icon">${t.icon}</span>
                <span class="t-info">
                    <div class="t-name">${t.name}</div>
                    <div class="t-type">${t.type}</div>
                </span>
                <span class="t-cost">$${t.cost}</span>
            `;
            btn.addEventListener('click', () => selectTowerType(key));
            container.appendChild(btn);
        });
    });
}

function selectTowerType(type) {
    if (game.gold < TOWERS[type].cost) {
        A.play('cant_afford');
        showNotification('Not enough gold!', 'error');
        return;
    }
    A.play('tower_place', 0.3);
    game.selectedTowerType = type;
    game.selectedTower = null;
    hideUpgradePanel();

    document.querySelectorAll('.tower-btn').forEach(b => b.classList.remove('selected'));
    document.querySelector(`.tower-btn[data-type="${type}"]`)?.classList.add('selected');
}

function deselectAll() {
    game.selectedTowerType = null;
    game.selectedTower = null;
    document.querySelectorAll('.tower-btn').forEach(b => b.classList.remove('selected'));
    hideUpgradePanel();
}

// ============================================================
// UPGRADE PANEL
// ============================================================
function refreshUpgradeButton() {
    const tower = game.selectedTower;
    if (!tower || document.getElementById('upgradePanel').style.display === 'none') return;
    const def = TOWERS[tower.type];
    const upBtn = document.getElementById('upgradeBtn');
    if (tower.level < def.upgrades.length) {
        // Tier gate: ★4/★5 need the one-time Armory Lab unlock
        // (level 2 -> next upgrade IS ★4; level 3 -> next IS ★5)
        if (tower.level === 2 && !game.armory.unlock4) {
            upBtn.textContent = '🔒 UNLOCK TIER 4 IN LAB';
            upBtn.disabled = true;
        } else if (tower.level === 3 && !game.armory.unlock5) {
            upBtn.textContent = '🔒 UNLOCK TIER 5 IN LAB';
            upBtn.disabled = true;
        } else {
            const upCost = def.upgrades[tower.level].cost;
            upBtn.textContent = `⬆ UPGRADE ($${upCost})`;
            upBtn.disabled = game.gold < upCost;
        }
    } else {
        upBtn.textContent = '⭐ MAX LEVEL';
        upBtn.disabled = true;
    }
}

// Nerdy ballistics: sustained DPS (single target) and alpha (first-volley damage)
function calcDps(s) {
    return (s.damage * Math.max(1, s.pellets || 1)) / s.fireRate;
}
function calcAlpha(s) {
    return s.damage * Math.max(1, s.pellets || 1);
}

function showUpgradePanel(tower) {
    const panel = document.getElementById('upgradePanel');
    const def = TOWERS[tower.type];
    const stats = getTowerStats(tower);

    game.selectedTower = tower; // keep selection state in sync with panel
    panel.style.display = 'block';
    document.getElementById('upTowerName').textContent = `${def.name} ★${tower.level + 1}`;

    // --- the nerd numbers ---
    const dps = calcDps(stats);
    const alpha = calcAlpha(stats);
    const lineup = stats.pierce > 1 && stats.pierce < 999;
    const bSpeed = (stats.bulletSpeed || 10) * 60;

    // total invested (for DPS/$1k efficiency)
    let invested = def.cost;
    for (let i = 0; i < tower.level; i++) invested += def.upgrades[i].cost;
    const eff = (dps / invested) * 1000;

    // next-upgrade preview (fresh stats object via getTowerStats)
    let nextHtml;
    if (tower.level < def.upgrades.length) {
        const ns = getTowerStats({ type: tower.type, level: tower.level + 1 });
        const nDps = calcDps(ns);
        const gain = dps > 0 ? ((nDps / dps - 1) * 100) : 0;
        nextHtml = `
            <div class="up-next">
                <div class="next-title">➡ NEXT ★${tower.level + 2} — $${def.upgrades[tower.level].cost}</div>
                <div class="stat-row"><span class="label">Damage</span><span class="val">${stats.damage} <span class="up">→ ${ns.damage}</span></span></div>
                <div class="stat-row"><span class="label">Fire Rate</span><span class="val">${(1 / stats.fireRate).toFixed(1)}/s <span class="up">→ ${(1 / ns.fireRate).toFixed(1)}/s</span></span></div>
                <div class="stat-row"><span class="label">DPS</span><span class="val">${nDps.toFixed(1)} <span class="up">(+${gain.toFixed(0)}%)</span></span></div>
            </div>`;
    } else {
        nextHtml = `<div class="up-next"><div class="next-title">★ MAX LEVEL — sustained DPS ${dps.toFixed(1)}</div></div>`;
    }

    document.getElementById('upTowerStats').innerHTML = `
        <div class="stat-row"><span class="label">Damage</span><span class="val">${stats.damage}</span></div>
        <div class="stat-row"><span class="label">Fire Rate</span><span class="val">${(1 / stats.fireRate).toFixed(1)}/s</span></div>
        <div class="stat-row"><span class="label">DPS</span><span class="val dps">${dps.toFixed(1)}</span></div>
        <div class="stat-row"><span class="label">Alpha / volley</span><span class="val">${alpha}</span></div>
        ${lineup ? `<div class="stat-row"><span class="label">Lineup DPS</span><span class="val dps">${(dps * stats.pierce).toFixed(1)} <span class="dim">×${stats.pierce} pierce</span></span></div>` : ''}
        <div class="stat-row"><span class="label">Range</span><span class="val">${stats.range}</span></div>
        <div class="stat-row"><span class="label">Bullet Speed</span><span class="val">${bSpeed} px/s</span></div>
        ${stats.splash ? `<div class="stat-row"><span class="label">Splash</span><span class="val">${stats.splash}</span></div>` : ''}
        ${stats.pellets ? `<div class="stat-row"><span class="label">Pellets</span><span class="val">${stats.pellets}</span></div>` : ''}
        ${nextHtml}
        <div class="eff-line">💰 $${invested} invested · ${eff.toFixed(0)} DPS per $1k</div>
    `;

    refreshUpgradeButton();

    const sellValue = getSellValue(tower);
    document.getElementById('sellBtn').textContent = `💰 SELL ($${sellValue})`;
}

function hideUpgradePanel() {
    document.getElementById('upgradePanel').style.display = 'none';
}

function getTowerStats(tower) {
    const def = TOWERS[tower.type];
    let stats = { damage: def.damage, fireRate: def.fireRate, range: def.range, splash: def.splash || 0, pierce: def.pierce || 0, pellets: def.pellets || 0, bulletSpeed: def.bulletSpeed || 10 };
    for (let i = 0; i < tower.level; i++) {
        const up = def.upgrades[i];
        if (up.damage) stats.damage = up.damage;
        if (up.fireRate) stats.fireRate = up.fireRate;
        if (up.range) stats.range = up.range;
        if (up.splash) stats.splash = up.splash;
        if (up.pierce) stats.pierce = up.pierce;
        if (up.pellets) stats.pellets = up.pellets;
    }
    return stats;
}

function getSellValue(tower) {
    const def = TOWERS[tower.type];
    let total = def.cost;
    for (let i = 0; i < tower.level; i++) total += def.upgrades[i].cost;
    return Math.floor(total * 0.6);
}

function upgradeSelectedTower() {
    const tower = game.selectedTower;
    if (!tower) return;
    const def = TOWERS[tower.type];
    if (tower.level >= def.upgrades.length) return;

    // Tier gate (U key bypasses the button, not the gate)
    // level 2 -> next upgrade IS ★4; level 3 -> next IS ★5
    if (tower.level === 2 && !game.armory.unlock4) {
        A.play('cant_afford');
        showNotification('Unlock Tier 4 in the Armory Lab first!', 'error');
        return;
    }
    if (tower.level === 3 && !game.armory.unlock5) {
        A.play('cant_afford');
        showNotification('Unlock Tier 5 in the Armory Lab first!', 'error');
        return;
    }

    const cost = def.upgrades[tower.level].cost;
    if (game.gold < cost) {
        A.play('cant_afford');
        showNotification('Not enough gold!', 'error');
        return;
    }

    game.gold -= cost;
    tower.level++;
    tower.spentGold = (tower.spentGold || def.cost) + cost; // keep bookkeeping honest
    A.play('tower_upgrade');
    showNotification(`${def.name} upgraded to ★${tower.level + 1}!`, 'success');
    updateUI();
    showUpgradePanel(tower);
}

function sellSelectedTower() {
    const tower = game.selectedTower;
    if (!tower) return;
    const value = getSellValue(tower);
    game.gold += value;
    game.towers = game.towers.filter(t => t !== tower);
    A.play('tower_sell');
    showNotification(`Sold for $${value}`, 'warning');
    deselectAll();
    updateUI();
}

// One-time global unlocks: buy the tier once, EVERY gun can reach that star level
function buyTierUnlock(tier) {
    if (game.armory['unlock' + tier]) return;
    if (tier === 5 && !game.armory.unlock4) {
        showNotification('Unlock Tier 4 first!', 'error');
        return;
    }
    const cost = tier === 4 ? 10000 : 15000;
    if (game.gold < cost) {
        A.play('cant_afford');
        showNotification('Not enough gold!', 'error');
        return;
    }
    game.gold -= cost;
    game.armory['unlock' + tier] = true;
    A.play('tower_upgrade');
    showNotification(`⚙ TIER ${tier} UNLOCKED! All guns can now reach ★${tier}!`, 'success');
    addScreenShake(3);
    updateUI();
}

// ============================================================
// CANVAS INPUT
// ============================================================
function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    game.mouseX = (e.clientX - rect.left) * (CANVAS_W / rect.width);
    game.mouseY = (e.clientY - rect.top) * (CANVAS_H / rect.height);

    if (game.selectedTowerType) {
        game.canPlace = canPlaceTower(game.mouseX, game.mouseY);
    }
}

function onCanvasClick(e) {
    if (game.state !== 'playing') return;
    const mx = game.mouseX, my = game.mouseY;

    // If placing a tower
    if (game.selectedTowerType) {
        if (game.canPlace && placeTower(game.selectedTowerType, mx, my)) {
            // placed successfully
        } else {
            A.play('cant_afford');
            if (!game.canPlace) showNotification('Cannot place here!', 'error');
            else showNotification('Not enough gold!', 'error');
        }
        return;
    }

    // If clicking on existing tower
    const clicked = game.towers.find(t => {
        const dx = t.x - mx, dy = t.y - my;
        return Math.sqrt(dx * dx + dy * dy) < 20;
    });

    if (clicked) {
        game.selectedTower = clicked;
        showUpgradePanel(clicked);
    } else {
        deselectAll();
    }
}

function onKeyDown(e) {
    // Settings modal owns the keyboard while open (ESC closes it)
    if (document.getElementById('settingsModal').style.display === 'flex') {
        if (e.key === 'Escape') closeSettings();
        return;
    }
    if (document.getElementById('scoresModal').style.display === 'flex') {
        if (e.key === 'Escape') closeScores();
        return;
    }
    if (game.state !== 'playing') return;
    if (e.key === 'Escape') deselectAll();
    if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!game.waveActive) startNextWave();
    }
    if (e.key === 'p' || e.key === 'P') togglePause();
    if (e.key === 'u' || e.key === 'U') upgradeSelectedTower();
    if (e.key === 'a' || e.key === 'A') toggleAutoWave();
    // Speed: number row 1/2/3 OR numpad 1/2/3
    // (e.key is '1' for both layouts with NumLock on; e.code catches NumLock-off numpad)
    const speedByKey = { '1': 1, '2': 2, '3': 3, 'Numpad1': 1, 'Numpad2': 2, 'Numpad3': 3 };
    const spd = speedByKey[e.key] !== undefined ? speedByKey[e.key] : speedByKey[e.code];
    if (spd !== undefined) setGameSpeed(spd);
}

// ============================================================
// TOWER PLACEMENT
// ============================================================
// Grid: towers build ONLY on cell centers (25, 75, 125, ...). Road runs on the same lattice.
const GRID = 50;
function snapToGrid(v) {
    return GRID / 2 + Math.round((v - GRID / 2) / GRID) * GRID;
}

function canPlaceTower(x, y) {
    const map = MAPS[game.selectedMap];
    const gx = snapToGrid(x), gy = snapToGrid(y);
    // Check bounds (cell centers span 25..W-25 / 25..H-25)
    if (gx < 25 || gx > CANVAS_W - 25 || gy < 25 || gy > CANVAS_H - 25) return false;
    // Check path collision: road runs through cell centers, so only road cells are blocked
    if (isOnPath(gx, gy, map.waypoints, map.pathWidth / 2 + 24)) return false;
    // Check tower overlap (one tower per cell)
    return !game.towers.some(t => {
        const dx = t.x - gx, dy = t.y - gy;
        return Math.sqrt(dx * dx + dy * dy) < GRID;
    });
}

function isOnPath(x, y, waypoints, threshold) {
    for (let i = 0; i < waypoints.length - 1; i++) {
        const d = pointSegDist(x, y, waypoints[i].x, waypoints[i].y, waypoints[i + 1].x, waypoints[i + 1].y);
        if (d < threshold) return true;
    }
    return false;
}

function pointSegDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function placeTower(type, x, y) {
    const def = TOWERS[type];
    if (!def || game.gold < def.cost) return false; // stability guard: never go negative
    const gx = snapToGrid(x), gy = snapToGrid(y); // snap to cell center
    game.gold -= def.cost;
    game.towers.push({
        type, x: gx, y: gy, level: 0,
        angle: 0, fireTimer: 0, target: null,
        spentGold: def.cost,
    });
    A.play('tower_place');
    spawnParticles(gx, gy, 'place', 8);
    updateUI();
    return true;
}

// ============================================================
// WAVE SYSTEM
// ============================================================
function startNextWave() {
    if (game.state !== 'playing') return;
    if (game.waveActive || game.wave >= game.maxWaves) return;

    game.wave++;
    game.waveActive = true;
    game.spawnQueue = [];
    game.spawnTimer = 0;
    game.autoWaveTimer = 0;

    const waveDef = WAVES[game.wave - 1];
    let delay = 0;
    waveDef.forEach(group => {
        for (let i = 0; i < group.count; i++) {
            game.spawnQueue.push({ type: group.type, delay });
            delay += group.interval;
        }
    });

    A.play('wave_start');
    showNotification(`Wave ${game.wave} incoming!`, 'warning');

    // Boss alert
    if (waveDef.some(g => ENEMIES[g.type].isBoss)) {
        A.play('boss_appear');
        showNotification('⚠️ BOSS INCOMING! ⚠️', 'error');
    }

    updateUI();
}

function spawnEnemy(type) {
    const def = ENEMIES[type];
    const waypoints = MAPS[game.selectedMap].waypoints;
    // Progressive difficulty: linear scaling through wave 30, then an
    // accelerating (quadratic) endgame curve. The curve is per-difficulty
    // (see DIFFICULTIES): Recruit is the v1.0.1 curve, Veteran/Hardcore ramp
    // much harder after wave 30.
    const diff = DIFFICULTIES[game.difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY];
    const lateBonus = Math.pow(Math.max(0, game.wave - 30), 2) * diff.hpLate;
    const waveScale = 1 + (game.wave - 1) * diff.hpLin + lateBonus;

    game.enemies.push({
        type,
        x: waypoints[0].x,
        y: waypoints[0].y,
        wpIndex: 1,
        hp: Math.floor(def.hp * waveScale),
        maxHp: Math.floor(def.hp * waveScale),
        speed: def.speed,
        reward: Math.floor(def.reward * (1 + game.wave * 0.05)),
        size: def.size,
        color: def.color,
        shape: def.shape,
        flying: def.flying || false,
        isBoss: def.isBoss || false,
        progress: 0,
        distanceTraveled: 0,
    });
}

// ============================================================
// GAME LOOP
// ============================================================
let lastTime = 0;
let fpsCounter = 0, fpsTime = 0, fpsValue = 60;

function gameLoop(timestamp) {
    if (game.state === 'gameover' || game.state === 'victory') return;

    const rawDt = Math.min((timestamp - lastTime) / 1000, 0.1);
    lastTime = timestamp;

    // FPS counter
    fpsCounter++;
    fpsTime += rawDt;
    if (fpsTime >= 1) {
        fpsValue = fpsCounter;
        fpsCounter = 0;
        fpsTime = 0;
        const fpsEl = document.getElementById('fpsDisplay');
        if (fpsEl) fpsEl.textContent = fpsValue + ' FPS';
    }

    if (game.state === 'playing' && !game.paused) {
        update(rawDt * game.speed);
    }

    render();
    requestAnimationFrame(gameLoop);
}

// Set game speed (1x/2x/3x) and sync the speed buttons — used by clicks AND hotkeys
function setGameSpeed(speed) {
    game.speed = speed;
    document.querySelectorAll('.speed-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.speed) === speed);
    });
}

function togglePause() {
    if (game.state !== 'playing') return;
    game.paused = !game.paused;
    document.getElementById('pauseBtn').textContent = game.paused ? '▶' : '⏸';
    if (game.paused) showNotification('PAUSED', 'warning');
}

function toggleAutoWave() {
    if (game.state !== 'playing') return;
    game.autoWave = !game.autoWave;
    game.autoWaveTimer = 0;
    const btn = document.getElementById('autoWaveBtn');
    btn.classList.toggle('active', game.autoWave);
    btn.textContent = game.autoWave ? 'AUTO ON' : 'AUTO';
    showNotification(game.autoWave ? '⚡ AUTO-WAVE ON — next wave starts automatically' : 'AUTO-WAVE OFF', game.autoWave ? 'success' : 'warning');
}

// ============================================================
// UPDATE LOGIC
// ============================================================
function update(dt) {
    if (game.state !== 'playing') return;
    game.time += dt;

    // Auto-wave: 1.5s breather after a clear, then send the next one
    if (game.autoWave && !game.waveActive && game.wave < game.maxWaves && game.enemies.length === 0) {
        game.autoWaveTimer += dt;
        if (game.autoWaveTimer >= 1.5) {
            game.autoWaveTimer = 0;
            startNextWave();
        }
    }

    // Screen shake decay
    if (game.shakeMag > 0.1) {
        game.shakeX = (Math.random() - 0.5) * game.shakeMag;
        game.shakeY = (Math.random() - 0.5) * game.shakeMag;
        game.shakeMag *= 0.9;
    } else {
        game.shakeX = 0;
        game.shakeY = 0;
        game.shakeMag = 0;
    }

    // Spawn enemies
    if (game.waveActive && game.spawnQueue.length > 0) {
        game.spawnTimer += dt;
        while (game.spawnQueue.length > 0 && game.spawnQueue[0].delay <= game.spawnTimer) {
            const item = game.spawnQueue.shift();
            spawnEnemy(item.type);
        }
    }

    // Check wave complete
    if (game.waveActive && game.spawnQueue.length === 0 && game.enemies.length === 0) {
        game.waveActive = false;
        if (game.wave >= game.maxWaves) {
            victory();
            return;
        }
        // Wave completion bonus
        const bonus = 100 + game.wave * 25;
        game.gold += bonus;
        A.play('cash');
        showNotification(`Wave ${game.wave} cleared! +$${bonus} bonus`, 'success');
        updateUI();
    }

    updateEnemies(dt);
    if (game.state !== 'playing') return;
    updateTowers(dt);
    updateBullets(dt);
    updateParticles(dt);
}

function updateEnemies(dt) {
    const waypoints = MAPS[game.selectedMap].waypoints;

    for (let i = game.enemies.length - 1; i >= 0; i--) {
        const e = game.enemies[i];

        if (e.hp <= 0) {
            // Death
            game.gold += e.reward;
            game.score += Math.round(e.reward * 2 * (DIFFICULTIES[game.difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY]).scoreMult);
            game.kills++;
            A.play(e.isBoss ? 'explosion_large' : 'enemy_death', e.isBoss ? 1 : 0.3);
            spawnParticles(e.x, e.y, 'death', e.isBoss ? 25 : 8);
            if (e.isBoss) addScreenShake(8);
            game.enemies.splice(i, 1);
            updateUI();
            continue;
        }

        // Move toward next waypoint
        if (e.wpIndex < waypoints.length) {
            const target = waypoints[e.wpIndex];
            const dx = target.x - e.x;
            const dy = target.y - e.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const moveSpeed = e.speed * 60 * dt;

            if (dist <= moveSpeed) {
                e.x = target.x;
                e.y = target.y;
                e.wpIndex++;
            } else {
                e.x += (dx / dist) * moveSpeed;
                e.y += (dy / dist) * moveSpeed;
            }
            e.distanceTraveled += moveSpeed;
        } else {
            // Reached end - lose life
            game.lives -= e.isBoss ? 5 : 1;
            A.play('explosion_small');
            spawnParticles(e.x, e.y, 'leak', 6);
            game.enemies.splice(i, 1);
            updateUI();

            if (game.lives <= 0) {
                gameOver();
                return;
            }
        }
    }
}

// Deflection aiming: solve where the enemy WILL be when the bullet arrives.
// Fixed-point iteration — converges because every bullet outruns every enemy
// (slowest bullet 240px/s vs fastest enemy 150px/s).
function leadTarget(tower, enemy, stats) {
    const wps = MAPS[game.selectedMap].waypoints;
    const dx0 = enemy.x - tower.x, dy0 = enemy.y - tower.y;
    let vx = 0, vy = 0;
    if (enemy.wpIndex < wps.length) {
        const wp = wps[enemy.wpIndex];
        const dx = wp.x - enemy.x, dy = wp.y - enemy.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const v = enemy.speed * 60; // px/s
        vx = (dx / d) * v;
        vy = (dy / d) * v;
    }
    const bs = (stats.bulletSpeed || 10) * 60; // px/s
    let t = Math.sqrt(dx0 * dx0 + dy0 * dy0) / bs;
    for (let i = 0; i < 3; i++) {
        t = Math.sqrt((dx0 + vx * t) * (dx0 + vx * t) + (dy0 + vy * t) * (dy0 + vy * t)) / bs;
    }
    return Math.atan2(dy0 + vy * t, dx0 + vx * t);
}

function updateTowers(dt) {
    game.towers.forEach(tower => {
        const stats = getTowerStats(tower);
        tower.fireTimer -= dt;

        // Find target (first enemy in range = furthest along path)
        let bestEnemy = null;
        let bestProgress = -1;
        for (const e of game.enemies) {
            const dx = e.x - tower.x, dy = e.y - tower.y;
            if (Math.sqrt(dx * dx + dy * dy) <= stats.range) {
                if (e.distanceTraveled > bestProgress) {
                    bestProgress = e.distanceTraveled;
                    bestEnemy = e;
                }
            }
        }

        if (bestEnemy) {
            tower.target = bestEnemy;
            // Deflection aim: lead fast movers. Hitscan railgun aims at the
            // CURRENT position instead — no travel time to compensate for.
            const def = TOWERS[tower.type];
            if (def.bulletType === 'railgun') {
                tower.angle = Math.atan2(bestEnemy.y - tower.y, bestEnemy.x - tower.x);
            } else {
                tower.angle = leadTarget(tower, bestEnemy, stats);
            }

            // Fire
            if (tower.fireTimer <= 0) {
                fireTower(tower, bestEnemy, stats);
                tower.fireTimer = stats.fireRate;
            }
        }
    });
}

function fireTower(tower, target, stats) {
    const def = TOWERS[tower.type];
    const audioName = tower.type;

    // Play sound on a REAL-TIME clock, not game time. The old code spaced fast
    // guns by their in-game fire rate, so 3x speed fired 3x the sounds into the
    // mix (and 30 towers could stack 100+ voices/sec). Now every tower gets one
    // sound every ~110ms of wall time no matter what speed the game is at.
    const nowMs = performance.now();
    if (!tower.nextSoundAt || nowMs >= tower.nextSoundAt) {
        A.play(audioName, stats.fireRate < 0.1 ? 0.42 : 0.5);
        tower.nextSoundAt = nowMs + (stats.fireRate < 0.1 ? 110 : 45);
    }

    // Muzzle flash
    const mx = tower.x + Math.cos(tower.angle) * 18;
    const my = tower.y + Math.sin(tower.angle) * 18;
    spawnParticles(mx, my, 'muzzle', 3);

    // Shell casing
    spawnParticles(tower.x, tower.y, 'shell', 1);

    if (stats.pellets) {
        // Shotgun - multiple pellets
        for (let i = 0; i < stats.pellets; i++) {
            const spread = (Math.random() - 0.5) * (def.spread * 2);
            game.bullets.push(createBullet(tower, target, stats, tower.angle + spread));
        }
    } else if (def.bulletType === 'railgun') {
        // Railgun - instant beam
        fireRailgun(tower, stats);
    } else {
        game.bullets.push(createBullet(tower, target, stats, tower.angle));
    }
}

function createBullet(tower, target, stats, angle) {
    const def = TOWERS[tower.type];
    const bSpeed = stats.bulletSpeed || def.bulletSpeed || 10;
    return {
        x: tower.x + Math.cos(angle) * 18,
        y: tower.y + Math.sin(angle) * 18,
        vx: Math.cos(angle) * bSpeed,
        vy: Math.sin(angle) * bSpeed,
        damage: stats.damage,
        splash: stats.splash || 0,
        pierce: stats.pierce || 1,
        speed: bSpeed,
        bulletType: def.bulletType || 'tracer',
        color: def.color,
        life: 3,
        hitEnemies: [],
        trailX: [],
        trailY: [],
    };
}

function fireRailgun(tower, stats) {
    // Sound is already played by fireTower's generic handler
    addScreenShake(5);

    // Beam goes in tower.angle direction, hits all enemies in line
    const dx = Math.cos(tower.angle);
    const dy = Math.sin(tower.angle);

    // Visual beam particle (longer + brighter than v1.0.1 so it reads as a
    // hit even with the sound muted - this was the "railgun does nothing" feel)
    pushParticle({
        type: 'railgun_beam',
        x: tower.x, y: tower.y,
        angle: tower.angle,
        length: stats.range,
        life: 0.45, maxLife: 0.45,
        color: '#7fe8ff',
    });

    // Hit all enemies near the beam line
    game.enemies.forEach(e => {
        const ex = e.x - tower.x;
        const ey = e.y - tower.y;
        const proj = ex * dx + ey * dy; // Projection along beam
        if (proj < 0 || proj > stats.range) return;
        const perpDist = Math.abs(ex * dy - ey * dx); // Perpendicular distance
        if (perpDist < e.size + 8) {
            damageEnemy(e, stats.damage);
            spawnParticles(e.x, e.y, 'hit', 4);

            // Impact ring + damage number: unmistakable feedback
            pushParticle({
                type: 'railgun_impact', x: e.x, y: e.y,
                life: 0.32, maxLife: 0.32, size: e.size + 6,
                vx: 0, vy: 0, color: '#aef4ff',
            });
            pushParticle({
                type: 'damage_number', x: e.x, y: e.y - e.size - 6,
                life: 0.75, maxLife: 0.75, vx: 0, vy: -1.1,
                color: '#eaffff', text: String(stats.damage),
            });
        }
    });
}

function damageEnemy(enemy, dmg) {
    enemy.hp -= dmg;
}

// ============================================================
// BULLET UPDATE
// ============================================================
function updateBullets(dt) {
    for (let i = game.bullets.length - 1; i >= 0; i--) {
        const b = game.bullets[i];

        // Trail
        b.trailX.push(b.x);
        b.trailY.push(b.y);
        if (b.trailX.length > 5) { b.trailX.shift(); b.trailY.shift(); }

        // Sweep the full travel segment this frame — at 3x game speed or vs
        // fast movers, a tip-only point check tunnels straight through hitboxes
        const prevX = b.x, prevY = b.y;
        b.x += b.vx * dt * 60;
        b.y += b.vy * dt * 60;
        b.life -= dt;

        if (b.life <= 0 || b.x < -50 || b.x > CANVAS_W + 50 || b.y < -50 || b.y > CANVAS_H + 50) {
            // Rocket explodes at end of life
            if (b.bulletType === 'rocket' && b.life <= 0) {
                explodeAt(b.x, b.y, b.splash, b.damage * 0.5);
            }
            game.bullets.splice(i, 1);
            continue;
        }

        // Check enemy hits (segment sweep: point-to-SEGMENT distance)
        let hit = false;
        for (const e of game.enemies) {
            if (b.hitEnemies.includes(e)) continue;
            if (pointSegDist(e.x, e.y, prevX, prevY, b.x, b.y) < e.size + 4) {
                // Hit!
                b.hitEnemies.push(e);

                if (b.bulletType === 'rocket' || b.bulletType === 'energy') {
                    // Splash damage
                    explodeAt(b.x, b.y, b.splash, b.damage);
                    A.play(b.bulletType === 'energy' ? 'explosion_massive' : 'explosion_large', 0.5);
                    addScreenShake(b.bulletType === 'energy' ? 6 : 3);
                    spawnParticles(b.x, b.y, 'explosion', b.bulletType === 'energy' ? 30 : 15);
                    game.bullets.splice(i, 1);
                    hit = true;
                    break;
                } else {
                    damageEnemy(e, b.damage);
                    spawnParticles(e.x, e.y, 'hit', 3);
                    A.play('hit_flesh', 0.15);

                    b.pierce--;
                    if (b.pierce <= 0) {
                        game.bullets.splice(i, 1);
                        hit = true;
                        break;
                    }
                }
            }
        }
    }
}

function explodeAt(x, y, radius, damage) {
    // Damage all enemies in radius
    game.enemies.forEach(e => {
        const dx = e.x - x, dy = e.y - y;
        if (Math.sqrt(dx * dx + dy * dy) < radius + e.size) {
            damageEnemy(e, damage);
        }
    });
    spawnParticles(x, y, 'explosion', 12);
    addScreenShake(2);
}

// ============================================================
// PARTICLE SYSTEM
// ============================================================
const MAX_PARTICLES = 800; // hard cap: 3x speed + 30 towers = particle flood

function pushParticle(p) {
    if (game.particles.length >= MAX_PARTICLES) game.particles.splice(0, 120);
    game.particles.push(p);
}

function spawnParticles(x, y, type, count) {
    if (game.particles.length + count > MAX_PARTICLES) {
        game.particles.splice(0, Math.min(game.particles.length, game.particles.length + count - MAX_PARTICLES));
    }
    for (let i = 0; i < count; i++) {
        const p = { x, y, type, life: 0, vx: 0, vy: 0, size: 2, color: '#fff', gravity: 0 };
        switch (type) {
            case 'muzzle':
                p.vx = (Math.random() - 0.5) * 6;
                p.vy = (Math.random() - 0.5) * 6;
                p.life = p.maxLife = 0.08 + Math.random() * 0.05;
                p.size = 2 + Math.random() * 3;
                p.color = ['#ffaa00', '#ff6600', '#ffff44'][Math.floor(Math.random() * 3)];
                break;
            case 'shell':
                p.vx = (Math.random() - 0.5) * 3;
                p.vy = -2 - Math.random() * 2;
                p.life = p.maxLife = 0.5 + Math.random() * 0.3;
                p.size = 1.5;
                p.color = '#ccaa44';
                p.gravity = 15;
                break;
            case 'explosion':
                const a = Math.random() * Math.PI * 2;
                const spd = 1 + Math.random() * 5;
                p.vx = Math.cos(a) * spd;
                p.vy = Math.sin(a) * spd;
                p.life = p.maxLife = 0.3 + Math.random() * 0.4;
                p.size = 3 + Math.random() * 6;
                p.color = ['#ff4400', '#ff8800', '#ffcc00', '#ff2200'][Math.floor(Math.random() * 4)];
                break;
            case 'death':
                const da = Math.random() * Math.PI * 2;
                const dspd = 1 + Math.random() * 3;
                p.vx = Math.cos(da) * dspd;
                p.vy = Math.sin(da) * dspd;
                p.life = p.maxLife = 0.4 + Math.random() * 0.3;
                p.size = 2 + Math.random() * 3;
                p.color = '#ff4444';
                break;
            case 'hit':
                const ha = Math.random() * Math.PI * 2;
                p.vx = Math.cos(ha) * (1 + Math.random() * 2);
                p.vy = Math.sin(ha) * (1 + Math.random() * 2);
                p.life = p.maxLife = 0.2 + Math.random() * 0.1;
                p.size = 1.5 + Math.random() * 2;
                p.color = '#ffaa44';
                break;
            case 'place':
                const pa = Math.random() * Math.PI * 2;
                p.vx = Math.cos(pa) * 2;
                p.vy = Math.sin(pa) * 2;
                p.life = p.maxLife = 0.3;
                p.size = 2 + Math.random() * 2;
                p.color = '#00ff88';
                break;
            case 'leak':
                p.vx = (Math.random() - 0.5) * 4;
                p.vy = (Math.random() - 0.5) * 4;
                p.life = p.maxLife = 0.5;
                p.size = 3 + Math.random() * 3;
                p.color = '#ff4444';
                break;
        }
        p.maxLife = p.life;
        pushParticle(p);
    }
}

function updateParticles(dt) {
    for (let i = game.particles.length - 1; i >= 0; i--) {
        const p = game.particles[i];
        p.life -= dt;
        if (p.life <= 0) {
            game.particles.splice(i, 1);
            continue;
        }
        p.x += p.vx * dt * 60;
        p.y += p.vy * dt * 60;
        if (p.gravity) p.vy += p.gravity * dt;
    }
}

function addScreenShake(mag) {
    game.shakeMag = Math.max(game.shakeMag, mag);
}

// ============================================================
// RENDERING
// ============================================================
function render() {
    if (!ctx) return;
    ctx.save();
    ctx.translate(game.shakeX, game.shakeY);

    const map = MAPS[game.selectedMap];

    // Background
    ctx.fillStyle = map.bg;
    ctx.fillRect(-10, -10, CANVAS_W + 20, CANVAS_H + 20);

    // Grid (cell lattice — towers snap to cell centers)
    ctx.strokeStyle = map.gridColor;
    ctx.lineWidth = 1;
    for (let x = 0; x <= CANVAS_W; x += GRID) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_H; y += GRID) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
    }
    // Buildable cell-center dots
    ctx.fillStyle = map.gridDotColor;
    for (let x = GRID / 2; x < CANVAS_W; x += GRID) {
        for (let y = GRID / 2; y < CANVAS_H; y += GRID) {
            ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
        }
    }

    drawPath(ctx, map);
    drawDecorations(ctx, map);
    drawTowers(ctx);
    drawEnemies(ctx);
    drawBullets(ctx);
    drawParticles(ctx);
    drawPlacementPreview(ctx, map);

    ctx.restore();
}

function drawPath(c, map) {
    c.strokeStyle = map.pathColor;
    c.lineWidth = map.pathWidth;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    map.waypoints.forEach((wp, i) => {
        if (i === 0) c.moveTo(wp.x, wp.y);
        else c.lineTo(wp.x, wp.y);
    });
    c.stroke();

    // Path border
    c.strokeStyle = 'rgba(0,0,0,0.2)';
    c.lineWidth = map.pathWidth + 4;
    c.globalCompositeOperation = 'destination-over';
    c.beginPath();
    map.waypoints.forEach((wp, i) => {
        if (i === 0) c.moveTo(wp.x, wp.y);
        else c.lineTo(wp.x, wp.y);
    });
    c.stroke();
    c.globalCompositeOperation = 'source-over';

    // Entry/exit markers
    const start = map.waypoints[0];
    const end = map.waypoints[map.waypoints.length - 1];
    c.fillStyle = '#ff4444';
    c.font = 'bold 12px Courier New';
    c.fillText('▶ IN', 5, start.y - 25);
    c.fillText('OUT ▶', CANVAS_W - 40, end.y - 25);
}

function drawDecorations(c, map) {
    // Simple terrain decoration based on map type
    c.globalAlpha = 0.15;
    if (game.selectedMap === 'desert') {
        // Rocks
        for (let i = 0; i < 12; i++) {
            const x = (i * 137 + 50) % CANVAS_W;
            const y = (i * 89 + 30) % CANVAS_H;
            if (isOnPath(x, y, map.waypoints, map.pathWidth + 20)) continue;
            c.fillStyle = '#8b7332';
            c.fillRect(x, y, 8 + (i % 5) * 3, 6 + (i % 3) * 2);
        }
    } else if (game.selectedMap === 'urban') {
        // Building blocks
        for (let i = 0; i < 8; i++) {
            const x = (i * 173 + 30) % (CANVAS_W - 60);
            const y = (i * 111 + 20) % (CANVAS_H - 60);
            if (isOnPath(x + 20, y + 20, map.waypoints, map.pathWidth + 30)) continue;
            c.fillStyle = '#555';
            c.fillRect(x, y, 40 + (i % 3) * 15, 35 + (i % 2) * 15);
        }
    } else if (game.selectedMap === 'arctic') {
        // Ice crystals
        for (let i = 0; i < 15; i++) {
            const x = (i * 113 + 40) % CANVAS_W;
            const y = (i * 97 + 25) % CANVAS_H;
            if (isOnPath(x, y, map.waypoints, map.pathWidth + 15)) continue;
            c.fillStyle = '#ddeeff';
            c.beginPath();
            c.moveTo(x, y - 5);
            c.lineTo(x + 4, y + 3);
            c.lineTo(x - 4, y + 3);
            c.fill();
        }
    }
    c.globalAlpha = 1;
}

function drawTowers(c) {
    game.towers.forEach(tower => {
        const def = TOWERS[tower.type];
        const stats = getTowerStats(tower);

        // Base pad
        c.fillStyle = '#2a2a2a';
        c.fillRect(tower.x - 14, tower.y - 14, 28, 28);
        c.strokeStyle = '#444';
        c.lineWidth = 1;
        c.strokeRect(tower.x - 14, tower.y - 14, 28, 28);

        // Selected tower highlight
        if (tower === game.selectedTower) {
            c.strokeStyle = '#00ff88';
            c.lineWidth = 2;
            c.strokeRect(tower.x - 16, tower.y - 16, 32, 32);
            // Range circle
            c.strokeStyle = 'rgba(0,255,136,0.3)';
            c.lineWidth = 1;
            c.beginPath();
            c.arc(tower.x, tower.y, stats.range, 0, Math.PI * 2);
            c.stroke();
            c.fillStyle = 'rgba(0,255,136,0.05)';
            c.fill();
        }

        // Draw gun
        c.save();
        c.translate(tower.x, tower.y);
        c.rotate(tower.angle);
        drawGunShape(c, tower.type, tower.level);
        c.restore();

        // Level stars
        c.fillStyle = '#ffd700';
        c.font = '8px Courier New';
        c.textAlign = 'center';
        for (let i = 0; i <= tower.level; i++) {
            c.fillText('★', tower.x - 6 + i * 7, tower.y + 22);
        }
        c.textAlign = 'left';
    });
}

function drawGunShape(c, type, level) {
    const s = 1 + level * 0.1;
    c.save();
    c.scale(s, s);

    switch (type) {
        case 'glock':
            c.fillStyle = '#999';
            c.fillRect(-6, -3, 14, 6);
            c.fillStyle = '#777';
            c.fillRect(8, -1.5, 6, 3);
            c.fillStyle = '#666';
            c.fillRect(-6, 3, 5, 7);
            break;
        case 'desert_eagle':
            c.fillStyle = '#b8944a';
            c.fillRect(-8, -4, 18, 8);
            c.fillStyle = '#997733';
            c.fillRect(10, -2.5, 8, 5);
            c.fillStyle = '#776622';
            c.fillRect(-8, 4, 6, 8);
            break;
        case 'mp5':
            c.fillStyle = '#778';
            c.fillRect(-6, -3, 16, 6);
            c.fillStyle = '#667';
            c.fillRect(10, -2, 10, 4);
            c.fillStyle = '#556';
            c.fillRect(5, 3, 4, 5);
            c.fillRect(-10, -2, 4, 4);
            c.fillRect(-2, 3, 4, 7);
            break;
        case 'uzi':
            c.fillStyle = '#778';
            c.fillRect(-5, -4, 12, 8);
            c.fillStyle = '#667';
            c.fillRect(7, -1.5, 7, 3);
            c.fillStyle = '#556';
            c.fillRect(-2, 4, 4, 6);
            c.fillRect(-1, -6, 2, 2);
            break;
        case 'remington':
            c.fillStyle = '#8B4513';
            c.fillRect(-8, -3, 18, 6);
            c.fillStyle = '#666';
            c.fillRect(10, -2, 14, 4);
            c.fillStyle = '#8B4513';
            c.fillRect(13, 2, 6, 3);
            c.fillRect(-8, -2, 4, 4);
            break;
        case 'aa12':
            c.fillStyle = '#666655';
            c.fillRect(-6, -4, 16, 8);
            c.fillStyle = '#555544';
            c.fillRect(10, -2, 12, 4);
            c.fillStyle = '#444433';
            c.beginPath();
            c.arc(-2, 5, 5, 0, Math.PI * 2);
            c.fill();
            break;
        case 'ak47':
            c.fillStyle = '#8B6914';
            c.fillRect(-6, -3, 16, 6);
            c.fillStyle = '#555';
            c.fillRect(10, -2, 14, 4);
            c.fillStyle = '#666';
            c.beginPath();
            c.moveTo(0, 3);
            c.quadraticCurveTo(3, 9, 0, 11);
            c.lineTo(-4, 11);
            c.quadraticCurveTo(-1, 9, -4, 3);
            c.fill();
            c.fillStyle = '#555';
            c.fillRect(10, -4, 10, 2);
            break;
        case 'm4a1':
            c.fillStyle = '#556677';
            c.fillRect(-6, -3, 16, 6);
            c.fillStyle = '#445566';
            c.fillRect(10, -1.5, 14, 3);
            c.fillStyle = '#445566';
            c.fillRect(2, -6, 10, 3);
            c.fillStyle = '#556677';
            c.fillRect(-1, 3, 4, 8);
            break;
        case 'barrett':
            c.fillStyle = '#333';
            c.fillRect(-8, -4, 20, 8);
            c.fillStyle = '#444';
            c.fillRect(12, -2, 26, 4);
            c.fillStyle = '#222';
            c.fillRect(0, -8, 12, 4);
            c.fillStyle = '#4488ff';
            c.fillRect(11, -7, 2, 2);
            c.strokeStyle = '#555';
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(30, 2); c.lineTo(34, 8);
            c.moveTo(30, 2); c.lineTo(26, 8);
            c.stroke();
            c.fillStyle = '#333';
            c.fillRect(36, -3, 5, 6);
            break;
        case 'awp':
            c.fillStyle = '#2a3a2a';
            c.fillRect(-8, -4, 20, 8);
            c.fillStyle = '#1a2a1a';
            c.fillRect(12, -2, 28, 4);
            c.fillStyle = '#111';
            c.fillRect(-2, -9, 16, 5);
            c.fillStyle = '#ff4444';
            c.fillRect(13, -8, 2, 2);
            c.fillStyle = '#222';
            c.fillRect(10, -4, 3, 2);
            c.fillStyle = '#2a3a2a';
            c.fillRect(38, -3, 3, 6);
            break;
        case 'rpg':
            c.fillStyle = '#556b2f';
            c.fillRect(-8, -4, 26, 8);
            c.fillStyle = '#888';
            c.beginPath();
            c.moveTo(18, -3); c.lineTo(26, 0); c.lineTo(18, 3);
            c.fill();
            c.fillStyle = '#444';
            c.fillRect(-2, 4, 4, 6);
            c.fillStyle = '#333';
            c.fillRect(4, -7, 3, 3);
            c.fillStyle = '#666';
            c.fillRect(-10, -2, 4, 4);
            break;
        case 'm2browning':
            c.fillStyle = '#665544';
            c.fillRect(-8, -5, 18, 10);
            c.fillStyle = '#554433';
            c.fillRect(10, -2.5, 18, 5);
            c.fillStyle = '#443322';
            c.fillRect(26, -3, 4, 6);
            c.strokeStyle = '#554433';
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(-4, 5); c.lineTo(-8, 10);
            c.moveTo(0, 5); c.lineTo(0, 10);
            c.moveTo(4, 5); c.lineTo(8, 10);
            c.stroke();
            c.fillStyle = '#776655';
            c.fillRect(-12, -3, 4, 6);
            break;
        case 'minigun':
            c.fillStyle = '#555';
            c.fillRect(-6, -5, 16, 10);
            c.fillStyle = '#666';
            for (let j = -1; j <= 1; j++) {
                c.fillRect(10, j * 3 - 1, 14, 2);
            }
            c.fillStyle = '#444';
            c.beginPath();
            c.arc(22, 0, 4, 0, Math.PI * 2);
            c.fill();
            c.fillStyle = '#444';
            c.fillRect(-10, -4, 4, 8);
            break;
        case 'bfg':
            c.fillStyle = '#1a3a2e';
            c.fillRect(-8, -6, 18, 12);
            const pulse = Math.sin(Date.now() / 100) * 0.3 + 0.7;
            c.fillStyle = `rgba(0,255,136,${pulse})`;
            c.beginPath();
            c.arc(2, 0, 5, 0, Math.PI * 2);
            c.fill();
            c.strokeStyle = '#00ff88';
            c.lineWidth = 2;
            c.beginPath();
            c.arc(10, 0, 7, -Math.PI / 3, Math.PI / 3);
            c.stroke();
            c.fillStyle = '#00cc66';
            c.fillRect(10, -2.5, 8, 5);
            c.strokeStyle = '#00ff8888';
            c.lineWidth = 1;
            c.beginPath();
            c.arc(10, 0, 10, -Math.PI / 4, Math.PI / 4);
            c.stroke();
            break;
        case 'railgun':
            c.fillStyle = '#223344';
            c.fillRect(-8, -4, 18, 8);
            c.fillStyle = '#0066aa';
            for (let j = 0; j < 4; j++) {
                c.beginPath();
                c.arc(4 + j * 5, 0, 3, 0, Math.PI * 2);
                c.fill();
            }
            c.fillStyle = '#0088cc';
            c.fillRect(22, -1.5, 14, 3);
            c.fillStyle = '#00aaff';
            c.beginPath();
            c.arc(36, 0, 3, 0, Math.PI * 2);
            c.fill();
            c.shadowColor = '#00aaff';
            c.shadowBlur = 8;
            c.fill();
            c.shadowBlur = 0;
            break;
    }

    c.restore();
}

function drawEnemies(c) {
    game.enemies.forEach(e => {
        c.save();
        c.translate(e.x, e.y);

        // Flying shadow
        if (e.flying) {
            c.fillStyle = 'rgba(0,0,0,0.2)';
            c.beginPath();
            c.ellipse(0, e.size + 6, e.size * 0.8, e.size * 0.3, 0, 0, Math.PI * 2);
            c.fill();
        }

        // Enemy body
        c.fillStyle = e.color;
        c.strokeStyle = '#000';
        c.lineWidth = 1.5;

        switch (e.shape) {
            case 'soldier':
                c.fillRect(-e.size / 2, -e.size / 2, e.size, e.size);
                c.strokeRect(-e.size / 2, -e.size / 2, e.size, e.size);
                c.fillStyle = '#3a6a3a';
                c.beginPath();
                c.arc(0, -e.size / 2 - 3, 4, 0, Math.PI * 2);
                c.fill();
                c.stroke();
                break;
            case 'runner':
                c.beginPath();
                c.moveTo(0, -e.size);
                c.lineTo(e.size / 2, e.size / 2);
                c.lineTo(-e.size / 2, e.size / 2);
                c.closePath();
                c.fill();
                c.stroke();
                break;
            case 'armored':
                c.fillRect(-e.size, -e.size, e.size * 2, e.size * 2);
                c.strokeRect(-e.size, -e.size, e.size * 2, e.size * 2);
                c.fillStyle = '#883333';
                c.fillRect(-e.size + 3, -e.size + 3, e.size * 2 - 6, e.size * 2 - 6);
                break;
            case 'vehicle':
                c.fillRect(-e.size * 1.2, -e.size * 0.7, e.size * 2.4, e.size * 1.4);
                c.strokeRect(-e.size * 1.2, -e.size * 0.7, e.size * 2.4, e.size * 1.4);
                c.fillStyle = '#555566';
                c.fillRect(-e.size * 0.3, -e.size * 0.5, e.size * 0.6, e.size * 0.5);
                // Treads
                c.fillStyle = '#333';
                c.fillRect(-e.size * 1.2, e.size * 0.5, e.size * 2.4, 3);
                break;
            case 'heli':
                c.fillStyle = e.color;
                c.fillRect(-e.size, -e.size * 0.4, e.size * 2, e.size * 0.8);
                c.strokeRect(-e.size, -e.size * 0.4, e.size * 2, e.size * 0.8);
                // Rotor
                const rotorAngle = Date.now() / 50;
                c.strokeStyle = '#333';
                c.lineWidth = 2;
                c.beginPath();
                c.moveTo(-e.size * 1.5 * Math.cos(rotorAngle), -e.size * 0.5 - 2);
                c.lineTo(e.size * 1.5 * Math.cos(rotorAngle), -e.size * 0.5 - 2);
                c.stroke();
                // Tail
                c.fillStyle = e.color;
                c.fillRect(e.size, -2, e.size * 0.8, 3);
                break;
            case 'boss':
                c.fillRect(-e.size, -e.size, e.size * 2, e.size * 2);
                c.strokeRect(-e.size, -e.size, e.size * 2, e.size * 2);
                // Horns
                c.fillStyle = '#6622aa';
                c.beginPath();
                c.moveTo(-e.size, -e.size);
                c.lineTo(-e.size - 6, -e.size - 10);
                c.lineTo(-e.size + 4, -e.size);
                c.fill();
                c.beginPath();
                c.moveTo(e.size, -e.size);
                c.lineTo(e.size + 6, -e.size - 10);
                c.lineTo(e.size - 4, -e.size);
                c.fill();
                // Eyes
                c.fillStyle = '#ff0000';
                c.fillRect(-8, -6, 5, 5);
                c.fillRect(3, -6, 5, 5);
                break;
        }

        c.restore();

        // Health bar
        const barW = e.isBoss ? 40 : (e.shape === 'vehicle' ? 36 : 24);
        const barH = 4;
        const barX = e.x - barW / 2;
        const barY = e.y - e.size - (e.shape === 'soldier' ? 14 : 10);

        c.fillStyle = '#333';
        c.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);

        const pct = Math.max(0, e.hp / e.maxHp);
        c.fillStyle = pct > 0.5 ? '#00ff00' : pct > 0.25 ? '#ffaa00' : '#ff0000';
        c.fillRect(barX, barY, barW * pct, barH);
    });
}

function drawBullets(c) {
    game.bullets.forEach(b => {
        // Trail
        if (b.trailX.length > 1) {
            c.strokeStyle = b.bulletType === 'sniper' ? 'rgba(255,255,255,0.4)' : 'rgba(255,200,50,0.3)';
            c.lineWidth = b.bulletType === 'sniper' ? 2 : 1;
            c.beginPath();
            c.moveTo(b.trailX[0], b.trailY[0]);
            for (let i = 1; i < b.trailX.length; i++) {
                c.lineTo(b.trailX[i], b.trailY[i]);
            }
            c.stroke();
        }

        c.save();
        c.translate(b.x, b.y);
        c.rotate(Math.atan2(b.vy, b.vx));

        switch (b.bulletType) {
            case 'tracer':
                c.fillStyle = '#ffcc00';
                c.fillRect(-4, -1, 8, 2);
                break;
            case 'heavy_tracer':
                c.fillStyle = '#ff8800';
                c.fillRect(-5, -1.5, 10, 3);
                break;
            case 'pellet':
                c.fillStyle = '#ffaa44';
                c.fillRect(-2, -1, 4, 2);
                break;
            case 'sniper':
                c.fillStyle = '#ffffff';
                c.fillRect(-8, -1.5, 16, 3);
                c.fillStyle = '#aaddff';
                c.fillRect(-4, -0.5, 8, 1);
                break;
            case 'rocket':
                c.fillStyle = '#ff6600';
                c.fillRect(-4, -2, 8, 4);
                c.fillStyle = '#ffaa00';
                c.beginPath();
                c.moveTo(-4, -2);
                c.lineTo(-10, 0);
                c.lineTo(-4, 2);
                c.fill();
                break;
            case 'energy':
                c.fillStyle = '#00ff88';
                c.beginPath();
                c.arc(0, 0, 5, 0, Math.PI * 2);
                c.fill();
                c.shadowColor = '#00ff88';
                c.shadowBlur = 10;
                c.fill();
                c.shadowBlur = 0;
                break;
        }

        c.restore();
    });
}

function drawParticles(c) {
    game.particles.forEach(p => {
        const alpha = p.life / p.maxLife;

        if (p.type === 'railgun_beam') {
            c.save();
            c.globalAlpha = alpha;
            // outer glow
            c.strokeStyle = p.color;
            c.lineWidth = 11 * alpha;
            c.shadowColor = p.color;
            c.shadowBlur = 18;
            c.beginPath();
            c.moveTo(p.x, p.y);
            c.lineTo(p.x + Math.cos(p.angle) * p.length, p.y + Math.sin(p.angle) * p.length);
            c.stroke();
            // white-hot core
            c.strokeStyle = '#f2ffff';
            c.lineWidth = 2.5 * alpha;
            c.shadowBlur = 8;
            c.stroke();
            c.restore();
            return;
        }

        if (p.type === 'railgun_impact') {
            c.save();
            c.globalAlpha = alpha;
            c.strokeStyle = p.color;
            c.lineWidth = 2;
            c.shadowColor = p.color;
            c.shadowBlur = 12;
            c.beginPath();
            c.arc(p.x, p.y, p.size + (1 - alpha) * 16, 0, Math.PI * 2);
            c.stroke();
            c.restore();
            return;
        }

        if (p.type === 'damage_number') {
            c.save();
            c.globalAlpha = Math.min(1, alpha * 1.6);
            c.fillStyle = p.color;
            c.font = 'bold 13px Courier New';
            c.textAlign = 'center';
            c.shadowColor = '#0088cc';
            c.shadowBlur = 6;
            c.fillText(p.text, p.x, p.y);
            c.restore();
            return;
        }

        c.save();
        c.globalAlpha = alpha;
        c.fillStyle = p.color;
        c.beginPath();
        c.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
        c.fill();
        c.restore();
    });
}

function drawPlacementPreview(c, map) {
    if (!game.selectedTowerType) return;

    const def = TOWERS[game.selectedTowerType];
    const mx = snapToGrid(game.mouseX), my = snapToGrid(game.mouseY); // ghost shows the snapped cell

    // Range circle
    c.strokeStyle = game.canPlace ? 'rgba(0,255,136,0.5)' : 'rgba(255,68,68,0.5)';
    c.lineWidth = 1;
    c.setLineDash([5, 5]);
    c.beginPath();
    c.arc(mx, my, def.range, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);

    // Ghost tower
    c.save();
    c.globalAlpha = 0.6;
    c.translate(mx, my);
    c.fillStyle = game.canPlace ? '#2a2a2a' : '#442222';
    c.fillRect(-14, -14, 28, 28);
    c.strokeStyle = game.canPlace ? '#444' : '#663333';
    c.strokeRect(-14, -14, 28, 28);
    drawGunShape(c, game.selectedTowerType, 0);
    c.restore();

    // Indicator
    c.fillStyle = game.canPlace ? '#00ff88' : '#ff4444';
    c.font = '10px Courier New';
    c.textAlign = 'center';
    c.fillText(game.canPlace ? '✓ PLACE' : '✗ BLOCKED', mx, my - 25);
    c.textAlign = 'left';
}

// ============================================================
// UI UPDATE
// ============================================================
// Coalesce UI updates: late waves call updateUI() on every kill, which used to
// do 15+ DOM queries per dead enemy. Now many calls in one frame collapse into
// a single render - a big win at 3x speed.
let uiQueued = false;
function updateUI() {
    if (uiQueued) return;
    uiQueued = true;
    requestAnimationFrame(() => {
        uiQueued = false;
        renderUI();
    });
}

function renderUI() {
    document.getElementById('goldDisplay').textContent = game.gold;
    document.getElementById('livesDisplay').textContent = game.lives;
    document.getElementById('waveDisplay').textContent = `${game.wave}/${game.maxWaves}`;
    document.getElementById('scoreDisplay').textContent = game.score;

    // Wave button
    const waveBtn = document.getElementById('startWaveBtn');
    waveBtn.disabled = game.waveActive || game.wave >= game.maxWaves;
    waveBtn.textContent = game.waveActive ? `⚔ WAVE ${game.wave}` : '▶ WAVE';

    // Tower affordability
    document.querySelectorAll('.tower-btn').forEach(btn => {
        const type = btn.dataset.type;
        btn.classList.toggle('cant-afford', game.gold < TOWERS[type].cost);
    });

    // Armory Lab unlock buttons
    const lab4 = document.getElementById('unlock4Btn');
    const lab5 = document.getElementById('unlock5Btn');
    if (game.armory.unlock4) {
        lab4.textContent = '✅ TIER 4 UNLOCKED';
        lab4.className = 'lab-btn unlocked';
        lab4.disabled = true;
    } else {
        lab4.textContent = '🔓 TIER 4 — ALL GUNS ★4 ($10,000)';
        lab4.className = 'lab-btn' + (game.gold < 10000 ? ' cant-afford' : '');
        lab4.disabled = false;
    }
    if (game.armory.unlock5) {
        lab5.textContent = '✅ TIER 5 UNLOCKED';
        lab5.className = 'lab-btn unlocked';
        lab5.disabled = true;
    } else if (!game.armory.unlock4) {
        lab5.textContent = '🔒 TIER 5 — REQUIRES TIER 4';
        lab5.className = 'lab-btn cant-afford';
        lab5.disabled = true;
    } else {
        lab5.textContent = '🔓 TIER 5 — ALL GUNS ★5 ($15,000)';
        lab5.className = 'lab-btn' + (game.gold < 15000 ? ' cant-afford' : '');
        lab5.disabled = false;
    }

    // Upgrade button affordability (gold changes from kills/wave bonuses)
    refreshUpgradeButton();
}

// ============================================================
// NOTIFICATIONS
// ============================================================
let notifTimer = null;
function showNotification(msg, type = 'success') {
    const el = document.getElementById('notification');
    el.textContent = msg;
    el.className = type;
    el.style.display = 'block';
    el.style.opacity = '1';
    clearTimeout(notifTimer);
    notifTimer = setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => { el.style.display = 'none'; }, 300);
    }, 2000);
}

// ============================================================
// HIGH SCORES (local top 10)
// ============================================================
function fmtNum(n) {
    return Math.floor(Number(n) || 0).toLocaleString('en-US');
}

function loadScores() {
    try {
        const raw = JSON.parse(localStorage.getItem(SCORE_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        return raw
            .filter(e => e && typeof e === 'object' && Number.isFinite(Number(e.score)))
            .map(e => ({
                id: String(e.id || ''),
                score: Math.max(0, Math.floor(Number(e.score) || 0)),
                wave: Math.max(0, Math.floor(Number(e.wave) || 0)),
                kills: Math.max(0, Math.floor(Number(e.kills) || 0)),
                mode: DIFFICULTIES[e.mode] ? e.mode : DEFAULT_DIFFICULTY,
                map: MAPS[e.map] ? e.map : 'desert',
                date: Number(e.date) || 0,
            }))
            .sort((a, b) => b.score - a.score || b.wave - a.wave)
            .slice(0, MAX_SCORES);
    } catch (err) { return []; }
}

function saveScores(list) {
    try {
        localStorage.setItem(SCORE_KEY, JSON.stringify(list.slice(0, MAX_SCORES)));
    } catch (err) { /* private mode -> this run just isn't saved */ }
}

function recordScore() {
    if (game.scoreRecorded) return { rank: -1, scores: loadScores() };
    game.scoreRecorded = true;
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        score: Math.floor(game.score),
        wave: game.wave,
        kills: game.kills,
        mode: game.difficulty,
        map: game.selectedMap,
        date: Date.now(),
    };
    let list = loadScores();
    list.push(entry);
    list.sort((a, b) => b.score - a.score || b.wave - a.wave);
    const rank = list.findIndex(e => e.id === entry.id);
    list = list.slice(0, MAX_SCORES);
    saveScores(list);
    updateBestLine();
    return { rank: rank >= 0 && rank < MAX_SCORES ? rank : -1, scores: list, entry };
}

function bestForMode(mode) {
    return loadScores().filter(e => e.mode === mode)[0] || null;
}

function updateBestLine() {
    const el = document.getElementById('bestLine');
    if (!el) return;
    const mode = DIFFICULTIES[game.difficulty] ? game.difficulty : DEFAULT_DIFFICULTY;
    const best = bestForMode(mode);
    el.textContent = best
        ? `🏆 BEST ${DIFFICULTIES[mode].label}: ${fmtNum(best.score)} · WAVE ${best.wave} · ${MAPS[best.map] ? MAPS[best.map].name : best.map}`
        : `🏆 BEST ${DIFFICULTIES[mode].label}: —`;
}

function renderScores() {
    const el = document.getElementById('scoresList');
    if (!el) return;
    const list = loadScores();
    if (!list.length) {
        el.innerHTML = '<div class="scores-empty">No runs yet. Go build a firing line. 🔫</div>';
        return;
    }
    const rows = list.map((e, i) => {
        const mode = DIFFICULTIES[e.mode] ? DIFFICULTIES[e.mode].label : '—';
        const map = MAPS[e.map] ? MAPS[e.map].name : '—';
        return `<div class="score-row">
            <span class="rank">${i + 1}</span>
            <span class="score-val">${fmtNum(e.score)}</span>
            <span>${mode}</span>
            <span>${map}</span>
            <span>${e.wave}</span>
            <span>${fmtNum(e.kills)}</span>
        </div>`;
    }).join('');
    el.innerHTML = '<div class="score-row head"><span>#</span><span>SCORE</span><span>MODE</span><span>MAP</span><span>WAVE</span><span>KILLS</span></div>' + rows;
}

function openScores() {
    renderScores();
    document.getElementById('scoresModal').style.display = 'flex';
}

function closeScores() {
    document.getElementById('scoresModal').style.display = 'none';
}

// ============================================================
// GAME OVER / VICTORY
// ============================================================
function gameOver() {
    game.state = 'gameover';
    A.play('game_over');
    const rec = recordScore();
    const banner = rec.rank === 0
        ? '<div class="new-high">🏆 NEW HIGH SCORE!</div>'
        : rec.rank > 0 ? `<div class="new-high">#${rec.rank + 1} ON THE BOARD</div>` : '';
    document.getElementById('gameOverStats').innerHTML = `
        ${banner}
        Mode: <span>${(DIFFICULTIES[game.difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY]).label}</span><br>
        Wave Reached: <span>${game.wave}</span><br>
        Enemies Killed: <span>${game.kills}</span><br>
        Final Score: <span>${fmtNum(game.score)}</span>
    `;
    document.getElementById('gameOverModal').style.display = 'flex';
}

function victory() {
    game.state = 'victory';
    A.play('victory');
    const rec = recordScore();
    const banner = rec.rank === 0
        ? '<div class="new-high">🏆 NEW HIGH SCORE!</div>'
        : rec.rank > 0 ? `<div class="new-high">#${rec.rank + 1} ON THE BOARD</div>` : '';
    document.getElementById('victoryStats').innerHTML = `
        ${banner}
        Mode: <span>${(DIFFICULTIES[game.difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY]).label}</span><br>
        All <span>${game.maxWaves}</span> waves cleared!<br>
        Enemies Killed: <span>${game.kills}</span><br>
        Lives Remaining: <span>${game.lives}</span><br>
        Final Score: <span>${fmtNum(game.score)}</span>
    `;
    document.getElementById('victoryModal').style.display = 'flex';
}
