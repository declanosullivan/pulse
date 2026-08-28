# PulseForge 

Generative multi-band spatial rhythm synthesizer with real-time activity logging, MIDI learn, mic sync, BPM ramp engines, and offline WAV export. Runs entirely in the browser via the Web Audio API.

## Run locally

```bash
npm install
npm run dev
```

Open the printed local URL (default [http://127.0.0.1:45321](http://127.0.0.1:45321)).

Production build:

```bash
npm run build
npm run preview
```

## What’s included

- Multi-band oscillator / FM / pluck / noise / sample sources
- Euclidean step sequencing, global transport, swing, BPM ramp modes
- Ping-pong delay + convolution reverb send/return
- Preset save/load (localStorage), JSON + pack import/export
- Parameter activity log with CSV export
- MIDI CC learn, optional mic pitch/BPM tracking

## Architecture notes

The original single-file app was split into a Vite project:

| Path | Role |
| --- | --- |
| `index.html` | Semantic layout shell |
| `src/styles/app.css` | Theme + optimized layout |
| `src/js/config.js` | Constants |
| `src/js/utils.js` | Shared helpers |
| `src/js/log.js` | XSS-safe activity log |
| `src/js/bands/defs.js` | Default band definitions |
| `src/js/bands/factory.js` | Procedural band expansion |
| `src/js/arc-palettes.js` | Per-arc timbral patch plans |
| `src/js/arc-orchestration.js` | Per-arc band group enable/disable |
| `src/js/arc-fx-snapshots.js` | Per-arc FX morph targets |
| `src/js/band-groups.js` | Collapsible spectral band groups |
| `src/js/arc-generator.js` | Planned tempo arc queue |
| `src/js/audio/worklet-src.js` | AudioWorklet + ticker workers |
| `src/js/app.js` | Audio engine, UI wiring, viz |

## BPM / Tempo choreography

PulseForge supports dramatic rhythm arcs up to **500 BPM**. For hands-off use, start with **Arc Stream** — it plans each arc and picks BPM/gap parameters automatically.

### Arc Stream (recommended)

Click **Arc Stream** or set Mode → **Arc Stream (Auto)**. The generator composes an endless program of **planned arcs** separated by **short, medium, or long silence gaps**:

| Control | What it does |
| --- | --- |
| **Arc Stream** | Enables auto mode; manual Start/End/Time/Jitter are optional |
| **Gap Profile** | Mixed, Short, Medium, or Long silence between every arc |
| **Intensity** | Subtle, Dramatic, or Extreme contrast between consecutive arcs |
| **Orchestration** | On: each arc enables a spectral band group and mutes the rest |
| **Morph** | On: palette params + FX morph along the arc shape curve (Palettes v2) |
| **↻ New Program** | Regenerate the arc queue without stopping playback |

Each arc has a **planned shape** (Lift, Fall, Breath, Surge, Collapse, Cascade, Strobe, Hold-Drop) and a **frequency zone** (Sub, Low, Mid, High, Hyper, Wide). The engine picks BPM ranges from app min/max (1–500), exaggeration mode, and band focus per arc. Jitter adds light texture only — the macro curve is intentional, not random segments.

**Arc Palettes v1:** each arc applies a unique timbral patch to 1–6 bands (scales with band count), restored to your baseline during silence gaps.

**36-band expansion (Phase 1):** up to **48 bands** max. Named Delta–Omega bands 1–9; bands 10–36 are log-spaced **Spectral** nodes. Click **Expand to 36** or enable **Arc Stream** (auto-expands). Generate → **36-Band Arc Orchestra** for a full preset.

**Arc Orchestration (Phase 2):** each arc enables a **spectral band group** (2–10 bands depending on density) and mutes the rest for sharper contrast. Groups tile the spectrum (Infrasub → Hyper), rotate across arcs, and merge with palette targets. Toggle **Orchestration** in Arc Stream controls; spotlighted cards show the active group. Baseline arming restores during silence gaps.

**Compact UI + queue preview (Phase 3):** band panel **View** toggle — **Full**, **Groups** (collapsible Named + Spectral sections), or **Compact** (headline-only cards, auto-selected at 24+ bands). Arc Stream shows an upcoming **Queue** strip under transport.

**Palette morph + FX snapshots (Phase 4):** with **Morph** on, discrete palette keys (source, filter type, seq mode) apply at arc start; numeric params (drive, binaural, filter freq, sends) **interpolate along the arc shape curve**. Global delay/reverb feedback, damp, and returns morph per arc; reverb preset switches at the midpoint.

**Quick start:** Generate → **Arc Stream Auto** → Enable All → Start.

Legacy manual modes (Pulse Wave, Micro-Loops, etc.) remain available under BPM Ramp when Arc Stream is off.

### Manual mode reference

| Control | Setting | Why |
| --- | --- | --- |
| **BPM Ramp** | ON | Enables macro tempo engine |
| **Mode** | Pulse Wave + Silence | Ascending/descending bursts with mute gaps |
| **Sub-Loop** | Chaos (0.5–2.5s) | Unpredictable micro-segment lengths |
| **Start / End** | 500 → 1 (or 300 → 1) | Maximum contrast |
| **Jitter** | 60–80% | Breaks smooth ramps |
| **Gap Min / Max** | 0.8–4s | Audible silence between waves |
| **Slowdown** | Band Zone or Combo | Maps Delta→Omega bands to current BPM |
| **Var Engine** | ON, interval 1 | Mutates band params each macro loop |

### Mode options

1. **Arc Stream (Auto)** — Planned arcs + auto silence gaps; parameters chosen from app ranges.
2. **Dynamic Micro-Loops + Chaos** — Continuous BPM drift via random 0.5–2.5s sub-loops.
3. **Pulse Wave + Silence** — Shuffled up/down/silence phases.
4. **Stochastic Drift + Chaos** — Random BPM noise on top of micro-loops.

### Band contrast tips

- **Low BPM (1–40):** Delta, Theta, Alpha — sub/brown sources, long `dur`, low `pLow/pHigh`.
- **Mid BPM (40–180):** Alpha, Beta, Gamma — triangle/ramp shapes, moderate pulse rates.
- **High BPM (180–500):** Gamma through Omega — seq mode, high `pLow/pHigh`, FM or sharp transients.
- Enable **BPM SYNC** on all bands so pulse Hz scales with global tempo.

### Anti-predictability checklist

- Chaos sub-loop + Pulse Wave (shuffled phase order)
- Jitter ≥ 60%
- Var Engine every 1–2 loops
- Randomize Start/End direction (500→1 vs 1→500) between sessions
- Mix **Combo** slowdown (thin + sparse + band zone)

