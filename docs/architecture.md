# AI Starship Odyssey — Full System Architecture

> **Last updated:** 2026-03-02
> **Status:** Stable, end-to-end operational. Phase 9+ 3D flight controls fully implemented.

---

## 1. High-Level Overview

"AI Starship Odyssey" (codename: "The Void") is a real-time 3D space simulation game with a live AI Director that controls world events through voice or text commands. Three independent services communicate over local WebSocket and HTTP:

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER / BROWSER                           │
│   React + Three.js frontend  (port 5173 dev / dist for prod)   │
│   – 3D scene rendering (React Three Fiber / @react-three/drei)  │
│   – Player input (WASD + mouse look + pointer lock)            │
│   – HUD (health bar, radar, score, damage flash, game-over)    │
│   – Voice recording → AI director, AI reply TTS playback       │
└──────────┬──────────────────────────────────────────┬──────────┘
           │ WS 8081: render_frame (60fps) ↓           │ WS 8000: audio/text ↓
           │ player_input (60fps) ↑                    │ WorldState JSON + TTS ↓
           ▼                                           ▼
┌──────────────────────────┐  HTTP   ┌──────────────────────────────┐
│   Rust Engine  :8080     │◄────────│  Python AI Director  :8000   │
│   bevy_ecs + warp        │ /spawn  │  FastAPI + Groq LLM          │
│   – ECS game loop 60fps  │ /modify │  ElevenLabs TTS              │
│   – 4 physics systems    │ /state  │  Groq Whisper STT            │
│   – Projectile/combat    │ /despawn│  FAISS session memory        │
│   – Survival mechanics   │ /command│  LangChain prompt chain      │
│   – WS broadcast         │         │  RAG from engine_capabilities│
└──────────────────────────┘         └──────────────────────────────┘
```

---

## 2. Service Breakdown

### 2.1 Rust Engine (`engines/core-state/`)

**Runtime:** Tokio async runtime, Bevy ECS (used for ECS + systems only, not as game engine), Warp HTTP server.

**Ports:**
- `:8080` — HTTP REST API (spawning, state, commands)
- `:8081` — WebSocket broadcast (render frames + player input reception)

#### Game Loop (`main.rs`)
Runs at 60 FPS via `tokio::time::interval`. Measures real `tick_dt` with `Instant::now()` — **critical**: avoids the old `dt=0.016` hardcode bug.

Each tick:
1. Read `PlayerInputState` from `Arc<Mutex<>>`
2. Apply cam_yaw/cam_pitch to player rotation, compute 3D thrust vector
3. Tick projectile lifespan (real dt), enforce 300-bullet hard cap
4. Run 4 Bevy ECS systems (see §2.3)
5. Check all collision pairs: player↔enemy, player↔asteroid, projectile↔enemy/asteroid
6. Update health, apply knockback, spawn shatter particles, send telemetry
7. Serialize visible entities into `render_frame` JSON with distance culling
8. Broadcast via WS 8081

#### World Initialization (startup)
| Count | Type | Notes |
|-------|------|-------|
| 1 | Sun | mass=50000, Static, radius=1000 |
| 8 | Planets | Mercury→Neptune, Orbital physics, textured |
| ~3 | Moons | Luna, Phobos, etc., Orbital around parent |
| 1500 | Asteroids | No PhysicsType (removed for ECS perf) |
| 12 | Enemy ships | SteeringAgent, attack behavior |
| 5 | Space stations | Static, torus visual |

**Distance culling:** Only asteroids within 3000 XZ units of the player are included per render frame (~20 KB/frame).

#### Survival Mechanics
- Player health: 0–100, stored in `Arc<Mutex<f32>>` (deliberately outside ECS)
- Collision damage: −20 HP, 1 s invincibility window, knockback 520 px/s
- Shatter on entity death: 10–20 orange `Particle` entities at death position
- Game over: 3 s countdown → health reset to 100 → player teleport to (500, 0, 0)
- Telemetry: `POST /engine_telemetry` to Python on `game_over`, `combat_kill`, `anomaly_kill`

#### HTTP API
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/state` | Full world snapshot JSON |
| POST | `/state` | Update `world_state` metadata |
| POST | `/spawn` | Spawn new ECS entities |
| POST | `/despawn` | Remove entities by type or ID |
| POST | `/modify` | Modify entity components |
| POST | `/clear` | Clear all non-permanent entities |
| POST | `/api/command` | `set_weapon`, `despawn`, `behavior_policy` |
| POST | `/api/update-player` | Change player ship model/color/cloak |
| POST | `/api/modify` | Modify player Scale component |
| POST | `/api/engine/reset` | Reset world to initial state |
| POST | `/engine_telemetry` | Receive event telemetry from Python |
| GET | `/assets/*` | Static file serving (textures) |

---

### 2.2 ECS Components (`components.rs`)

| Component | Key Fields | Purpose |
|-----------|-----------|---------|
| `Transform` | x, y, z, rotation | World position + heading |
| `PhysicsType` | Static / Orbital / Sinusoidal / Velocity / Projectile | Movement regime |
| `SteeringAgent` | behavior, faction, target_id, speed | AI steering |
| `BirthAge` / `DeathAge` | f32 timer | Spawn/death animation hooks |
| `Health` | max, current | ⚠️ **Dead code** — player health is in a Mutex instead |
| `Visuals` | model_type, color (hex), is_cloaked | Visual appearance for frontend |
| `WeaponParameters` | projectile_count, projectile_color, spread, size | Shooting config |
| `SpatialAnomaly` | anomaly_type, mass, radius | Gravity wells / repulsors |
| `Scale` | x, y, z | Entity size override |
| `Particle` | velocity (vec3), lifetime | Explosion debris |
| `Projectile` | velocity (vec3), lifespan | Player bullets |

---

### 2.3 ECS Systems (`systems.rs`)

Four Bevy systems run every frame in order:

1. **`environmental_physics_system`** — Applies Newtonian gravity from `SpatialAnomaly` to all `SteeringAgent` entities within the anomaly's radius.

2. **`particle_physics_system`** — Moves particles along velocity vector; applies black-hole gravity pull to nearby particles.

3. **`steering_system`** — Behavioral AI per `SteeringAgent`:
   - `attack`: seek nearest opposing-faction target, decelerate on close approach
   - `scatter`: flee from player
   - `protect`: orbit a friendly station/companion
   - `swarm`: flock with nearby allies
   - `idle`: drift
   - Hard boundary clamp: ±32,000 on all axes

4. **`generative_physics_system`** — Updates `Transform` for Orbital (circular orbit), Sinusoidal (wave), and Velocity (constant direction) physics types.

---

### 2.4 Python AI Director (`apps/python-director/main.py`)

**Runtime:** FastAPI + Uvicorn, async WebSocket, Groq SDK, ElevenLabs SDK, FAISS, SentenceTransformer, LangChain.

**Port:** `:8000`

#### Voice Pipeline
1. Browser streams raw audio bytes over WS
2. `{"type":"audio_end"}` triggers Groq Whisper STT → transcript
3. FAISS top-3 relevant memories + recent telemetry → system prompt
4. LangChain `world_chain.ainvoke()` → Groq `llama-3.3-70b-versatile` (fallback: `llama-3.1-8b-instant`)
5. Structured `WorldState` JSON output via `JsonOutputParser`
6. Parallel dispatch to Rust API endpoints
7. `conversational_reply` → ElevenLabs Rachel TTS → base64 MP3 → WS broadcast to all clients

#### WorldState JSON Schema
```json
{
  "conversational_reply": "string",
  "spawn_entities": [{"entity_type": "enemy", "faction": "pirate", ...}],
  "modify_entities": [{"entity_id": "...", "behavior": "attack"}],
  "despawn_entities": [{"entity_type": "projectile"}],
  "reality_override": {"gravity": 1.5, "friction": 0.2},
  "modify_player": {"model_type": "stealth", "color": "#00ff00", "is_cloaked": true},
  "behavior_policy": "aggro"
}
```

#### Session Memory (RAG)
- FAISS vector index with `all-MiniLM-L6-v2` SentenceTransformer embeddings
- Top-3 memories retrieved per LLM call
- RAG knowledge base: `apps/python-director/data/engine_capabilities.md`

#### Telemetry Handlers (`/engine_telemetry`)
| Event | Python Response |
|-------|----------------|
| `game_over` | Dramatic TTS narration broadcast to all clients |
| `combat_kill` | Random combat quip TTS |
| `anomaly_kill` | Void-themed quote TTS |

#### Text Command Fallback
Browser can send `{"type":"text_command","text":"..."}` for keyboard-based director control without voice.

---

### 2.5 React Frontend (`apps/web-client/src/`)

**Runtime:** React 18 + TypeScript, Three.js via `@react-three/fiber` + `@react-three/drei`, Tailwind CSS, Vite.

#### Component Tree
```
App.tsx                       ← All state, both WS connections, 60fps input loop
└── GameScene.tsx             ← Three.js canvas, camera lerp, lighting
    ├── Starfield.tsx         ← 5000 background star points (spherical shells r=200k–500k)
    ├── PlayerShip.tsx        ← Player mesh (procedural fallback; GLTF loader present but unused)
    ├── EntityRenderer.tsx    ← All non-player entity meshes (sun/planet/enemy/asteroid/etc.)
    ├── ParticleSystem.tsx    ← GPU particle points (explosions)
    ├── LaserBeam (inline)    ← Red raycast beam with glow
    └── HitDot (inline)      ← Impact point sphere
HUD.tsx                       ← DOM overlay (health bar, radar, score, damage flash, game-over)
```

#### Player Input (60fps RAF loop)
- `activeKeysRef`: Set of pressed keys (`KeyW`, `KeyS`, `Space`, arrow keys)
- `camYawRef`, `camPitchRef`: Updated on `mousemove` while pointer-locked
- Every frame sends: `{ msg_type: "player_input", keys: [...], cam_yaw, cam_pitch }`
- **W**: thrust forward in 3D direction `[cos(yaw)·cos(pitch), sin(pitch), sin(yaw)·cos(pitch)]`
- **S**: brake (60% reverse thrust)
- **Space**: fire (handled server-side at 0.2 s intervals)
- **Scroll**: adjust zoom (0.2–5.0), pure frontend

#### Camera (`GameScene.tsx`)
- `PerspectiveCamera` FOV 70
- Position lerps to: `player_pos + rotation_offset(cam_yaw, cam_pitch) × zoom_distance`
- Always stays behind the ship; offset computed from live yaw + pitch

#### Render Frame Consumption
- Field name: `"type":"render_frame"` (NOT `msg_type`) — important distinction
- Diffs `ecsEntities` map to detect `newbornIds` / `dyingIds`
- `newbornIds` → `.newborn-glow` CSS (scale 0→1.3→1.0, 1.2 s)
- `dyingIds` → `.death-implode` CSS (scale 1→0, 1.0 s)

#### Audio
- Collision SFX: dual-oscillator (sine + sawtooth), 0.18 s envelope, Web Audio API
- TTS playback: base64 MP3 from Python WS → `AudioContext.decodeAudioData`
- Volume meter: canvas bar from Web Audio analyser node

---

## 3. Data Flow

### 3.1 Voice Command → World Change
```
User mic → MediaRecorder chunks → WS 8000 (raw audio bytes)
  ↓ {"type":"audio_end"}
Python: Whisper STT (Groq) → transcript
  ↓
Python: FAISS top-3 memories + telemetry → system prompt
  ↓
Python: LangChain → Groq LLM → WorldState JSON
  ↓ (parallel)
  ├── POST /spawn        → Rust creates ECS entities
  ├── POST /modify       → Rust updates SteeringAgent
  ├── POST /despawn      → Rust removes entities
  ├── POST /api/command  → Rust updates WeaponParameters
  └── POST /state        → Rust updates world_state metadata
  ↓
Rust: ECS updated → next render_frame reflects changes → WS 8081
  ↓
App.tsx: ecsEntities updated → Three.js renders
  ↓ (parallel)
Python: ElevenLabs TTS → base64 MP3 → WS 8000 broadcast → App.tsx plays audio
```

### 3.2 Player Physics Frame
```
W pressed + mouse moved right
  ↓
App.tsx: camYawRef updated, activeKeysRef = {KeyW}
  ↓ (60fps RAF)
send { msg_type: "player_input", keys: ["KeyW"], cam_yaw: 1.5, cam_pitch: 0.1 }
  ↓
Rust: PlayerInputState mutex updated
  ↓
Game loop:
  thrust_dir = [cos(1.5)·cos(0.1), sin(0.1), sin(1.5)·cos(0.1)]
  player.velocity += thrust_dir × 400
  ECS systems run → render_frame serialized
  ↓
WS 8081 → App.tsx: player position updated → GameScene camera follows
```

### 3.3 Projectile Hit → Telemetry
```
Space pressed
  ↓
Rust: spawn Projectile, velocity = cam direction × projectile_speed
  ↓
tick: projectile moves, lifespan -= tick_dt
  ↓
Collision: projectile sphere (30px) hits enemy AABB
  ↓
Enemy dies: shatter particles spawned, score++
POST /engine_telemetry {"event":"combat_kill"} → Python
  ↓
Python: combat quip TTS → WS 8000 → App.tsx plays audio
  HUD: score increments
```

---

## 4. Entity Rendering Matrix

| Entity Type | Mesh | Material | Special |
|-------------|------|----------|---------|
| `sun` | Sphere r=1000 | Emissive amber | PointLight 80000 intensity |
| `planet` | Sphere r=40–250 | Name-based color + texture | Saturn: Torus ring |
| `moon` | Sphere r=10–30 | Gray/tan | Orbits parent planet |
| `asteroid` | Dodecahedron/Icosahedron/Octahedron | Dark gray #555 | 3 shape variants |
| `projectile` | Sphere r=custom_size | custom_color emissive | Small point light |
| `enemy` var=0 | Cone + spike array | Red/orange | AlienSwarmer, red eye |
| `enemy` var=1 | TorusKnot | Bio-green | AlienRavager |
| `enemy` var=2 | Octahedron + rings | Purple glow | AlienMothership |
| `space_station` | Torus + sphere | Cyan metallic | Cyan point light |
| `companion` | Octahedron / Box | Blue / gray | Faction-dependent |
| `anomaly` | Black sphere + wireframe | Purple emissive | Gravity well |

**Textures:** Served from `http://127.0.0.1:8000/assets/` — Earth, Mars, Jupiter, Venus, Mercury, Saturn, Uranus, Neptune, Sun, Moon (2K maps in `data/`).

---

## 5. Coordinate System

| Axis | Direction | Notes |
|------|-----------|-------|
| X | East (right) | |
| Y | Up (altitude) | |
| Z | South (default forward) | |

- Orbital plane: XZ
- World boundary: ±32,000 units hard clamp (enforced in `steering_system`)
- Rust and Three.js use identical conventions — no transform required

---

## 6. Known Technical Debt

| Issue | Severity | File | Description |
|-------|----------|------|-------------|
| `Health` ECS component unused | Low | `components.rs` | Player health is in `Arc<Mutex<f32>>`, not ECS. Causes architectural confusion. |
| Python behavior policy poll | Medium | `main.py` | Legacy `GET /state` polling loop should be deleted; telemetry push is the correct pattern. |
| Particle `custom_color` ignored | Medium | `EntityRenderer.tsx` | Engine sends custom colors for particles; React hardcodes orange. |
| GLTF models never loaded | Low | `PlayerShip.tsx` | GLTF loader present but no model URLs configured; procedural fallback always used. |
| `OrbitControls` import unused | Low | `GameScene.tsx` | Imported but never placed in JSX. |
| `Html` drei import unused | Low | `PlayerShip.tsx` | Imported but never used. |
| `base64`/`urlencoding` crates | Low | `Cargo.toml` / `main.rs` | Imported but not used — compiler warnings. |
| Player coords missing from LLM | Medium | `main.py` | Player x/y/z passed to chain but absent from `ChatPromptTemplate` — AI cannot reason spatially. |
| `worldState.visual_prompt` ref | Low | `App.tsx` | Field removed from schema but still referenced in sidebar — TypeScript warning. |

---

## 7. Performance Profile

| Metric | Value | Condition |
|--------|-------|-----------|
| Render frame size | ~20 KB | Distance-culled (3000 unit radius) |
| Frame rate | 35–60 fps | Depends on nearby entity count |
| Total ECS entities (init) | ~1540 | 1500 asteroids + solar system + enemies |
| Entities per frame (typical) | 60–120 | After culling |
| Projectile cap | 300 | Hard cap — oldest removed |
| LLM latency | 1–3 s | Groq, llama-3.3-70b |
| TTS latency | 0.5–1 s | ElevenLabs turbo |

**Critical fixed bug:** Projectile lifespan previously used hardcoded `dt=0.016`. Under load, bullets took 156 s to expire → 5000+ bullets → 2.6 MB frames → 0.9 fps death spiral. Fixed with real `tick_dt` via `Instant::now()` and 300-bullet hard cap.
