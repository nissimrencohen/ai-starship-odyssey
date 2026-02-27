# Project Architecture Status — "The Void" / Solar System Survival
**Last updated: Phase 6.1 baseline consolidated**

This document tracks the current implementation state of the project. Details on the active system architecture and future plans are now synchronized with [current_architecture.md](current_architecture.md) and [future_roadmap.md](future_roadmap.md).

---

## Repository Layout

```
C:\Project\
├── engines/
│   └── core-state/          ← Rust ECS game server
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs       (1 029 lines — game loop + HTTP/WS servers)
│           ├── components.rs (107 lines — ECS component definitions)
│           └── systems.rs    (322 lines — physics systems)
├── apps/
│   ├── python-director/
│   │   └── main.py           (673 lines — AI Director + TTS + telemetry)
│   └── web-client/
│       └── src/
│           ├── main.tsx              (entry point)
│           ├── App.tsx               (714 lines — root shell + all state)
│           └── components/
│               ├── GameScene.tsx     (64 lines  — Three.js scene root)
│               ├── EntityRenderer.tsx(99 lines  — entity mesh dispatch)
│               ├── PlayerShip.tsx    (94 lines  — ship mesh + GLTF loader)
│               ├── ParticleSystem.tsx(55 lines  — GPU particle points)
│               ├── SpaceGrid.tsx     (41 lines  — background grid)
│               ├── Starfield.tsx     (54 lines  — static star sphere)
│               └── HUD.tsx           (220 lines — tactical HUD overlay)
├── world_snap.json           ← persisted world snapshot (runtime artifact)
└── run_all.ps1               ← launcher: starts all 3 processes
```

---

## 1. Rust Core Engine — `engines/core-state/`

### 1.1 Dependencies (`Cargo.toml`)

| Crate | Version | Purpose |
|---|---|---|
| `bevy_ecs` | 0.13 | ECS world, components, schedules — no Bevy window/renderer |
| `tokio` | 1.36 | Async runtime, 60 fps game loop timer |
| `warp` | 0.3 | HTTP REST API (port 8080) + WebSocket broadcast (port 8081) |
| `reqwest` | 0.12 | Outbound HTTP to Python Director (`/engine_telemetry`) |
| `serde` / `serde_json` | 1.0 | JSON serialisation for all wire formats |
| `tokio-stream` | 0.1 | Converts mpsc receiver into a stream for WS forwarding |
| `futures-util` | 0.3 | `StreamExt` for WebSocket receive loop |
| `rand` | 0.8 | RNG for asteroid generation, shatter particles |
| `base64` | 0.22 | **Imported but unused** (legacy, generates compiler warning) |
| `urlencoding` | 2.1 | **Imported but unused** |

---

### 1.2 `components.rs` — ECS Component Definitions

Every struct tagged `#[derive(Component)]` can be attached to ECS entities.

| Component | Fields | Active |
|---|---|---|
| `WorldState` | `summary`, `environment_theme`, `terrain_rules`, `physics_mode`, `camera_zoom`, `player_x?`, `player_y?` | ✅ Deserialised from Python `/state` POST; drives `sync_state_system` |
| `Transform` | `x`, `y`, `z`, `rotation` | ✅ Core position for every entity |
| `EntityType(String)` | type tag string | ✅ All dispatch logic |
| `Name(String)` | display name | ✅ Planets, Sun |
| `PhysicsType` | `Static` / `Orbital{radius,speed,angle}` / `Sinusoidal{amplitude,frequency,time}` | ✅ Drives `generative_physics_system` |
| `BirthAge(f32)` | seconds since spawn | ✅ Birth speed ramp: `min(age/2, 1)` |
| `DeathAge(f32)` | seconds since death trigger | ✅ Implosion + despawn at 1.0 s |
| `SteeringAgent` | `behavior`, `velocity`, `max_speed`, `max_force` | ✅ Drives `steering_system` |
| `Particle` | `velocity`, `lifespan`, `max_lifespan`, `color` | ✅ Shatter / explosion particles |
| `SpatialAnomaly` | `anomaly_type`, `mass`, `radius` | ✅ Black holes, repulsors, Sun |
| `Projectile` | `velocity`, `lifespan`, `color` | ✅ Player-fired laser bolts |
| `PlayerInputMessage` | `msg_type`, `keys` | ✅ Deserialised from WS input |
| `Health` | `max: 100.0`, `current: 100.0` | ⚠️ Spawned on player but **never queried from ECS** — runtime health lives in `Arc<Mutex<f32>>` |

---

### 1.3 `systems.rs` — Bevy ECS Systems

All four systems run in the `schedule` once per frame (60 fps).

> **Note:** `use systems::{generative_physics_system, ...}` is imported in `main.rs` but the schedule uses `systems::` prefix paths — the named imports are unused and generate compiler warnings.

#### `generative_physics_system`
- Processes all `(Transform, PhysicsType, Option<BirthAge>, Option<DeathAge>, Option<SteeringAgent>)` entities.
- `Static` → no-op.
- `Orbital` → heliocentric orbit around (0,0,0): `x = cos(angle)*radius`, `y = sin(angle)*radius*0.4`, `z = sin(angle)*radius`. Non-idle `SteeringAgent` overrides the lerp.
- `Sinusoidal` → drifts +X at 25 px/s, wraps at ±1000. Z oscillates by `sin(time*freq)*amplitude`. Non-idle steering overrides.
- Birth ramp: speed × `min(age/2.0, 1.0)` for first 2 seconds.
- Death implosion: `z *= 1 - death_factor`, `x/y *= 1 - death_factor*0.1`.

#### `environmental_physics_system`
- Reads all `SpatialAnomaly` entities and applies Newtonian gravity (`F = G*M/d²`, G=50) to all `SteeringAgent` entities.
- `repulsor` → pushes agents away.
- `black_hole` → pulls agents in; forces behavior to `"idle"` inside `radius*1.5`.

#### `particle_physics_system`
- Moves all `Particle` entities by velocity (scaled `0.016*60`).
- Applies black-hole gravity to particles.
- Decrements `lifespan` by 0.016 s per frame.

#### `steering_system`
- Reads player position, then for each `SteeringAgent`:
  - `"idle"` → velocity decays 0.95× per frame.
  - `"attack"` → seeks player.
  - `"scatter"` → flees player.
  - `"protect"` → orbits player at radius 100 in a 3D sphere.
  - `"swarm"` → seeks player + separates from other agents (desired_separation = 40).
- Z soft-clamped to [0, 1000] with restoring force.
- Final velocity clamped to `max_speed`.

#### `sync_state_system`
- Reads `SharedState(WorldState)`.
- If `physics_mode == "orbital"` and a `"companion"` entity exists, switches it to `Orbital{r:150, s:1.5}`. If `"sinusoidal"`, switches to `Sinusoidal`. Otherwise `Static`.

---

### 1.4 `main.rs` — Server, Game Loop, Survival Systems

#### Ports & Servers

| Port | Protocol | Routes |
|---|---|---|
| **8080** | HTTP REST | `POST /state`, `POST /save`, `POST /spawn`, `POST /clear`, `POST /despawn`, `POST /modify` |
| **8081** | WebSocket | Broadcasts `render_frame` at 60 fps; receives `player_input` |

#### REST API Endpoints

| Endpoint | Payload | Effect |
|---|---|---|
| `POST /state` | `WorldState` JSON | Updates shared WorldState; stages AI player lerp if `player_x/y` present |
| `POST /save` | (empty) | Serialises all `(EntityType, Transform, PhysicsType)` + WorldState to `world_snap.json` |
| `POST /spawn` | `Vec<SpawnEntityRequest>` | Spawns new entities with `BirthAge(0.0)`. Supports `anomaly_type/mass/radius` |
| `POST /clear` | (empty) | Marks all non-player entities with `DeathAge(0.0)` |
| `POST /despawn` | `DespawnRequest{ent_type?, color?, ids?}` | Targeted death-marking by type, color, or ID list |
| `POST /modify` | `Vec<ModifyRequest>` | Updates `PhysicsType` params and/or `SteeringAgent.behavior` for specific IDs |

> ⚠️ **There is no `GET /state` endpoint.** The Python Director's behavior-policy loop attempts `GET /state` to read entity IDs — this always fails silently (connection refused or 404).

#### Serialised Wire Types

| Struct | Direction | Key Fields |
|---|---|---|
| `RenderFrameState` | Rust → React (WS) | `type:"render_frame"`, `environment_theme`, `terrain_rules`, `grid`, `entities[]`, `particles[]`, `player_health`, `score`, `is_game_over` |
| `EntityData` | embedded | `id`, `x`, `y`, `z`, `rotation`, `speed`, `ent_type`, `color`, `is_newborn`, `is_dying`, `behavior`, `name?`, `radius?`, `anomaly_type?`, `anomaly_radius?` |
| `ParticleData` | embedded | `x`, `y`, `z`, `lifespan`, `max_lifespan`, `color` |
| `CollisionEvent` | Rust → React (WS) | `type:"collision_event"`, `star_id`, `speed`, `distance` — fires only when player is within 20 px of a `"star"` entity |
| `SpatialGrid` | embedded | `size:2000`, `divisions:40` |

#### World Initialisation (startup)

| Entity | Position | Physics | Notes |
|---|---|---|---|
| Player | (500, 0, 0) | Static | + `Health{100,100}` |
| Sun | (0, 0, 0) | Static | + `SpatialAnomaly{sun, mass:15000, radius:120}` |
| 8 Planets | Heliocentric orbits | Orbital | Mercury→Neptune; random starting angle; name-based sizes |
| 100 Asteroids | Orbital r=[650,800] | Orbital | + `SteeringAgent{idle}`, speed=[0.1,0.4] |

#### Player Movement (per frame)

- WASD / Arrow keys → normalised `(move_x, move_y)` at 400 px/s.
- `rotation = move_y.atan2(move_x)`.
- AI Director lerp: if Python POSTs `player_x/y`, player lerps at 12%/frame; cancelled on WASD input.
- Knockback velocity applied each frame, decays 0.82× per frame.
- Input and shooting frozen when `game_over_timer > 0`.

#### Projectile System

- `Space` fires one projectile per 0.2 s at 900 px/s in player heading.
- Lifespan 1.5 s, then hard-despawned (no shatter).
- Color: `rgba(239, 68, 68, 1.0)`.

#### Combat Collision Detection

- Every frame: projectiles × `{star, companion, enemy, asteroid}` entities.
- Collision radius: **30 px**.
- On hit: both despawned via `DeathAge(0.0)`; `total_kills++`; `combat_kill` telemetry sent.

#### Survival Systems (Phase 6.1)

Five `Arc<Mutex<>>` values shared across the async loop:

| Variable | Type | Purpose |
|---|---|---|
| `player_health` | `f32` (0–100) | Current hull integrity |
| `damage_cooldown` | `f32` | Seconds of invincibility after a hit |
| `player_knockback` | `(f32, f32)` | Impulse velocity, decays 0.82× per frame |
| `total_kills` | `u32` | Cumulative kill count for the session |
| `game_over_timer` | `f32` | 0 = alive; > 0 = death countdown from 3.0 s |

**Player Damage System** (runs every frame, after combat collision):
- Skipped if `game_over_timer > 0` or `damage_cooldown > 0`.
- Queries all non-dying `enemy` / `asteroid` entities within **42 px** of player.
- On collision: −20 hp, 1 s invincibility, 520 px/s directional knockback, hostile shatters.
- If health reaches 0: `game_over_timer = 3.0`, 35 golden particles spawned at player position, `game_over` event POSTed to Python.
- After 3 s: health reset to 100, player teleported to (500, 0).

#### Black Hole / Sun Simulation

- All non-player, non-planet, non-sun entities entering `radius * 0.5` of a `black_hole` or `sun` anomaly receive `DeathAge(0.0)`.
- Fires `anomaly_kill` telemetry to Python.

#### Shatter Engine

- Fresh `DeathAge(0.0)` entities (not type `"anomaly"`) → 10–20 fiery orange particles at their position.
- Speed: 100–300 px/s, random angle, Z ±100.
- Game-over player shatter: 35 golden particles (`rgba(255,210,60,0.95)`), speed 160–440.

#### World Persistence

- `POST /save` → `world_snap.json` written to project root.
- Rust does **not** auto-load on restart — entities always reset to solar system defaults.
- Python reads `world_snap.json` on each new WS connection to seed FAISS memory.

---

## 2. Python Director — `apps/python-director/main.py`

**Runtime:** `uvicorn main:app --port 8000`

### 2.1 Dependencies

| Library | Purpose |
|---|---|
| `fastapi` + `uvicorn` | HTTP + WebSocket server |
| `groq` (AsyncGroq) | Whisper STT (`whisper-large-v3`) + Llama 3.3-70b LLM |
| `langchain-groq` / `langchain-core` | `ChatGroq`, `ChatPromptTemplate`, `JsonOutputParser` |
| `httpx` | Async HTTP: ElevenLabs TTS + Rust engine calls |
| `elevenlabs` (via httpx) | TTS — voice `21m00Tcm4TlvDq8ikWAM` (Rachel), model `eleven_turbo_v2_5` |
| `faiss-cpu` | Vector similarity search for DreamMemory |
| `sentence-transformers` | `all-MiniLM-L6-v2` embeddings for FAISS |
| `python-dotenv` | Loads `GROQ_API_KEY`, `ELEVENLABS_API_KEY` from `C:\Project\.env` |
| `pydantic` | Schema validation for all API models |

### 2.2 Pydantic Schemas

| Model | Purpose |
|---|---|
| `WorldState` | LLM output schema — `summary`, `environment_theme`, `terrain_rules`, `physics_mode`, `conversational_reply`, `entities{}`, `player_x?`, `player_y?`, `spawn_entities?`, `clear_world?`, `despawn_entities?`, `modify_entities?`, `behavior_policy?`, `spawn_anomalies?` |
| `SpawnEntity` | Forwarded to Rust `/spawn` |
| `DespawnFilter` | Forwarded to Rust `/despawn` |
| `Anomaly` | Black holes / repulsors forwarded to Rust `/spawn` |
| `ModifyEntity` | Forwarded to Rust `/modify` |
| `TelemetryEvent` | Accepted by `/engine_telemetry`: `event_type`, `count`, `cause`, `timestamp` |

### 2.3 Functions

| Function | Active | Description |
|---|---|---|
| `generate_speech(text)` | ✅ | POSTs to ElevenLabs v1 TTS, returns base64 MP3 |
| `sync_with_engine(state_data)` | ✅ | POSTs `WorldState` dict to Rust `POST /state` |
| `spawn_entities_in_engine(spawn_list)` | ✅ | POSTs to Rust `POST /spawn`; patches missing x/y/physics/ent_type |
| `manage_entities_in_engine(endpoint, payload?)` | ✅ | Generic caller for `/clear`, `/despawn`, `/modify` |
| `trigger_game_over_reaction(event_dict)` | ✅ | LLM ≤12-word visceral death line → TTS → broadcast all WS clients |
| `trigger_proactive_reaction(event_dict)` | ✅ | LLM 1-sentence combat/anomaly reaction → TTS → broadcast all WS clients |

### 2.4 LangChain Pipeline

```
ChatPromptTemplate (system: Rachel / solar-system director prompt)
    ↓
ChatGroq (llama-3.3-70b-versatile, temperature=0.7)
    ↓
JsonOutputParser(pydantic_object=WorldState)
    → world_chain (invoked per user utterance)
```

System prompt injects: `{previous_state}`, `{past_world_history}` (FAISS top-3), `{recent_telemetry}` (last 10 events), `{user_input}`.

> ⚠️ `{current_player_x}` and `{current_player_y}` are passed to `world_chain.ainvoke()` but are **not in the prompt template** — silently ignored by LangChain.

### 2.5 DreamMemory (FAISS RAG)

- Encoder: `all-MiniLM-L6-v2` (384-dim).
- Index: `faiss.IndexFlatL2` — exact L2 nearest-neighbour, no quantisation.
- Each memory stored as: `"State: {summary}. Theme: {theme}. Terrain: {terrain}."`.
- `get_relevant_context(query, k=3)` → top-3 similar past states injected into prompt.
- Pre-seeded from `world_snap.json` on each new WebSocket connection.

### 2.6 HTTP Endpoints

| Route | Description |
|---|---|
| `GET /` | Health check |
| `POST /engine_telemetry` | Routes `game_over` → `trigger_game_over_reaction`; `anomaly_kill ≥10` or `combat_kill ≥1` → `trigger_proactive_reaction` |

### 2.7 WebSocket — `/api/v1/dream-stream`

Per-connection pipeline:

1. On connect: load `world_snap.json` → seed FAISS + `previous_state`.
2. `bytes` → accumulate in `audio_buffer`.
3. `{"type":"audio_end"}` → Whisper STT → LLM pipeline.
4. `{"type":"text_command","text":"..."}` → skip STT → LLM pipeline.
5. LLM pipeline: `world_chain.ainvoke` → send `"text"` reply → sync Rust engine → spawn/clear/despawn/modify → concurrent TTS + engine sync → send `"generation_result"`.
6. **Behavior policy application:** Attempts `GET /state` on Rust engine — **always fails** (route does not exist).
7. Proactive audio (`{"type":"proactive_audio", audio_b64, text}`) goes to **all** active connections, not just the triggering one.

---

## 3. React Web Client — `apps/web-client/`

**Runtime:** `npm run dev` → Vite, port 5173
**Styling:** TailwindCSS 3.4 + inline `<style>` keyframes

### 3.1 Dependencies

| Package | Purpose |
|---|---|
| `react` / `react-dom` 18.2 | UI framework |
| `@react-three/fiber` 8.18 | React renderer for Three.js (`<Canvas>`, `useFrame`) |
| `@react-three/drei` 9.122 | Three.js helpers: `PerspectiveCamera`, `OrbitControls`, `Stars`, `Environment`, `Float`, `Html`, `useGLTF` |
| `three` 0.183 | 3D engine |
| `react-use-websocket` 4.5 | Two WS connections with auto-reconnect |
| `lucide-react` 0.320 | Icons: `Activity`, `Mic`, `MicOff`, `Save`, `Volume2`, `VolumeX`, `Trash2` |
| `tailwindcss` 3.4 | Utility CSS |
| `vite` 5.0 | Dev server + bundler |
| `typescript` 5.2 | Type checking |

### 3.2 `main.tsx`
Entry point. Mounts `<App />` in `React.StrictMode`.

---

### 3.3 `App.tsx`

**WebSocket Connections:**

| WS URL | Purpose |
|---|---|
| `ws://127.0.0.1:8000/api/v1/dream-stream` | Python Director (STT/LLM/TTS/proactive audio) |
| `ws://127.0.0.1:8081/ws` | Rust Engine (60 fps render frames; sends player input) |

**State:**

| State | Type | Purpose |
|---|---|---|
| `isRecording` | boolean | Mic recording active |
| `directorMessage` | string | Last text from Director, shown in sidebar |
| `worldState` | any | Last full WorldState JSON from LLM |
| `engineSynced` | boolean | 3 s flash when Rust acknowledges sync |
| `textInput` | string | Manual override text field |
| `aiState` | `"idle" \| "synthesizing" \| "orchestrating"` | Spinner + button lock |
| `ecsEntities` | `Record<string, any>` | Live entity map by ID, updated 60 fps |
| `particles` | `any[]` | Live particle array, 60 fps |
| `zoom` | number 0.2–5.0 | Camera zoom, scroll-wheel driven |
| `isShaking` | boolean | Collision screen shake (220 ms) |
| `saveToast` | boolean | "Universe Saved" toast (3 s) |
| `isMuted` | boolean | Mutes generative collision audio |
| `isRachelEnabled` | boolean | Mutes Rachel TTS playback |
| `newbornIds` | `Set<number>` | `is_newborn:true` entities → birth glow CSS |
| `dyingIds` | `Set<number>` | `is_dying:true` entities → implosion CSS |
| `playerHealth` | number 0–100 | From `render_frame.player_health` |
| `score` | number | From `render_frame.score` |
| `isGameOver` | boolean | From `render_frame.is_game_over` |
| `showDamageFlash` | boolean | True 550 ms when health drops — red vignette |

**Key Handlers:**

| Handler | Description |
|---|---|
| `initAudio()` | Creates/resumes `AudioContext` on first user interaction |
| `playCollisionSound(speed, distance)` | Web Audio API: sine + sawtooth dual oscillator, 0.18 s envelope; freq from speed, gain from distance |
| `handleSave()` | `POST :8080/save` |
| `handleClearWorld()` | `POST :8080/clear` |
| Scroll wheel | Updates `zoom` → debounced 100 ms → `POST :8080/state` with zoom value |
| WASD / Arrows / Space | Sends `{msg_type:"player_input", keys:[...]}` to Rust WS on keydown/up |

**Incoming Rust WS messages:**

| `data.type` | Action |
|---|---|
| `"render_frame"` | Update `playerHealth/score/isGameOver`; detect health drop → damage flash; update `particles`; if `particles.length > 20` → shake + bass sound |
| `"collision_event"` | Screen shake 220 ms + `playCollisionSound` |
| any with `.entities[]` | Update `ecsEntities`; diff `is_newborn`/`is_dying` |

**Incoming Python WS messages:**

| `data.type` | Action |
|---|---|
| `"text"` | Update `directorMessage` |
| `"world_state"` | Update `worldState` |
| `"proactive_audio"` | Update `directorMessage`; play MP3 if `isRachelEnabled` |
| `"generation_result"` | Update `worldState`; flash `engineSynced`; play TTS audio |
| `"frame_update"` | **Dead code** — legacy Phase 1 no-op |
| `msg_type: "status"` | Update `aiState` |

**CSS Keyframe Animations:**

| Class / Animation | Trigger | Effect |
|---|---|---|
| `.shake` / `screen-shake` | `collision_event` | 0.2 s random translate+rotate |
| `.toast-anim` / `toast-in` | Save success | Fade/scale in+out 3 s |
| `.newborn` / `newborn-glow` | `is_newborn:true` | 1.2 s scale 0.1→1.3→1.0, brightness 5→1 |
| `.imploding` / `death-implode` | `is_dying:true` | 1.0 s scale 1.0→0, brightness 1→5 |
| `.behavior-attack` / `attack-pulse` | entity behavior | Red drop-shadow pulse 1 s infinite |
| `.behavior-protect` / `protect-shield` | entity behavior | Blue ring ripple 2 s infinite |
| `damage-flash` | health drop | 0.55 s opacity fade red vignette |
| `signal-lost-pulse` | `isGameOver` | 0.8 s alternating text-shadow |
| `low-health-blink` | health < 30% | Step-end blink 0.6 s |

> ⚠️ The sidebar renders `worldState.visual_prompt` — this field **no longer exists** in the Python `WorldState` schema. It always renders as `undefined`.

---

### 3.4 `GameScene.tsx`

Root Three.js scene inside `<Canvas>`.

- `<PerspectiveCamera>` FOV 50 — lerps toward `player + (0, 40/zoom, 60/zoom)` at 5%/frame, `lookAt` player.
- `<ambientLight>` intensity 0.1.
- `<pointLight>` at (0,0,0) / Sun: intensity 5, distance 5000, warm yellow `#fcd34d`.
- `<Environment preset="night">` — HDRI skybox.
- `<SpaceGrid />` — background grid plane.
- `<Starfield count={800} />` — static background stars.
- `<PlayerShip position rotation />` — player mesh.
- `<EntityRenderer entities newbornIds dyingIds />` — all non-player entity meshes.
- `<ParticleSystem particles />` — shatter particles.

> ⚠️ `OrbitControls` is **imported** from drei but **never rendered** in JSX. Dead import.

---

### 3.5 `EntityRenderer.tsx`

Dispatches Three.js meshes per `ent_type`. Skips `"player"`.

| `ent_type` | Geometry | Material |
|---|---|---|
| `"sun"` | `SphereGeometry(radius\|100, 64, 64)` | `meshStandardMaterial` emissive amber intensity 10 |
| `"planet"` | `SphereGeometry(radius\|20, 32, 32)` | Per-name color: Mercury gray, Venus gold, Earth blue, Mars red, Jupiter/Saturn amber, Uranus cyan, Neptune indigo |
| Saturn | + `TorusGeometry` ring (radius×1.8, width 4) | Transparent yellow 0.6 opacity |
| `"star"` | `BoxGeometry(0.5, 0.1, 0.1)` | `meshBasicMaterial` sky-blue |
| `"asteroid"` | `DodecahedronGeometry(radius\|5, 0)` | `meshStandardMaterial` dark gray, roughness 0.9 |
| `"projectile"` | `CylinderGeometry(0.05, 0.05, 1, 8)` | `meshStandardMaterial` red emissive intensity 5 |
| `"anomaly"` | **Not rendered** | — |
| `"companion"` | **Not rendered** | — |
| `"enemy"` | **Not rendered** | — |

Scale: `1.5` for newborn, `0.1` for dying, `1.0` otherwise.

---

### 3.6 `PlayerShip.tsx`

- `ShipFallback` (always active): cone body (wireframe cyan), two box wings, red engine sphere.
- `ShipModel`: loads GLTF via `useGLTF(url)` — **`modelUrl` is never passed from `GameScene.tsx`**, so `ShipFallback` is always used.
- `GLTFErrorBoundary`: React error boundary catches GLTF failures, shows fallback.
- Per-frame: position lerps 10%/frame, quaternion slerps rotation 10%/frame.
- `<Float speed=2>` from drei — passive floating animation.
- Thruster `<pointLight>` at (0,-1,0), red, intensity 2.
- `import { Html }` from drei — **unused**.

---

### 3.7 `ParticleSystem.tsx`

- Renders all shatter/explosion particles as a single `THREE.Points` mesh.
- Positions recomputed each render from 60 fps `particles[]` prop.
- All particles rendered in fiery orange (1.0, 0.4, 0.2) — **ignores `color` field** from Rust `ParticleData`.
- Size 2.5, size attenuation, opacity 0.8.

---

### 3.8 `SpaceGrid.tsx`

- `THREE.GridHelper` — 2000×2000 units, 20 divisions, purple `#8b5cf6`.
- Rotated `[-π/2, 0, 0]` to lie flat.
- Custom `onBeforeCompile` shader patch: multiplies opacity × 0.5.
- Semi-transparent glow plane underneath (5% opacity).

---

### 3.9 `Starfield.tsx`

- 800 points distributed on sphere shells r=[200, 1000] using spherical coordinates.
- Rotates Y += 0.0005, X += 0.0002 per frame.
- White, size 1.5, 80% opacity.

---

### 3.10 `HUD.tsx` (Phase 6.1)

Cyberpunk 2D HTML/Canvas overlay above the Three.js canvas.

**Health Bar** (`left: 340px`, `top: 24px` — past the Director sidebar):
- 192 px wide, segmented tick marks at 25/50/75%.
- Color: > 60% green `#22c55e`, 30–60% yellow `#eab308`, < 30% red `#ef4444`.
- Box-shadow glow in health color; smooth CSS transition on width change.
- `⚠ CRITICAL` step-blink label below 30%.

**Kill Score** (`top: 68px`, `right: 24px`):
- Purple `#a855f7` monospace number with text-shadow glow.

**SIGNAL LOST overlay** (full-screen, z-index 190):
- Visible only when `isGameOver === true`.
- 7xl bold red text with pulsing glow animation + "Rebooting Neural Link..." subtitle.

**Damage Flash Vignette** (full-screen, z-index 180):
- Visible only when `showDamageFlash === true`.
- `radial-gradient` transparent centre → `rgba(220,30,30,0.65)` edges.
- 0.55 s fade-out CSS animation.

**Tactical Radar** (160×160 canvas, `bottom: 36px`, `right: 32px`):
- Canvas clip circle, dark background, concentric rings at 25/50/75/100%, crosshair lines.
- Full repaint on every `entities` prop change.
- **Sun:** radial gradient yellow dot, always at canvas centre.
- **Planets:** radial gradient blue dot at `(x/2000 * 70, y/2000 * 70)` from centre.
- **Asteroids + Enemies:** 1.8 px red dot, clipped to circle.
- **Player:** white triangle with cyan stroke, rotated by `rotation + π/2` for correct heading.
- Legend row: Sun / Planet / Hostile / You.

---

## 4. Dead Code & Known Bugs Summary

| Location | Item | Notes |
|---|---|---|
| `main.rs` | `use base64::{Engine as _, STANDARD}` | Unused import, compiler warning |
| `main.rs` | `SinkExt` import | Unused |
| `main.rs` | Named `use systems::{...}` imports | Unused — schedule uses `systems::` prefix |
| `main.rs` | `Health` ECS component | Spawned but never queried; health tracked in `Arc<Mutex<f32>>` |
| `main.rs` | `CollisionEvent` only checks `"star"` type | Enemies/asteroids never trigger spatial audio |
| `python/main.py` | `behavior_policy` application | Calls non-existent `GET /state`; always fails silently |
| `python/main.py` | `current_player_x/y` in `ainvoke()` | Not in prompt template; silently ignored |
| `App.tsx` | `"frame_update"` WS handler | Legacy Phase 1 — never sent by current Python |
| `App.tsx` | `worldState.visual_prompt` sidebar | Field removed from schema; renders `undefined` |
| `GameScene.tsx` | `import { OrbitControls }` | Imported, never rendered |
| `PlayerShip.tsx` | `ShipModel` GLTF loader | `modelUrl` never passed; always uses `ShipFallback` |
| `PlayerShip.tsx` | `import { Html }` from drei | Unused |
| `ParticleSystem.tsx` | Particle `color` field | Received from Rust but ignored; all particles hardcoded orange |
| `EntityRenderer.tsx` | `"anomaly"`, `"companion"`, `"enemy"` types | Exist in ECS, no meshes rendered |

---

## 5. Active Data Flow (End-to-End)

```
User WASD / Space
    → App.tsx keydown/keyup
    → sendEcsMessage {msg_type:"player_input", keys:[...]}
    → Rust WS 8081 → PlayerInputState mutex
    → Game loop reads per frame

Rust Game Loop (60 fps)
    → generative_physics_system
    → environmental_physics_system (gravity/repulsor)
    → particle_physics_system
    → steering_system (AI behaviors)
    → Player movement (WASD + AI lerp + knockback decay)
    → Projectile tick + combat collision (30 px)
    → Player damage system (42 px vs enemies/asteroids)
    → Black hole event horizon check
    → DeathAge tick → Shatter Engine → despawn
    → Serialise RenderFrameState JSON
    → Broadcast to all 8081 WS clients

App.tsx ecsMessage handler
    → setEcsEntities → re-renders EntityRenderer, HUD radar
    → setParticles → re-renders ParticleSystem
    → setPlayerHealth / setScore / setIsGameOver
    → health drop → showDamageFlash 550 ms
    → particle surge → cinematic shake + bass sound

GameScene useFrame (60 fps)
    → Camera lerps to follow player
    → Three.js renders meshes, particles, grid, stars

User voice / text
    → App.tsx → Python WS 8000
    → Groq Whisper STT (audio) or text_command (text)
    → FAISS DreamMemory.get_relevant_context
    → LangChain world_chain (Llama 3.3-70b)
    → "text" msg → App.directorMessage (instant)
    → POST Rust /state (WorldState sync)
    → spawn / clear / despawn / modify as requested
    → ElevenLabs TTS → base64 MP3
    → "generation_result" msg → App plays audio

Rust combat_kill / anomaly_kill / game_over
    → POST Python :8000/engine_telemetry
    → game_over: LLM 1-line + TTS → "proactive_audio" → all WS clients
    → combat_kill / anomaly_kill: same pipeline
```

---

## 6. Runtime Ports

| Process | Command | Ports |
|---|---|---|
| Python Director | `uvicorn main:app --port 8000` | HTTP + WS 8000 |
| Rust Engine | `cargo run` | HTTP 8080, WS 8081 |
| React Client | `npm run dev` | HTTP 5173 (browser) |

All three started by `run_all.ps1` in separate PowerShell windows.