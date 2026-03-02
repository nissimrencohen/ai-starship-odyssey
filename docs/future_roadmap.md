# AI Starship Odyssey — Future Roadmap

> **Last updated:** 2026-03-02
> This document covers: (1) dead code to delete, (2) bugs to fix, (3) disconnected features to wire up, (4) future feature additions.

---

## 1. Cleanup — Dead Code to Delete

These items exist in the codebase but serve no purpose and should be removed.

### 1.1 Rust — `engines/core-state/`

**Unused crates in `Cargo.toml` and `main.rs`:**
- Remove `base64` and `urlencoding` from `Cargo.toml` dependencies
- Remove their `use` declarations from `main.rs`
- Neither crate is used in the current HTTP/WebSocket data pipeline
- Removing them eliminates compiler warnings and reduces binary size

**`Health` ECS component (`components.rs`):**
- The `Health { max, current }` component struct is defined and registered in Bevy ECS but never used
- Player health is tracked via `Arc<Mutex<f32>>` outside the ECS (by design, for thread-safety)
- Enemy health is also tracked separately (despawned directly on collision)
- Action: delete the `Health` struct from `components.rs` and remove all `query<&Health>` references in `main.rs`

### 1.2 Python — `apps/python-director/main.py`

**Legacy behavior policy polling loop:**
- There is a code block that periodically calls `GET http://127.0.0.1:8080/state` to poll world state
- This is a remnant of an earlier architecture where Python pulled data from Rust
- The current architecture uses **push-based telemetry** (`POST /engine_telemetry` from Rust → Python)
- Action: delete the polling loop entirely; rely exclusively on `engine_telemetry` events

### 1.3 React — `apps/web-client/src/`

**`OrbitControls` import in `GameScene.tsx`:**
- `OrbitControls` is imported from `@react-three/drei` but never rendered in JSX
- The camera is now manually controlled via `cam_yaw` / `cam_pitch` from player input
- Action: remove the import line

**`Html` import in `PlayerShip.tsx`:**
- `Html` is imported from `@react-three/drei` but unused
- Action: remove the import line

**`worldState.visual_prompt` reference in `App.tsx`:**
- The `visual_prompt` field was removed from the `WorldState` schema
- It is still referenced in the sidebar rendering logic, causing a TypeScript warning
- Action: find and remove all references to `visual_prompt` in `App.tsx`

### 1.4 Temporary Files (root and engine)

Safe to delete — these are debug/build logs not tracked in git:
- `engines/core-state/build_err.txt`
- `engines/core-state/build_errors.txt`
- `engines/core-state/check_err.txt`
- `engines/core-state/errors_final.txt`
- `error.txt` (project root)

---

## 2. Bug Fixes — Broken or Disconnected Code

These features exist in code but are not correctly wired together.

### 2.1 Player Coordinates Missing from LLM Prompt (Medium Priority)

**Problem:** The Python director receives the player's `x`, `y`, `z` position in the telemetry data and passes it into the LangChain chain as input variables, but the `ChatPromptTemplate` does not include a `{player_position}` placeholder. As a result, the LLM has no spatial awareness of where the player is relative to planets, anomalies, or enemies.

**Fix:**
1. In `main.py`, add `{player_position}` to the system prompt template:
   ```
   The player is currently at coordinates: {player_position}.
   Use this to make spatially-aware decisions (e.g. spawn enemies near the player,
   describe nearby celestial bodies, reference proximity to anomalies).
   ```
2. Ensure the chain invocation passes `player_position` as a formatted string: `f"x={x:.0f}, y={y:.0f}, z={z:.0f}"`

### 2.2 Particle `custom_color` Ignored by Frontend (Medium Priority)

**Problem:** The Rust engine serializes a `custom_color` field on `Particle` entities (e.g. golden/yellow for black-hole shatter events, orange for combat). However, `EntityRenderer.tsx` (and/or `ParticleSystem.tsx`) hardcodes all particles to orange, ignoring the server-provided color.

**Fix:**
1. In the particle rendering logic, read `entity.custom_color` from the render frame data
2. Apply it as the `color` prop on the `<points>` material or individual particle mesh
3. Fall back to `#ff6600` (orange) if `custom_color` is absent

### 2.3 GLTF Ship Models Never Load (Low Priority)

**Problem:** `PlayerShip.tsx` contains a full GLTF loader with error boundary and a `ShipFallback` component. However, because no model file URLs are configured, the error boundary always catches and the procedural fallback always renders. The infrastructure is complete but inert.

**Fix:**
1. Add 3D ship GLTF models to `data/models/` (or serve from Python `/assets/models/`)
2. Map model type strings (`"fighter"`, `"freighter"`, `"stealth"`) to asset URLs
3. Pass the URL to `<ShipModel url={...} />` — the loader will then work as intended

### 2.4 Python Behavior Policy Loop Calls Non-Existent Pattern (Medium Priority)

**Problem:** The legacy polling loop in `main.py` was designed around a `GET /state` endpoint that returns full world state. Even though `/state` exists on the Rust side, using it for continuous polling is architecturally wrong (polling vs. push) and creates unnecessary load.

**Fix:** Delete the loop (see §1.2 above). No replacement needed — telemetry push already covers the use case.

---

## 3. Feature Completions — Wiring Up What Exists

These features are partially built and need final integration.

### 3.1 Visual Boundary Shader (World Edge)

**Status:** The physics boundary at ±32,000 units is enforced in `steering_system` (hard clamp). The player will stop but receive no visual feedback that they've hit the edge of the universe.

**Implementation:**
1. Add a large sphere (r=32,000) to `GameScene.tsx` with a custom `ShaderMaterial`
2. Shader: fully transparent from inside, shows a faint blue-purple glow at glancing angles (Fresnel effect)
3. When player health takes knockback from the boundary, trigger a brief `boundary-flash` CSS vignette (distinct color from the red damage flash — suggest electric blue)

### 3.2 Enemy Health Bars (HUD Enhancement)

**Status:** Enemy health exists in logic (entities are despawned when hit enough times) but there are no health bars in the HUD above enemy ships.

**Implementation:**
1. In `EntityRenderer.tsx`, add a `<Html>` drei component above each enemy entity
2. Render a small `<div>` health bar (width proportional to remaining HP ratio)
3. Show only when the enemy is within a configurable combat range (e.g. 2000 units from player)
4. Color: green → yellow → red as HP decreases

### 3.3 Targeting Bracket Integration

**Status:** The targeting bracket mesh (ring + corner accents) exists in `EntityRenderer.tsx` but may not be consistently applied to the currently targeted entity.

**Implementation:**
1. Ensure `App.tsx` maintains a `targetedEntityId` state
2. Pass it to `EntityRenderer` — render the bracket only on the matching entity
3. Add keyboard binding (e.g. `Tab`) to cycle through nearest enemies

---

## 4. Future Features — New Additions

Ordered roughly by estimated impact vs. implementation effort.

### 4.1 Expanded LLM Context: Sector History (Short-term)

**Goal:** Give the AI Director memory of what has happened in specific regions of space.

**Implementation:**
1. Extend the FAISS index to store location-tagged events (e.g. `"Battle at sector [12000, 0, -8000] — 3 pirates destroyed"`)
2. On each LLM call, include the top-3 memories filtered by proximity to the player's current coordinates
3. Update `engine_capabilities.md` RAG knowledge base with sector naming conventions

### 4.2 Dynamic Physics Overrides (Medium-term)

**Goal:** Allow the AI Director to modify global physics constants in real time — gravity multiplier, friction coefficient, projectile speed — as narrative events.

**Implementation (Rust side):**
1. Add a `PhysicsConstants` resource to the Bevy world: `{ gravity_scale: f32, friction: f32, projectile_speed_mult: f32 }`
2. Add a new HTTP endpoint: `POST /api/physics` that updates this resource
3. All systems read from `PhysicsConstants` instead of hardcoded values

**Implementation (Python side):**
1. Add `physics_overrides` field to the `WorldState` JSON schema
2. Dispatch to the new `/api/physics` endpoint when the LLM includes overrides

### 4.3 Faction Diplomacy System (Medium-term)

**Goal:** Allow the AI Director to change relationships between factions (pirate, federation, neutral) dynamically, causing former allies to turn on each other.

**Implementation:**
1. Add a `FactionRelations` resource in Rust: 3×3 matrix of faction affinity values (−1 = hostile, 0 = neutral, +1 = allied)
2. `steering_system` reads this matrix to determine targeting priority
3. Python can send `POST /api/factions` to update the matrix
4. Add `faction_relations` field to the LLM `WorldState` schema

### 4.4 Procedural Planet Surfaces (Long-term)

**Goal:** Replace the simple textured sphere planets with procedurally generated surface geometry using noise-based terrain.

**Implementation:**
1. In `EntityRenderer.tsx`, replace sphere geometry for planets with a custom `ProceduralPlanet` component
2. Use `simplex-noise` or similar to displace vertices of a high-subdivision sphere
3. Add biome coloring based on height (ocean/land/mountain)
4. Tie planet seed to entity ID so planets are consistent across sessions

### 4.5 Neural Rendering Pipeline (Long-term / Experimental)

**Goal:** Replace or augment Three.js rendering with diffusion-model-generated frames for a photorealistic aesthetic (Open-Oasis style).

**Approach:**
1. Render Three.js scene to a low-res canvas as a depth/semantic map
2. Send the map + text prompt (from LLM `conversational_reply`) to a local diffusion model (e.g. Stable Diffusion with ControlNet)
3. Composite the generated frame over or under the Three.js canvas
4. Target: 8–12 fps for the neural layer; Three.js layer handles UI/HUD at 60fps

**Note:** This requires a local GPU with ~8GB VRAM. The Three.js layer remains the fallback for all gameplay logic.

### 4.6 Infinigen Planet Landing (Long-term / Experimental)

**Goal:** When the player flies close enough to a planet surface, transition to a procedurally generated ground-level environment created by [Infinigen](https://github.com/princeton-vl/infinigen).

**Approach:**
1. Detect when player altitude (distance from planet center − planet radius) < landing threshold
2. Trigger a loading transition screen
3. Load a pre-generated Infinigen scene (exported as GLTF) matching the planet's biome type
4. Suspend the space simulation; swap to first-person ground controls

---

## 5. Build & Dev Quality Improvements

### 5.1 Replace PowerShell Launcher with Process Manager

**Current:** `run_all.ps1` starts all three services manually.

**Improvement:** Use `pm2` (Node.js process manager) or `overmind` (Procfile-based) to manage all three services with automatic restarts:

```
# Procfile
rust:   cd engines/core-state && ./target/release/core-state.exe
python: cd apps/python-director && uvicorn main:app --port 8000
web:    cd apps/web-client && npm run dev
```

### 5.2 TypeScript Strict Mode

**Current:** `tsconfig.json` may not have `strict: true` enabled.

**Improvement:** Enable strict mode and fix resulting type errors — this will catch the `worldState.visual_prompt` reference and other dead/unsafe code paths at compile time.

### 5.3 Rust: Separate Modules

**Current:** `main.rs` is ~2100 lines covering HTTP handlers, game loop, world init, and serialization.

**Improvement:** Split into modules:
- `src/main.rs` — server setup and entry point only
- `src/api/mod.rs` — all HTTP route handlers
- `src/world.rs` — world initialization and serialization
- `src/game_loop.rs` — tick logic, collision detection, input processing

---

## 6. Priority Summary

| Item | Type | Priority | Effort |
|------|------|---------|--------|
| Delete unused Rust crates | Cleanup | High | 5 min |
| Delete Python polling loop | Cleanup | High | 5 min |
| Remove dead React imports | Cleanup | High | 5 min |
| Fix player coords in LLM prompt | Bug fix | High | 30 min |
| Fix particle `custom_color` rendering | Bug fix | Medium | 1 hr |
| Add visual boundary shader | Feature | Medium | 2 hr |
| Add enemy health bars | Feature | Medium | 2 hr |
| Load GLTF ship models | Feature completion | Low | 3 hr |
| Expand LLM sector history | Feature | Medium | 4 hr |
| Dynamic physics overrides | Feature | Medium | 6 hr |
| Faction diplomacy system | Feature | Medium | 8 hr |
| Procedural planet surfaces | Feature | Low | 16 hr |
| Neural rendering pipeline | Experimental | Low | 40+ hr |
| Infinigen planet landing | Experimental | Low | 80+ hr |
