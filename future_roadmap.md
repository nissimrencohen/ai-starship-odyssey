# Future Roadmap & Unused Components

This document tracks planned features, original vision items not yet realized, and legacy "dead code" currently in the repository.

## 🌿 Future Roadmap (Planned Features)

### 1. Neural Rendering Pipeline
- **Original Vision**: Transition from Three.js meshes to continuous neural frame generation (DiT models / Open-Oasis philosophy).
- **Status**: Currently using traditional 3D rendering. Neural pipeline remains a core future goal.

### 2. Procedural Grounding (Infinigen integration)
- **Original Vision**: Detailed mathematical rules for infinite terrain and object generation.
- **Status**: Basic orbital/sinusoidal generation is in place; complex procedural world generation is pending.

### 3. Dynamic Physics Overrides
- **Goal**: Full LLM control over gravity, friction, and environmental physics parameters via chat.

## ⚠️ Unused / Legacy Items (Technical Debt)

### Rust Engine
- **Base64/Urlencoding Crates**: Imported but not actively used in the current pipeline.
- **ECS Health Component**: Defined and spawned, but health is currently tracked in a thread-safe mutex outside the ECS query loop.
- **Target Target/Release folders**: Temporary build artifacts that can be safely ignored in architecture discussions.

### Python Director
- **Behavior Policy Loop**: Currently attempts to call a non-existent `GET /state` endpoint on the engine. Needs refactoring to use the telemetry push model.
- **Player Coordinates in prompt**: Coordinates are passed to the chain but missing from the template, so the LLM isn't "seeing" the player's exact position.

### React Client
- **OrbitControls**: Imported but disabled to keep the camera locked to the player's tactical view.
- **GLTF Ship Models**: The infrastructure for external models exists, but a fallback primitive cone is currently used for the ship.
- **Particle Colors**: The engine sends specific colors, but the client currently hardcodes all particles to fiery orange.
