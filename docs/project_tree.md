# AI Starship Odyssey — Project File Tree

> **Last updated:** 2026-03-02
> Full annotated tree of all source files and assets under `C:\Project\`.

---

```
C:\Project\
│
├── engines/
│   └── core-state/                         # Rust game engine (bevy_ecs + warp)
│       ├── Cargo.toml                       # Dependencies: bevy_ecs, tokio, warp, reqwest, serde, uuid
│       ├── Cargo.lock
│       ├── build_err.txt                    # [TEMP] Build error log — safe to delete
│       ├── build_errors.txt                 # [TEMP] Build error log — safe to delete
│       ├── check_err.txt                    # [TEMP] cargo check output — safe to delete
│       ├── errors_final.txt                 # [TEMP] Error log — safe to delete
│       ├── target/                          # Rust build artifacts (not in git)
│       │   └── release/
│       │       └── core-state.exe           # Production binary
│       └── src/
│           ├── main.rs                      # Game loop, HTTP API, WebSocket server (~2100 lines)
│           ├── components.rs                # All Bevy ECS component definitions (~258 lines)
│           └── systems.rs                   # Physics, steering, particle ECS systems (~487 lines)
│
├── apps/
│   ├── python-director/                     # Python AI Director service
│   │   ├── main.py                          # FastAPI server, LLM, TTS, STT, FAISS (~800 lines)
│   │   ├── requirements.txt                 # Python dependencies
│   │   ├── .env                             # API keys: GROQ_API_KEY, ELEVENLABS_API_KEY
│   │   └── data/
│   │       └── engine_capabilities.md       # RAG knowledge base for LLM context
│   │
│   └── web-client/                          # React + Three.js frontend
│       ├── package.json                     # npm deps: react, three, @react-three/fiber, tailwind, vite
│       ├── package-lock.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── tailwind.config.js
│       ├── index.html                       # Vite entry HTML
│       ├── dist/                            # Built production bundle (not in git)
│       └── src/
│           ├── main.tsx                     # React DOM root mount
│           ├── App.tsx                      # Root component: all state, WebSocket, input loop (~800 lines)
│           └── components/
│               ├── GameScene.tsx            # Three.js canvas, camera, lighting (~259 lines)
│               ├── EntityRenderer.tsx       # Mesh dispatch for all entity types (~427 lines)
│               ├── PlayerShip.tsx           # Player ship mesh + GLTF loader (~179 lines)
│               ├── HUD.tsx                  # DOM overlay: health, radar, score, game-over (~400+ lines)
│               ├── Starfield.tsx            # Background star field: 5000 points (~77 lines)
│               └── ParticleSystem.tsx       # GPU particle points for explosions
│
├── data/                                    # 2K planet/star texture maps (PNG/JPG)
│   ├── earth.jpg
│   ├── mars.jpg
│   ├── jupiter.jpg
│   ├── venus.jpg
│   ├── mercury.jpg
│   ├── saturn.jpg
│   ├── uranus.jpg
│   ├── neptune.jpg
│   ├── sun.jpg
│   └── moon.jpg
│
├── docs/                                    # Project documentation (this folder)
│   ├── architecture.md                      # Full system architecture (authoritative)
│   ├── project_tree.md                      # This file — annotated project tree
│   └── future_roadmap.md                    # Cleanup tasks, bug fixes, and future features
│
├── packages/                                # Shared TypeScript types / utilities (currently minimal)
│
├── world_snap.json                          # Persisted world state (last saved snapshot)
├── run_all.ps1                              # PowerShell launcher: starts all three services
├── .env                                     # Root-level env vars (if any)
├── package.json                             # Root monorepo package.json (workspace config)
├── package-lock.json
├── node_modules/                            # Root npm modules (not in git)
└── error.txt                                # [TEMP] Root error log — safe to delete
```

---

## Key Source Files — Quick Reference

| File | Lines | Role |
|------|-------|------|
| `engines/core-state/src/main.rs` | ~2100 | Game loop, all HTTP routes, WebSocket broadcast, world init, survival system |
| `engines/core-state/src/components.rs` | ~258 | Every ECS component struct (`Transform`, `PhysicsType`, `SteeringAgent`, etc.) |
| `engines/core-state/src/systems.rs` | ~487 | 4 Bevy ECS systems: physics, particles, steering, generative |
| `engines/core-state/Cargo.toml` | 18 | Rust crate dependencies |
| `apps/python-director/main.py` | ~800 | FastAPI, Groq LLM + Whisper, ElevenLabs TTS, FAISS, LangChain |
| `apps/web-client/src/App.tsx` | ~800 | All React state, dual WebSocket handlers, 60fps input loop |
| `apps/web-client/src/components/GameScene.tsx` | ~259 | Three.js scene: camera, lighting, environment, child components |
| `apps/web-client/src/components/EntityRenderer.tsx` | ~427 | Maps entity types to Three.js meshes (sun/planet/asteroid/enemy/etc.) |
| `apps/web-client/src/components/HUD.tsx` | ~400 | Health bar, tactical radar, kill score, damage flash, expanded map |
| `apps/web-client/src/components/PlayerShip.tsx` | ~179 | Player mesh: 3 procedural variants + GLTF loader (unused) |
| `apps/web-client/src/components/Starfield.tsx` | 77 | 5000-point star field on spherical shells |
| `apps/python-director/data/engine_capabilities.md` | - | LLM RAG knowledge base (what commands the AI Director can issue) |
| `world_snap.json` | - | JSON snapshot of last saved world state |
| `run_all.ps1` | - | PowerShell script to start Rust + Python + Vite dev server |

---

## Ports Summary

| Port | Service | Protocol | Traffic |
|------|---------|---------|---------|
| 5173 | React dev server (Vite) | HTTP | Browser loads app |
| 8000 | Python AI Director | HTTP + WS | Audio/text commands in; WorldState + TTS out |
| 8080 | Rust engine HTTP API | HTTP | REST commands from Python Director |
| 8081 | Rust engine WebSocket | WS | `render_frame` broadcast out; `player_input` in |

---

## Temporary Files (Safe to Delete)

The following files are build artifacts and debug logs — they are not tracked in git and can be removed:

- `engines/core-state/build_err.txt`
- `engines/core-state/build_errors.txt`
- `engines/core-state/check_err.txt`
- `engines/core-state/errors_final.txt`
- `error.txt` (project root)

---

## Deleted / Consolidated Docs

The following documentation files existed in an earlier state and have been merged into the three authoritative docs:

| Old File | Merged Into |
|---------|------------|
| `docs/architecture_status.md` | `docs/architecture.md` |
| `docs/current_architecture.md` | `docs/architecture.md` |
| `docs/legacy_and_unused.md` | `docs/future_roadmap.md` |
| `docs/phase_9_plus_spec.md` | `docs/architecture.md` + `docs/future_roadmap.md` |
