# AI Starship Odyssey 🚀

An AI-driven space exploration engine featuring a Rust core for state management, Python for AI orchestration, and a React frontend.

## 🌌 Overview

"The Void" is a real-time, voice-interactive space sandbox where the environment and AI agents respond dynamically to your commands. Experience a fully interactive Solar System managed by a high-performance Rust backend and orchestrated by a sophisticated Python AI Director.

## 🛠️ Technology Stack

| Component | Technology | Responsibility |
| :--- | :--- | :--- |
| **Frontend** | React + Vite + Three.js | 3D Visualization, Tactical HUD, and Voice Input |
| **Orchestrator** | Python (FastAPI + LangChain) | LLM Orchestration (Llama 3), STT/TTS, and Memory (FAISS) |
| **Core Engine** | Rust (Bevy ECS + Warp) | 60 FPS Physics, Collision Detection, and State Management |

## 📂 Project Structure

- **`apps/web-client`**: React-based PWA utilizing `@react-three/fiber` for real-time 3D rendering and WebRTC for audio.
- **`apps/python-director`**: The "Dream Architect" processing user intent via Groq and managing proactive AI reactions.
- **`engines/core-state`**: High-performance ECS-based simulation engine in Rust, serving as the system's source of truth.
- **`packages/`**: Shared types and utilities used across the monorepo.

## 🚀 Getting Started

1. **Environment Setup**:
   - Clone the repo.
   - Copy `.env.example` to `.env` and fill in your API keys (Groq, ElevenLabs, etc.).
2. **Launch**:
   - Run `./run_all.ps1` to start the Director, Engine, and Web Client concurrently.

---
*Built with Antigravity.*
