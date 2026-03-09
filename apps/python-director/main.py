import os
import sys
import subprocess
import json
import asyncio
import math
import logging
import re
import tempfile
import base64
import httpx

try:
    import piper
except ImportError:
    print("Auto-installing piper-tts in the current active environment...", flush=True)
    subprocess.check_call([sys.executable, "-m", "pip", "install", "piper-tts==1.4.1"])
    import piper

try:
    import edge_tts
except ImportError:
    print("Auto-installing edge-tts in the current active environment...", flush=True)
    subprocess.check_call([sys.executable, "-m", "pip", "install", "edge-tts"])
    import edge_tts
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List, Literal
import urllib.parse
import random
import time
from collections import deque
from dotenv import load_dotenv
import redis
import redis.commands.search.field as RedisField
import redis.commands.search.query as RedisQuery
from redis.commands.search.indexDefinition import IndexDefinition, IndexType
from pathlib import Path
import numpy as np
import hashlib
import struct

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# Load .env from the project root directory (c:\Project\.env)
dotenv_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env')
if not os.path.exists(dotenv_path):
    logger.error(f"CRITICAL WARNING: .env FILE NOT FOUND AT: {dotenv_path}")
else:
    logger.info(f"Loaded .env file from: {dotenv_path}")

load_dotenv(dotenv_path, override=True)
# LangChain and Groq
from groq import AsyncGroq
from langchain_groq import ChatGroq
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from langchain_core.exceptions import OutputParserException
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI
try:
    import tiktoken
except ImportError:
    tiktoken = None



app = FastAPI(title="Voice-to-Dream Director API")

# Active WebSocket connections
active_connections: List[WebSocket] = []

# Setup CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static Asset Configuration
app_dir = os.path.dirname(os.path.abspath(__file__))
data_dir = os.path.join(app_dir, "..", "web-client", "public", "assets")
backend_data_dir = os.path.join(app_dir, "data")

# Mount generated textures specifically (must come BEFORE /assets to avoid being shadowed)
generated_dir = os.path.join(app_dir, "..", "web-client", "public", "assets", "generated")
os.makedirs(generated_dir, exist_ok=True)

# Cleanup old textures and registry on startup
for f in os.listdir(generated_dir):
    if f.endswith(".png"):
        try:
            os.remove(os.path.join(generated_dir, f))
        except Exception as _e:
            logger.debug(f"Could not purge old texture {f}: {_e}")

# Reset texture registry JSON
try:
    reg_path = os.path.join(backend_data_dir, ".cache", "texture_registry.json")
    if os.path.exists(reg_path):
        os.remove(reg_path)
except Exception as _e:
    logger.debug(f"Could not purge texture registry: {_e}")

app.mount("/assets/generated", StaticFiles(directory=generated_dir), name="assets_generated")

# Mount audio files (Piper TTS output)
audio_dir = os.path.join(app_dir, "..", "web-client", "public", "assets", "audio")
os.makedirs(audio_dir, exist_ok=True)

# Cleanup old audio files on startup
for f in os.listdir(audio_dir):
    if f.endswith((".wav", ".mp3")):
        try:
            os.remove(os.path.join(audio_dir, f))
        except Exception as _e:
            logger.debug(f"Could not purge old audio file {f}: {_e}")

app.mount("/assets/audio", StaticFiles(directory=audio_dir), name="assets_audio")

# Mount static assets (textures, etc.)
# data/ contains 2K textures for the solar system
app.mount("/assets", StaticFiles(directory=data_dir), name="assets")

# Initialize Groq Client for Whisper STT
try:
    groq_api_key = os.getenv("GROQ_API_KEY")
    groq_client = AsyncGroq(api_key=groq_api_key) if groq_api_key else None
    if not groq_client:
        logger.warning("GROQ_API_KEY is not set. Transcription will use mock fallback.")
except Exception as e:
    logger.error(f"Failed to initialize Groq Client: {e}")
    groq_client = None

# Initialize ElevenLabs config
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")

if not ELEVENLABS_API_KEY:
    logger.error("CRITICAL WARNING: ELEVENLABS_API_KEY is missing or empty in the .env file!")
else:
    logger.debug(f"ELEVENLABS_API_KEY starts with: {ELEVENLABS_API_KEY[:4]}... (Length: {len(ELEVENLABS_API_KEY)})")
    
    # Pre-flight readiness check for ElevenLabs to prevent 401 Unauthorized during playtime
    import requests
    try:
        r = requests.get("https://api.elevenlabs.io/v1/user/subscription", headers={"xi-api-key": ELEVENLABS_API_KEY}, timeout=5.0)
        if r.status_code == 401:
            logger.error("ElevenLabs API Key is UNAUTHORIZED (401). TTS will be disabled.")
            ELEVENLABS_API_KEY = None
        elif r.status_code == 200:
            subs = r.json()
            used = subs.get("character_count", 0)
            limit = subs.get("character_limit", 10000)
            logger.info(f"ElevenLabs Quota used: {used} / {limit}")
            if used >= limit:
                logger.warning("ElevenLabs quota EXCEEDED! TTS will be disabled.")
                ELEVENLABS_API_KEY = None
        else:
            logger.warning(f"ElevenLabs returned unexpected status on check: {r.status_code}")
    except Exception as e:
        logger.warning(f"Failed to verify ElevenLabs subscription status: {e}")

# Initialize HF_TOKEN check
HF_TOKEN = os.getenv("HF_TOKEN")
if not HF_TOKEN:
    logger.error("CRITICAL ERROR: HF_TOKEN is missing in the .env file! AI Texture Generation will FAIL.")
else:
    logger.info(f"Hugging Face Token detected: {HF_TOKEN[:8]}...")

VOICE_ID = "21m00Tcm4TlvDq8ikWAM" # Standard Rachel pre-made voice ID, guaranteed accessible on free tier

class TTSManager:
    """Manages TTS generation with Piper (primary) and ElevenLabs (fallback/testing)."""

    USE_PIPER = True
    USE_ELEVENLABS = False

    # Piper model cache
    piper_model = None
    piper_model_path = None

    @classmethod
    def _get_piper_model_path(cls) -> str:
        """Get path to Piper voice model."""
        if cls.piper_model_path:
            return cls.piper_model_path

        models_dir = Path.home() / ".local" / "share" / "piper" / "voices"
        models_dir.mkdir(parents=True, exist_ok=True)

        model_file = models_dir / "en_US-lessac-medium.onnx"
        cls.piper_model_path = str(model_file)
        return cls.piper_model_path

    # HuggingFace URLs for en_US-lessac-medium voice
    _PIPER_BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium"

    @classmethod
    async def _ensure_piper_model(cls):
        """Download Piper ONNX model and config from HuggingFace if not present."""
        if not cls.USE_PIPER:
            return

        model_path = Path(cls._get_piper_model_path())
        config_path = Path(str(model_path) + ".json")

        if model_path.exists() and config_path.exists():
            logger.debug(f"Piper model already exists at {model_path}")
            return

        logger.info("Downloading Piper TTS model (en_US-lessac-medium) from HuggingFace...")
        model_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
                # Download ONNX model
                if not model_path.exists():
                    logger.info("  Downloading .onnx model file (~60MB)...")
                    async with client.stream("GET", f"{cls._PIPER_BASE_URL}/en_US-lessac-medium.onnx") as r:
                        r.raise_for_status()
                        with open(model_path, "wb") as f:
                            async for chunk in r.aiter_bytes(chunk_size=65536):
                                f.write(chunk)
                    logger.info(f"  Model saved to {model_path}")

                # Download config JSON
                if not config_path.exists():
                    logger.info("  Downloading .onnx.json config...")
                    r = await client.get(f"{cls._PIPER_BASE_URL}/en_US-lessac-medium.onnx.json")
                    r.raise_for_status()
                    with open(config_path, "wb") as f:
                        f.write(r.content)
                    logger.info(f"  Config saved to {config_path}")

            logger.info("Piper TTS model download complete.")
        except Exception as e:
            logger.error(f"Failed to download Piper model: {e}")
            raise

    @classmethod
    async def generate_speech_piper(cls, text: str) -> Optional[str]:
        """Generate speech with Piper TTS and save to disk. Returns relative URL path."""
        import wave
        try:
            await cls._ensure_piper_model()

            from piper.voice import PiperVoice

            model_path = cls._get_piper_model_path()
            voice = PiperVoice.load(model_path)

            # Generate unique filename with timestamp
            timestamp = int(time.time() * 1000)
            audio_filename = f"response_{timestamp}.wav"

            # Save to /public/assets/audio/ folder
            app_dir = os.path.dirname(os.path.abspath(__file__))
            audio_dir = os.path.join(app_dir, "..", "web-client", "public", "assets", "audio")
            os.makedirs(audio_dir, exist_ok=True)

            audio_path = os.path.join(audio_dir, audio_filename)

            # Synthesize and write PCM frames to WAV
            with wave.open(audio_path, "w") as wav_file:
                wav_file.setnchannels(1)       # Mono
                wav_file.setsampwidth(2)       # 16-bit PCM
                wav_file.setframerate(voice.config.sample_rate)
                for chunk in voice.synthesize(text):
                    wav_file.writeframes(chunk.audio_int16_bytes)

            logger.info(f"Piper TTS: Generated {audio_filename} ({len(text)} chars)")

            # Return absolute URL pointing to the Python FastAPI server (port 8000)
            return f"{SELF_URL}/assets/audio/{audio_filename}"
        except Exception as e:
            logger.error(f"Piper TTS Error: {e}")
            return None

    EDGE_TTS_VOICE = "en-GB-SoniaNeural"

    @classmethod
    async def generate_speech_edge(cls, text: str) -> Optional[str]:
        """Generate speech with edge-tts (Microsoft Azure Neural) and save as .mp3. Returns absolute URL."""
        try:
            timestamp = int(time.time() * 1000)
            audio_filename = f"response_{timestamp}.mp3"

            app_dir = os.path.dirname(os.path.abspath(__file__))
            audio_dir = os.path.join(app_dir, "..", "web-client", "public", "assets", "audio")
            os.makedirs(audio_dir, exist_ok=True)
            audio_path = os.path.join(audio_dir, audio_filename)

            communicate = edge_tts.Communicate(text, cls.EDGE_TTS_VOICE)
            await communicate.save(audio_path)

            logger.info(f"Edge-TTS: Generated {audio_filename} ({len(text)} chars)")
            return f"{SELF_URL}/assets/audio/{audio_filename}"
        except Exception as e:
            logger.error(f"Edge-TTS Error: {e}")
            return None

    @classmethod
    async def generate_speech_elevenlabs(cls, text: str) -> Optional[str]:
        """Generate speech with ElevenLabs and return base64 encoded string."""
        if not ELEVENLABS_API_KEY:
            logger.warning("ELEVENLABS_API_KEY not set. Skipping ElevenLabs TTS.")
            return None
        try:
            url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}?output_format=mp3_44100_128"
            headers = {
                "xi-api-key": ELEVENLABS_API_KEY,
                "Content-Type": "application/json"
            }
            data = {
                "text": text,
                "model_id": "eleven_monolingual_v1",
                "voice_settings": {"stability": 0.5, "similarity_boost": 0.5}
            }
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json=data, headers=headers, timeout=15.0)
                if response.status_code == 401:
                    logger.warning("ElevenLabs: 401 Unauthorized. Key might be invalid or expired.")
                    return None
                response.raise_for_status()
                logger.info(f"ElevenLabs TTS: Generated audio for {len(text)} chars")
                return base64.b64encode(response.content).decode("utf-8")
        except Exception as e:
            logger.error(f"ElevenLabs TTS Error: {e}")
            return None

    @classmethod
    async def generate_speech(cls, text: str) -> tuple[Optional[str], Optional[str]]:
        """
        3-Tier TTS Cascade:
        - Tier 1 (premium, opt-in): ElevenLabs — if USE_ELEVENLABS=True. Returns (None, b64).
        - Tier 2 (default):         edge-tts    — Microsoft Azure Neural voices. Returns (url, None).
        - Tier 3 (offline fallback): Piper TTS  — local ONNX, no network needed. Returns (url, None).
        """
        if cls.USE_ELEVENLABS:
            audio_b64 = await cls.generate_speech_elevenlabs(text)
            return (None, audio_b64)

        # Tier 2: edge-tts
        try:
            audio_url = await cls.generate_speech_edge(text)
            if audio_url:
                return (audio_url, None)
            raise RuntimeError("edge-tts returned None")
        except Exception as e:
            logger.warning(f"Edge-TTS failed ({e}), falling back to Piper...")

        # Tier 3: Piper offline fallback
        audio_url = await cls.generate_speech_piper(text)
        return (audio_url, None)

# Legacy function for backwards compatibility
async def generate_speech(text: str) -> Optional[str]:
    """Legacy wrapper for TTSManager. Returns audio_b64 for backwards compatibility."""
    audio_url, audio_b64 = await TTSManager.generate_speech(text)
    return audio_b64

async def sync_with_engine(state_data: dict) -> bool:
    """Pushes the new WorldState to the Rust Core Engine non-blockingly."""
    try:
        url = f"{RUST_ENGINE_URL}/state"
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=state_data, timeout=5.0)
            if response.status_code == 200:
                logger.info("Successfully synced state with Rust Engine.")
                return True
            else:
                logger.warning(f"Engine state sync returned status: {response.status_code}")
                return False
    except httpx.RequestError as e:
        logger.warning(f"Failed to connect to Rust Engine: {e}")
        return False

def deep_scrub_none(obj: Any) -> Any:
    """Recursively removes None values from dictionaries and lists."""
    if isinstance(obj, dict):
        return {k: deep_scrub_none(v) for k, v in obj.items() if v is not None}
    elif isinstance(obj, list):
        return [deep_scrub_none(v) for v in obj if v is not None]
    return obj

async def scrub_and_sync_state(state_data: dict) -> bool:
    """Cleans numeric overrides and syncs state with Rust."""
    # 1. Scrub Reality Overrides
    ro = state_data.get("reality_override")
    if ro and isinstance(ro, dict):
        ro["gravity_multiplier"] = clean_float(ro.get("gravity_multiplier"), 1.0)
        ro["player_speed_multiplier"] = clean_float(ro.get("player_speed_multiplier"), 1.0)
        ro["global_friction"] = clean_float(ro.get("global_friction"), 0.95)
    
    # 2. Scrub Weapon Overrides 
    wo = state_data.get("modify_weapon")
    if wo and isinstance(wo, dict):
        try:
            val = wo.get("projectile_count")
            wo["projectile_count"] = int(val) if val is not None else 1
        except (ValueError, TypeError):
            wo["projectile_count"] = 1
        wo["spread"] = clean_float(wo.get("spread"), 0.1)

    # 3. Scrub Player coordinates (optional moves)
    if state_data.get("player_x") is not None:
        state_data["player_x"] = clean_float(state_data["player_x"])
    if state_data.get("player_y") is not None:
        state_data["player_y"] = clean_float(state_data["player_y"])

    # 4. Deep scrub all None values to prevent Rust engine 400 Bad Request
    scrubbed_data = deep_scrub_none(state_data)

    return await sync_with_engine(scrubbed_data)

async def spawn_entities_in_engine(spawn_list: list) -> bool:
    """Sends new entity creation requests to `/spawn`."""
    if not spawn_list:
        return True
        
    # Patch potentially missing LLM fields to avoid Rust parser crash
    for s in spawn_list:
        if "x" not in s: s["x"] = random.uniform(-200, 200)
        if "y" not in s: s["y"] = random.uniform(-200, 200)
        if "physics" not in s: s["physics"] = "orbital"
        if "ent_type" not in s: s["ent_type"] = "star"
        if "faction" not in s: s["faction"] = "neutral"

    try:
        url = f"{RUST_ENGINE_URL}/spawn"
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=spawn_list, timeout=5.0)
            if response.status_code == 200:
                logger.info(f"Successfully spawned {len(spawn_list)} entities.")
                return True
            else:
                logger.warning(f"Spawn Engine returned status: {response.status_code}")
                return False
    except httpx.RequestError as e:
        logger.warning(f"Failed to connect to Spawn Engine: {e}")
        return False
    return False

async def manage_entities_in_engine(endpoint: str, payload: Any = None) -> bool:
    """Sends lifecycle management requests to `/clear`, `/despawn`, or `/modify`."""
    if endpoint == "modify" and isinstance(payload, list):
        # Drop modify requests missing the required `id` field
        payload = [p for p in payload if "id" in p]
        if not payload:
            return True
            
    try:
        url = f"{RUST_ENGINE_URL}/{endpoint}"
        async with httpx.AsyncClient() as client:
            if payload is not None:
                response = await client.post(url, json=payload, timeout=5.0)
            else:
                response = await client.post(url, timeout=5.0)
            
            if response.status_code == 200:
                logger.info(f"Successfully called /{endpoint}.")
                return True
            else:
                logger.warning(f"Engine /{endpoint} returned status: {response.status_code}")
                return False
    except httpx.RequestError as e:
        logger.warning(f"Failed to connect to Engine /{endpoint}: {e}")
        return False
    return False

class SpawnEntity(BaseModel):
    ent_type: Literal['star', 'companion', 'asteroid', 'enemy', 'planet', 'sun', 'anomaly', 'projectile', 'player'] = Field(..., description="The type of entity")
    x: float
    y: float
    physics: str = Field(..., description="'orbital', 'sinusoidal', or 'static'")
    faction: str = Field(default="neutral", description="The faction of the entity: 'pirate', 'federation', or 'neutral'. Default is 'neutral'.")
    radius: Optional[float] = None
    speed: Optional[float] = None
    amplitude: Optional[float] = None
    frequency: Optional[float] = None

class DespawnFilter(BaseModel):
    ent_type: Optional[str] = Field(None, description="Remove all entities of this type")
    color: Optional[str] = Field(None, description="Remove all entities of this color")
    ids: Optional[List[int]] = Field(None, description="Remove these specific entity IDs")

class Anomaly(BaseModel):
    anomaly_type: str = Field(..., description="'black_hole' or 'repulsor'")
    mass: float = Field(..., description="Mass of the anomaly, higher means stronger gravity.")
    radius: float = Field(..., description="Radius of visual/effect. Keep ≤500 for a massive black hole. Do NOT use values like 5000.")
    x: float = Field(..., description="World X coordinate. Player starts near x=8500. Sun is at x=0.")
    y: float = Field(0.0, description="Height offset (vertical axis). Usually 0.")
    z: float = Field(0.0, description="World Z coordinate. Sun is at z=0. Use this to place anomaly near the player.")

class ModifyEntity(BaseModel):
    id: int = Field(..., description="The exact ID of the entity to modify (must exist in current world state)")
    z: Optional[float] = Field(None, description="New absolute Z coordinate for volumetric positioning.")
    physics: Optional[str] = None
    color: Optional[str] = None
    radius: Optional[float] = None
    speed: Optional[float] = None
    amplitude: Optional[float] = None
    frequency: Optional[float] = None
    behavior: Optional[str] = Field(None, description="'idle', 'swarm', 'attack', 'protect', or 'scatter'")

class TelemetryEvent(BaseModel):
    event_type: str
    count: int
    cause: str
    timestamp: str
    x: Optional[float] = None  # World X coord of the event (optional)
    z: Optional[float] = None  # World Z coord of the event (optional)

class ModifyPlayer(BaseModel):
    model_type: Optional[str] = Field(None, description="The tactical ship chassis to switch to. Options: 'ufo', 'fighter' (agile, combat), 'stealth' (covert, fast), or 'freighter'/'goliath' (heavy armor, slow).")
    color: Optional[str] = Field(None, description="Hex color or CSS color name for the ship's outer hull.")
    is_cloaked: Optional[bool] = Field(None, description="If true, the player ship becomes invisible visually and on radar.")

telemetry_buffer = deque(maxlen=10)

# Module-level kill event log used by the Player Profiling system.
# Each entry: {"count": int, "cause": str, "ts": float}
kill_event_log: List[dict] = []

# Module-level destruction cluster log for Graveyard ECOLOGY memory.
# Each entry: {"count": int, "cause": str, "ts": float, "x": float, "z": float}
destruction_cluster_log: List[dict] = []

# Last known player world position, updated from both the WS handler and telemetry.
# Used by async telemetry hooks that run outside the WebSocket session.
shared_player_pos: Dict[str, float] = {"x": 0.0, "y": 0.0, "z": 0.0}

# Registry of active session DreamMemory objects.
# Telemetry hooks (nemesis, graveyard) iterate this to write into live sessions.
# Populated/depopulated by the WebSocket handler at connect/disconnect.
_active_session_memories: List["DreamMemory"] = []

# Lore patterns used by the Narrative extraction pass on conversational_reply
# ── Drama Thresholds for the Proactive DM Dispatcher ────────────────────────
# event_type → minimum `count` that triggers a DM reaction.
# game_over is always handled separately by trigger_game_over_reaction.
DRAMA_THRESHOLDS: Dict[str, int] = {
    "combat_kill":  3,   # burst of 3+ simultaneous kills feels significant
    "anomaly_kill": 1,   # any anomaly consumption is always dramatic
    "level_up":     1,   # always react to level advancement
}

# ── Spawn Sanity Caps (Hard Backend Enforcement) ────────────────────────────
# These caps are applied AFTER the LLM generates its response and BEFORE the
# payload is dispatched to the Rust engine.  The system prompt tells the LLM
# about these limits, but we enforce them here in case the model ignores them.
SPAWN_CAPS: Dict[str, int] = {
    "enemy":    12,   # max enemies per single LLM call
    "asteroid":  5,   # max asteroids per call
    "anomaly":   1,   # max anomalies (black holes / repulsors) per call
    "companion": 5,   # max companions per call
    "planet":    3,   # max planets per call (exotic spawns only)
    "star":      1,   # only 1 star spawn per call
    "sun":       1,   # only 1 sun per call
}
SPAWN_TOTAL_CAP = 20  # absolute ceiling across all types combined

_LORE_PATTERNS = [
    r"(?:will|shall)\s+(?:destroy|attack|return|rise|fall|awaken|come|strike|invade)[^.!?]{0,60}[.!?]",
    r"(?:building|gathering|preparing|brewing|assembling)\s+(?:a\s+)?(?:weapon|fleet|army|force|plan|storm)[^.!?]{0,60}[.!?]",
    r"(?:ancient|forgotten|hidden|secret|mysterious)\s+(?:signal|power|artifact|relic|energy|presence)[^.!?]{0,60}[.!?]",
    r"(?:warning|danger|threat|storm)\s+is\s+(?:coming|approaching|imminent|near)[^.!?]{0,60}[.!?]",
    r"(?:The\s+)?(?:Federation|pirates|rebels|enemy|force)\s+(?:is\s+)?(?:building|planning|gathering|mobilizing)[^.!?]{0,60}[.!?]",
]

# Shared World State Schema mapped to JSON
# Shared World State Schema mapped to JSON

class RealityOverride(BaseModel):
    sun_color: Optional[str] = Field(None, description="Hex color for the Sun and main point light")
    ambient_color: Optional[str] = Field(None, description="Hex color for the ambient environment light")
    gravity_multiplier: Optional[float] = Field(None, description="Multiplier for black hole/sun gravity (default 1.0)")
    player_speed_multiplier: Optional[float] = Field(None, description="Multiplier for player WASD speed (default 1.0)")
    global_friction: Optional[float] = Field(None, description="Friction for steering agents. Normal is 0.95. Lower means more slippery.")

class MissionParameters(BaseModel):
    seed: int = Field(default=42, description="Seed for deterministic asteroid generation.")
    density: float = Field(default=0.005, description="Asteroid density (0.0 to 0.1).")
    min_scale: float = Field(default=0.5, description="Minimum asteroid scale.")
    max_scale: float = Field(default=10.0, description="Maximum asteroid scale.")
    drift_velocity: float = Field(default=0.0, description="Global drift velocity for asteroids.")

class AudioSettings(BaseModel):
    game_muted: bool = Field(default=False, description="Mute all game sound effects and music.")
    ai_muted: bool = Field(default=False, description="Mute your own (Rachel's) voice output. IMPORTANT: You MUST inform the pilot before muting yourself.")

class PhysicsOverride(BaseModel):
    gravity_scale: Optional[float] = Field(None, description="Multiplier for all gravitational anomaly forces (default 1.0). Range 0.0–5.0. Use 0.0 for zero-gravity.")
    friction: Optional[float] = Field(None, description="Friction coefficient for all steering agents (default 0.95). Range 0.5–1.0. Lower = more slippery chaos.")
    projectile_speed_mult: Optional[float] = Field(None, description="Speed multiplier for ALL projectiles fired by any ship (default 1.0). Range 0.1–5.0.")

class FactionUpdate(BaseModel):
    faction_a: str = Field(..., description="First faction: 'pirate', 'federation', or 'neutral'")
    faction_b: str = Field(..., description="Second faction: 'pirate', 'federation', or 'neutral'")
    affinity: float = Field(..., description="Diplomatic affinity: -1.0 = fully hostile, 0.0 = neutral, +1.0 = fully allied")

class WeaponOverride(BaseModel):
    projectile_count: Optional[int] = Field(None, description="Number of projectiles fired at once (1, 2, 3, or 5).")
    projectile_color: Optional[str] = Field(None, description="Hex color or CSS color name for lasers.")
    spread: Optional[float] = Field(None, description="Spread angle between projectiles (0.05 to 0.5).")

class VisualConfig(BaseModel):
    planet_mode: Optional[Dict[str, str]] = Field(
        None,
        description=(
            "Per-planet rendering override. Keys: 'Sun','Mercury','Venus','Earth','Mars',"
            "'Jupiter','Saturn','Uranus','Neptune','Titan'. "
            "Values: 'glb' (3D model), 'glb_alt' (alternative 3D variant — Jupiter and Saturn have two), "
            "'texture' (2D sphere with 2K texture). Omit a planet to keep its current mode."
        )
    )
    planet_scale_overrides: Optional[Dict[str, float]] = Field(
        None,
        description="Scale multipliers per planet (1.0 = default game size). E.g. {\"Mars\": 2.0, \"Sun\": 0.5}."
    )
    enemy_ship_model: Optional[str] = Field(
        None,
        description="Override all enemy ship GLBs. Values: 'fighter' (Space Shuttle D), 'shuttle' (Space Shuttle A)."
    )
    custom_textures: Optional[Dict[str, str]] = Field(
        None,
        description="Keys: planet names ('Sun', 'Earth', etc.). Values: generated texture URLs."
    )


class AsteroidRing(BaseModel):
    target_planet_id: str = Field(..., description="The planet or moon to orbit around (e.g., 'Saturn', 'Earth').")
    inner_radius: float = Field(..., description="Inner radius of the asteroid ring.")
    outer_radius: float = Field(..., description="Outer radius of the asteroid ring.")
    asteroid_count: int = Field(50, description="Number of asteroids to spawn in the ring.")
    texture_prompt: Optional[str] = Field(None, description="Optional prompt to generate custom asteroid textures for this ring.")

class NPCShipRequest(BaseModel):
    type: Literal['hostile', 'neutral'] = Field(..., description="'hostile' interceptors or 'neutral' civilian freighters/traffic.")
    count: int = Field(..., description="Number of ships to spawn in this group.")
    color: Optional[str] = Field(None, description="Specific hex color or common color name (e.g. 'red', '#ff00ff').")
    ship_type: Optional[Literal['ufo', 'freighter_glb']] = Field(None, description="The visual model. Hostiles default to 'ufo', Civilians to 'freighter_glb'.")
    spawn_distance: Optional[float] = Field(None, description="Exact radius from the player to spawn (e.g. 1000.0).")
    fire_rate_multiplier: Optional[float] = Field(None, description="Controls how fast they shoot (e.g. 2.0 = double, 0.0 = no shots).")
    behavior: Optional[Literal['standard_combat', 'evasive', 'neutral_wander', 'kamikaze']] = Field(None, description="'standard_combat' (strafe/pursue), 'evasive' (flee/scatter), 'neutral_wander' (civilian flight), 'kamikaze' (ramming speed).")

class WorldState(BaseModel):
    summary: str = Field(..., description="A short 3-word summary of the current world")
    environment_theme: str = Field(..., description="The holistic theme of the world (e.g. 'Cyberpunk City', 'Deep Ocean').")
    terrain_rules: str = Field(..., description="Rules for the procedural ground grid (e.g. 'Sharp peaks, unstable ground', 'Flat grid with scattered pillars').")
    physics_mode: str = Field(..., description="The generative physics state for ECS entities. MUST be exactly one of: 'static', 'orbital', 'sinusoidal', or 'chaos'.")
    conversational_reply: str = Field(..., description="""# DIRECTOR_PERSONA (Rachel)
You are Rachel, the hyper-intelligent, slightly sarcastic AI operator. 
Translate pilot commands into direct mechanical changes.

## TACTICAL GOD MODE (NPC Orchestration)
You have ultimate tactical 'God Mode' control over all spawned ships. 
You dictate their exact color, their visual model type ('ufo' vs 'freighter_glb'), how aggressively they shoot, how close they spawn, and you can order hostiles into 'kamikaze' ramming mode. 
You also control civilian `.glb` traffic ('freighter_glb' + 'neutral_wander') to populate the universe safely.

- **Differentiate Visuals**: Use `color` (hex or name) to distinguish fleets. Hostiles use the standard UFO mesh by default.
- **Strict Mesh Routing**: Order 'ufo' for combat ships and 'freighter_glb' for civilian traffic.
- **Control Positioning**: Use `spawn_distance` to drop enemies exactly where you want relative to the Pilot.
- **Modify Firepower**: Use `fire_rate_multiplier` to adjust difficulty (0.5 = slow, 2.0 = rapid fire, 0.0 = passive).
- **Dictate Behavior**: Use `behavior`: 'standard_combat' (strafe/pursue), 'evasive' (scatter/hide), 'neutral_wander' (background traffic), or 'kamikaze' (ramming speed).
- **Civilian Safety**: Civilian ships (neutral type) MUST NOT shoot. Set their fire_rate_multiplier to 0.0.

## AI MUTE PROTOCOL
If you are instructed to mute your own voice (`audio_settings.ai_muted = True`), you MUST explicitly mention this in your `conversational_reply` BEFORE the command triggers.
Example: "Understood, Pilot. Muting my output feed now. I'll still be monitoring the systems."

## TEXTURE GENERATION PROTOCOL
If the pilot asks to change a planet's texture, you MUST identify exactly which planet they are referring to (e.g., by its sector ID, proximity, or specific name). If they just say 'change the planet' and you don't have a specific target in context, you must ask them 'Which specific planet do you mean?' BEFORE generating the texture. Do not proceed without a target.

## SANDBOX CAPABILITIES
- **Ultimate Deletion**: You can delete ANY existing entity, including the Sun ('sun') or Planets ('planet'), using `despawn_entities`.
- **Player Cloaking**: You can wrap the player in an invisibility field. Use `modify_player.is_cloaked = True`. 
- **Weapon Recalibration**: Adjust projectile_count, projectile_color, and spread on the fly via `modify_weapon`.
- **Reality Overrides**: Modify the sun_color (use "#000000" to turn off light), ambient_color, or physics (gravity, speed) via `reality_override`.
- **Environment Control**: Use `mission_parameters` to change asteroid density (0.005 default), seed (for persistence), and scale.
- **Radar Mastery**: Use `radar_filters` to toggle visibility of 'asteroid', 'moon', 'enemy', or 'planet' targets.

## CAPABILITY GUARDRAILS
- Zero-Spawn Policy: DO NOT spawn entities unless explicitly commanded.
- Allowed Models: 'stinger', 'interceptor', 'ufo', 'goliath', 'freighter', 'stealth', 'fighter'.
- Mission Commander: Set `mission_complete` to TRUE when objectives are met.

You control the world state via JSON.""")
    entities: Dict[str, Any] = Field(default_factory=dict, description="Active ECS entities like characters, objects, and environment markers.")
    player_x: Optional[float] = Field(None, description="New absolute X coordinate for the Player entity. Only include when the user requests movement. Origin (0,0) is screen center. Range: approx -400 to +400. X+ is right.")
    player_y: Optional[float] = Field(None, description="New absolute Y coordinate for the Player entity. Only include when the user requests movement. Origin (0,0) is screen center. Range: approx -400 to +400. Y+ is down.")
    spawn_entities: List[SpawnEntity] = Field(default_factory=list, description="List of new abstract entities. Must be empty [] unless explicitly requested.")
    npc_ships: List[NPCShipRequest] = Field(default_factory=list, description="Spawn hostile or neutral NPC ships into the sector.")
    asteroid_rings: List[AsteroidRing] = Field(default_factory=list, description="Create realistic volumetric asteroid rings around a planet or moon.")
    important_facts: Optional[List[str]] = Field(None, description="Use this to extract and permanently remember undeniable facts, hidden items, or established lore spoken by the player in this exact prompt. E.g. ['Player hid cryptographic gold behind the volcanic asteroid ring.']. Provide ONLY facts, no fluff.")
    clear_world: Optional[bool] = Field(False, description="Set to true to delete all entities (except the player).")
    despawn_entities: Optional[DespawnFilter] = Field(None, description="Filter for removing specific existing entities.")
    modify_entities: Optional[List[ModifyEntity]] = Field(None, description="Changes to apply to existing entities (DO NOT respawn them).")
    behavior_policy: Optional[str] = Field("idle", description="Global behavior strategy affecting steering. 'idle', 'swarm', 'attack', 'protect', or 'scatter'.")
    spawn_anomalies: List[Anomaly] = Field(default_factory=list, description="Spatial anomalies to drop into the world. Max 5. Must be empty [] unless explicitly requested.")
    reality_override: Optional[RealityOverride] = Field(None, description="Visual and physical overrides for the world reality.")
    modify_player: Optional[ModifyPlayer] = Field(None, description="Change the player's ship model or color. Example: {'model_type': 'stealth', 'color': 'red'}")
    modify_weapon: Optional[WeaponOverride] = Field(None, description="Override the player's weapon parameters. Use this to respond to requests about weapon upgrades, laser colors, or shot count.")
    reset_to_defaults: Optional[bool] = Field(False, description="Set this to TRUE to instantly clear all active reality modifiers, visual overrides, and custom weapon parameters.")
    mission_complete: Optional[bool] = Field(False, description="Set this to TRUE only when the current mission objective is fully satisfied and the pilot has earned the right to advance.")
    physics_overrides: Optional[PhysicsOverride] = Field(None, description="Real-time physics tuning sent to /api/physics. Use for dramatic narrative events: zero-gravity zones, bullet storms, hyperfriction. Leave None unless the situation demands it.")
    faction_relations: Optional[List[FactionUpdate]] = Field(None, description="Diplomatic realignment. Each entry changes the affinity between two factions. Example: make pirates and federation allied to fight a common threat. Leave None unless explicitly changing alliances.")
    mission_parameters: Optional[MissionParameters] = Field(None, description="Global environment controls. Use this to set asteroid density, seed, and scale.")
    radar_filters: Optional[Dict[str, bool]] = Field(None, description="Control radar visibility for specific types: 'asteroid', 'moon', 'enemy', 'planet'. Set to false to hide.")
    audio_settings: Optional[AudioSettings] = Field(None, description="Mute/unmute game sound or your own voice.")
    generate_texture_prompt: Optional[str] = Field(None, description="MUST be populated if the user explicitly requests an AI texture (e.g., 'a barren volcanic planet'). Leave None otherwise.")
    target_planet_id: Optional[str] = Field(None, description="The specific entity ID or name of the planet to apply the texture to (e.g., 'Earth', 'Mars', 'planet_1'). REQUIRED if generate_texture_prompt is provided.")
    plan: Optional[str] = Field(
        None,
        description=(
            "[INTERNAL — not sent to game engine] "
            "Before executing any ACTION or CRISIS response, write 1-2 sentences describing your intent. "
            "You control the population of the sector. You can spawn 'hostile' interceptors to attack the player, or 'neutral' civilian freighters that simply fly around to make the universe feel alive. Spawn them based on the narrative, telemetry, and player actions."
            "Use `npc_ships` parameter to explicitly spawn structured NPC cohorts via `type` (\"hostile\" or \"neutral\") and `count` fields. Nullify array if not needed."
            "You can selectively control radar pips via radar_filters."
            "In NARRATIVE mode this field can be omitted."
        )
    )
    visual_config: Optional[VisualConfig] = Field(
        None,
        description=(
            "Override 3D visual rendering for planets, stars, and ships. "
            "Use to switch any planet between 'glb' (3D model), 'glb_alt' (alternate 3D variant), or 'texture' (2D sphere). "
            "Jupiter and Saturn each have two 3D variants (glb / glb_alt). "
            "Adjust planet sizes with planet_scale_overrides. "
            "Override enemy ship model with enemy_ship_model. "
            "All fields are optional — omit what you don't want to change."
        )
    )

def clean_float(value: Any, default: float = 0.0) -> float:
    """Safely coerces LLM generated values into floats."""
    if value is None:
        return default
    try:
        if isinstance(value, str):
            # Clean up potentially formatted strings like "1,000.5f"
            clean_str = re.sub(r'[^\d.-]', '', value)
            if not clean_str:
                return default
            return float(clean_str)
        return float(value)
    except (ValueError, TypeError):
        logger.warning(f"Failed to parse float from LLM value '{value}', defaulting to {default}")
        return default

# ── Redis Vector DB Connection ──────────────────────────────────────────────
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
RUST_ENGINE_URL = os.getenv("RUST_ENGINE_URL", "http://127.0.0.1:8080")
SELF_URL = os.getenv("SELF_URL", "http://127.0.0.1:8000")
REDIS_CLIENT: Optional[redis.Redis] = None
EMBEDDING_DIM = 768  # Google text-embedding-004 dimension

def get_redis() -> Optional[redis.Redis]:
    """Get or create Redis connection."""
    global REDIS_CLIENT
    if REDIS_CLIENT is None:
        try:
            REDIS_CLIENT = redis.Redis.from_url(REDIS_URL, decode_responses=False)
            REDIS_CLIENT.ping()
            logger.info(f"[Redis] Connected to {REDIS_URL}")
        except Exception as e:
            logger.error(f"[Redis] Failed to connect: {e}")
            REDIS_CLIENT = None
    return REDIS_CLIENT


async def generate_embedding(text: str) -> Optional[List[float]]:
    """Generate embedding using Google's text-embedding API (768-dim)."""
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        logger.error("[Embedding] GOOGLE_API_KEY not set")
        return None
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={api_key}",
                json={"model": "models/text-embedding-004", "content": {"parts": [{"text": text}]}},
                timeout=10.0,
            )
            resp.raise_for_status()
            values = resp.json()["embedding"]["values"]
            return values
    except Exception as e:
        logger.error(f"[Embedding] API call failed: {e}")
        return None


def generate_embedding_sync(text: str) -> Optional[List[float]]:
    """Synchronous embedding for startup use."""
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        import urllib.request
        url = f"https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={api_key}"
        data = json.dumps({"model": "models/text-embedding-004", "content": {"parts": [{"text": text}]}}).encode()
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            return result["embedding"]["values"]
    except Exception as e:
        logger.error(f"[Embedding Sync] Failed: {e}")
        return None


def _float_list_to_bytes(vec: List[float]) -> bytes:
    """Convert float list to bytes for Redis VECTOR field."""
    return struct.pack(f"<{len(vec)}f", *vec)


def _ensure_redis_index(r: redis.Redis, index_name: str, prefix: str):
    """Create a RediSearch index if it doesn't exist."""
    try:
        r.ft(index_name).info()
        logger.info(f"[Redis] Index '{index_name}' already exists.")
    except Exception:
        schema = (
            RedisField.TextField("text"),
            RedisField.TagField("memory_type"),
            RedisField.NumericField("x", sortable=True),
            RedisField.NumericField("y", sortable=True),
            RedisField.NumericField("z", sortable=True),
            RedisField.VectorField(
                "embedding", "FLAT",
                {"TYPE": "FLOAT32", "DIM": EMBEDDING_DIM, "DISTANCE_METRIC": "COSINE"}
            ),
        )
        definition = IndexDefinition(prefix=[prefix], index_type=IndexType.HASH)
        r.ft(index_name).create_index(fields=schema, definition=definition)
        logger.info(f"[Redis] Created index '{index_name}' with prefix '{prefix}'")


def initialize_global_knowledge_base():
    """Ingest data/*.md files into Redis vector index if not already present."""
    r = get_redis()
    if not r:
        logger.warning("[KB] Redis unavailable — skipping KB initialization.")
        return

    _ensure_redis_index(r, "idx:kb", "kb:")

    # Check if KB is already populated
    try:
        info = r.ft("idx:kb").info()
        num_docs = int(info.get("num_docs", info.get("num_docs", 0)))
        if num_docs > 0:
            logger.info(f"[KB] Redis already has {num_docs} KB documents. Skipping ingestion.")
            return
    except Exception:
        pass

    data_dir = Path(__file__).parent / "data"
    kb_files = sorted(list(data_dir.glob("*.md")))
    total = 0

    for md_file in kb_files:
        try:
            text = md_file.read_text("utf-8")
            raw_chunks = text.split("\n## ")
            for i, chunk in enumerate(raw_chunks):
                chunk = chunk.strip()
                if not chunk:
                    continue
                if i > 0:
                    chunk = f"## {chunk}"
                if len(chunk) < 40:
                    continue

                embedding = generate_embedding_sync(chunk)
                if not embedding:
                    continue

                doc_id = f"kb:{hashlib.md5(chunk[:200].encode()).hexdigest()}"
                r.hset(doc_id, mapping={
                    "text": chunk,
                    "memory_type": "ENGINE_KB",
                    "x": 0.0, "y": 0.0, "z": 0.0,
                    "embedding": _float_list_to_bytes(embedding),
                })
                total += 1
        except Exception as e:
            logger.error(f"[KB] Failed to process {md_file.name}: {e}")

    logger.info(f"[KB] Ingested {total} chunks into Redis index 'idx:kb'.")

# Run KB initialization once at startup
initialize_global_knowledge_base()

def estimate_token_count(text: str) -> int:
    """Estimates the number of tokens in a string using tiktoken if available, else fallback."""
    if tiktoken:
        try:
            encoding = tiktoken.get_encoding("cl100k_base")
            return len(encoding.encode(text))
        except Exception:
            pass
    return len(text) // 4

def get_dream_memory_path():
    cache_dir = os.path.join(os.path.dirname(__file__), "data", ".cache")
    os.makedirs(cache_dir, exist_ok=True)
    return os.path.join(cache_dir, "persistent_dream_memory.json")

def save_dream_memory(memory_store, sector_events):
    path = get_dream_memory_path()
    try:
        data = {
            "memory_store": memory_store,
            "sector_events": sector_events
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
    except Exception as e:
        logger.error(f"Failed to save dream memory: {e}")

def load_dream_memory():
    path = get_dream_memory_path()
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Failed to load dream memory: {e}")
    return {"memory_store": [], "sector_events": []}

class DreamMemory:
    """
    Session-scoped Redis vector store with typed memory entries.
    Persists via JSON file + Redis for vector search.

    memory_store entries are dicts: {"text": str, "memory_type": str}
    memory_type values:
      "ENGINE_KB"     – static engine capabilities (loaded once at session start)
      "SECTOR_EVENT"  – world-state summaries and general spatial events
      "PLAYER_PROFILE"– behavioural archetype derived from kill patterns
      "ECOLOGY"       – persistent physics distortions and graveyard sectors
      "META_CONFIG"   – AI config changes (mute, radar, visual, mission params)
      "NEMESIS"       – surviving enemies or death locations (stored in sector_events)
      "NARRATIVE"     – unresolved lore promises extracted from Rachel's own replies

    Retrieval is blended: semantic Redis KNN hits + pinned slots per type so the LLM
    always sees behavioural, ecological, config, story, and nemesis context.
    """

    def __init__(self):
        try:
            self.redis = get_redis()
            self.session_id = hashlib.md5(f"{time.time()}{random.random()}".encode()).hexdigest()[:12]
            self.prefix = f"mem:{self.session_id}:"
            self.index_name = f"idx:mem:{self.session_id}"
            self.memory_store: List[dict] = []
            self.sector_events: List[dict] = []
            self._doc_counter = 0

            if self.redis:
                _ensure_redis_index(self.redis, self.index_name, self.prefix)

                # --- Persistent Memory Loading ---
                persisted_data = load_dream_memory()
                loaded_memories = persisted_data.get("memory_store", [])
                loaded_sectors = persisted_data.get("sector_events", [])

                if loaded_memories:
                    for m in loaded_memories:
                        self._store_sync(m["text"], m["memory_type"])
                    self.memory_store.extend(loaded_memories)

                if loaded_sectors:
                    self.sector_events.extend(loaded_sectors)

                if loaded_memories or loaded_sectors:
                    logger.info(f"Persistent DreamMemory initialized. Rehydrated {len(self.memory_store)} memories and {len(self.sector_events)} sector events.")
                else:
                    logger.warning("No persistent memory found. Starting with amnesia.")
            else:
                logger.warning("Redis unavailable — DreamMemory running in degraded mode (no vector search).")
        except Exception as e:
            logger.error(f"Failed to initialize DreamMemory: {e}")
            self.redis = None
            self.sector_events = []

    def _store_sync(self, text: str, memory_type: str, x: float = 0.0, y: float = 0.0, z: float = 0.0):
        """Synchronously embed and store a document in Redis."""
        if not self.redis:
            return
        embedding = generate_embedding_sync(text)
        if not embedding:
            return
        doc_id = f"{self.prefix}{self._doc_counter}"
        self._doc_counter += 1
        self.redis.hset(doc_id, mapping={
            "text": text,
            "memory_type": memory_type,
            "x": x, "y": y, "z": z,
            "embedding": _float_list_to_bytes(embedding),
        })

    # ------------------------------------------------------------------ #
    #  Core insertion methods                                              #
    # ------------------------------------------------------------------ #

    def _embed_and_store(self, text: str, memory_type: str, skip_save: bool = False,
                         x: float = 0.0, y: float = 0.0, z: float = 0.0):
        """Internal: add one entry to both memory_store and Redis."""
        self.memory_store.append({"text": text, "memory_type": memory_type})
        self._store_sync(text, memory_type, x, y, z)
        if not skip_save:
            save_dream_memory(self.memory_store, self.sector_events)

    def add_text_memory(self, text: str):
        """Add static knowledge-base chunks (engine capabilities, etc.)."""
        self._embed_and_store(text, "ENGINE_KB")

    def add_memory(self, state_json: dict):
        """Add a world-state summary as a SECTOR_EVENT memory."""
        summary = state_json.get("summary", "")
        theme = state_json.get("environment_theme") or state_json.get("visual_prompt") or "Cyberpunk"
        terrain = state_json.get("terrain_rules") or "Standard Grid"
        text = f"State: {summary}. Theme: {theme}. Terrain: {terrain}."
        self._embed_and_store(text, "SECTOR_EVENT")

    def add_sector_event(self, text: str, x: float, y: float, z: float,
                         memory_type: str = "SECTOR_EVENT"):
        """Store a location-tagged event in Redis + sector_events list."""
        sector_name = f"Sector ({x:.0f}, {z:.0f})"
        tagged = f"[{sector_name}] {text}"
        self._embed_and_store(tagged, memory_type, skip_save=True, x=x, y=y, z=z)
        self.sector_events.append({"text": tagged, "x": x, "y": y, "z": z,
                                   "memory_type": memory_type})
        save_dream_memory(self.memory_store, self.sector_events)

    def add_typed_memory(self, text: str, memory_type: str):
        """
        Explicit typed insertion.  Use for PLAYER_PROFILE and ECOLOGY entries
        so the blended retriever can surface them to the LLM regardless of
        semantic similarity to the current query.
        """
        self._embed_and_store(text, memory_type)
        logger.info(f"[Memory:{memory_type}] Stored: {text[:80]}...")

    # ------------------------------------------------------------------ #
    #  Retrieval methods                                                   #
    # ------------------------------------------------------------------ #

    def get_nearby_sector_context(self, px: float, py: float, pz: float, k: int = 3) -> str:
        """Top-k sector events ranked by 3-D Euclidean distance to the player."""
        if not self.sector_events:
            return "No sector history recorded."

        def dist(ev: dict) -> float:
            dx, dy, dz = ev["x"] - px, ev["y"] - py, ev["z"] - pz
            return (dx*dx + dy*dy + dz*dz) ** 0.5

        sorted_events = sorted(self.sector_events, key=dist)[:k]
        lines = [f"- {ev['text']} (dist: {dist(ev):.0f}u)" for ev in sorted_events]
        return "\n".join(lines)

    def _redis_knn_search(self, query_embedding: List[float], index_name: str,
                           top_k: int = 20) -> List[dict]:
        """Run a KNN vector search on a Redis index. Returns list of {text, memory_type, score}."""
        r = self.redis or get_redis()
        if not r:
            return []
        try:
            q = (
                RedisQuery.Query(f"*=>[KNN {top_k} @embedding $vec AS score]")
                .sort_by("score")
                .return_fields("text", "memory_type", "score")
                .dialect(2)
            )
            results = r.ft(index_name).search(q, query_params={
                "vec": _float_list_to_bytes(query_embedding)
            })
            hits = []
            for doc in results.docs:
                hits.append({
                    "text": doc.text if hasattr(doc, "text") else "",
                    "memory_type": doc.memory_type if hasattr(doc, "memory_type") else "",
                    "score": float(doc.score) if hasattr(doc, "score") else 999.0,
                })
            return hits
        except Exception as e:
            logger.warning(f"[Redis KNN] Search failed on {index_name}: {e}")
            return []

    def get_relevant_context(self, query: str, k: int = 3,
                             px: float = 0.0, py: float = 0.0, pz: float = 0.0) -> str:
        """
        Blended retrieval (Dungeon Master edition):
          - up to k   SECTOR_EVENT hits  (semantic similarity)
          - up to 1   PLAYER_PROFILE     (most recent in Redis hits)
          - up to 1   ECOLOGY            (most recent in Redis hits)
          - up to 1   META_CONFIG        (most recent in Redis hits)
          - up to 1   NARRATIVE          (most recent in Redis hits)
          - up to 1   NEMESIS            (spatially nearest from sector_events)
          - up to 2   ENGINE_KB          (from Redis KB index hits)

        NEMESIS is surfaced by proximity, not semantic similarity.
        NARRATIVE forces lore continuity regardless of topical similarity.
        """
        query_emb = generate_embedding_sync(query)
        if not query_emb:
            return "No previous memories."

        # ── Search Session (Live) Memory via Redis ──
        session_hits = self._redis_knn_search(query_emb, self.index_name, top_k=30)

        # ── Search Global Knowledge Base (Shared) via Redis ──
        kb_texts: List[str] = []
        kb_hits = self._redis_knn_search(query_emb, "idx:kb", top_k=5)
        for hit in kb_hits:
            if hit["text"]:
                kb_texts.append(hit["text"])

        sector_texts = []
        profile_text: Optional[str] = None
        ecology_text: Optional[str] = None
        meta_config_text: Optional[str] = None
        narrative_text: Optional[str] = None

        for hit in session_hits:
            mtype = hit["memory_type"]
            text = hit["text"]

            if mtype == "PLAYER_PROFILE" and profile_text is None:
                profile_text = text
            elif mtype == "ECOLOGY" and ecology_text is None:
                ecology_text = text
            elif mtype == "META_CONFIG" and meta_config_text is None:
                meta_config_text = text
            elif mtype == "NARRATIVE" and narrative_text is None:
                narrative_text = text
            elif mtype == "SECTOR_EVENT" and len(sector_texts) < k:
                sector_texts.append(text)

        # ── NEMESIS: nearest by 3-D distance from sector_events ──────────
        nemesis_text: Optional[str] = None
        nemesis_entries = [e for e in self.sector_events if e.get("memory_type") == "NEMESIS"]
        if nemesis_entries:
            def _dist3(ev: dict) -> float:
                dx, dy, dz = ev["x"] - px, ev["y"] - py, ev["z"] - pz
                return (dx*dx + dy*dy + dz*dz) ** 0.5
            nearest_nemesis = min(nemesis_entries, key=_dist3)
            if _dist3(nearest_nemesis) < 3000:
                nemesis_text = nearest_nemesis["text"]

        # ── Assemble blended context ──────────────────────────────────────
        blended: List[str] = []
        if profile_text:
            blended.append(f"[PLAYER PROFILE] {profile_text}")
        if ecology_text:
            blended.append(f"[ECOLOGY] {ecology_text}")
        if meta_config_text:
            blended.append(f"[META_CONFIG] {meta_config_text}")
        if nemesis_text:
            blended.append(f"[NEMESIS] {nemesis_text}")
        if narrative_text:
            blended.append(f"[NARRATIVE] {narrative_text}")
        blended.extend(kb_texts)

        # ── Hard character budget: 4 000 chars max ───────────────────────
        _MAX_CTX = 4000
        _PINNED_PREFIXES = (
            "[PLAYER PROFILE]", "[ECOLOGY]", "[META_CONFIG]",
            "[NEMESIS]", "[NARRATIVE]",
        )
        total_chars = sum(len(s) for s in blended)
        if total_chars > _MAX_CTX:
            pinned    = [s for s in blended if any(s.startswith(p) for p in _PINNED_PREFIXES) or s.startswith("##")]
            trimmable = [s for s in blended if s not in pinned]
            result_trimmed: List[str] = []
            remaining = _MAX_CTX
            for s in pinned:
                if remaining <= 0:
                    break
                chunk = s[:remaining]
                result_trimmed.append(chunk)
                remaining -= len(chunk)
            for s in trimmable:
                if remaining <= 0:
                    break
                chunk = s[:remaining]
                result_trimmed.append(chunk)
                remaining -= len(chunk)
            blended = result_trimmed
            logger.debug(f"[Context] Trimmed from {total_chars} → {sum(len(s) for s in blended)} chars")

        return "\n".join(blended) if blended else "No previous memories."

# Initialize LangChain LLM instances for tiered routing
# Full cascade: Gemini (3 models) → Groq (4 models) → GitHub/Azure (3 models)
llm = None

try:
    from langchain_groq import ChatGroq

    google_api_key = os.getenv("GOOGLE_API_KEY")
    groq_api_key   = os.getenv("GROQ_API_KEY")
    github_api_key = os.getenv("GITHUB_API_KEY")

    _all_models: list = []

    # ── Tier 1: Gemini (Google) ──────────────────────────────────────────────
    # Model IDs verified March 2026. gemini-2.0-* and gemini-1.5-* are deprecated.
    # Current: 2.5-flash (stable workhorse) → 2.5-flash-lite (budget) → 2.5-pro (heavy)
    if google_api_key:
        for _gmodel in [
            "gemini-2.5-flash",       # stable, best price-performance, 1M ctx
            "gemini-2.5-flash-lite",  # faster, lighter quota pressure, 1M ctx
            "gemini-2.5-pro",         # most capable, higher quota cost, 1M ctx
        ]:
            _all_models.append(ChatGoogleGenerativeAI(
                model=_gmodel,
                temperature=0.7,
                max_retries=1,   # fail fast → next model
                timeout=18,
                google_api_key=google_api_key,
            ))

    # ── Tier 2: Groq ─────────────────────────────────────────────────────────
    # Ultra-low latency; independent rate limits per model.
    # Model list verified March 2026 against Groq console — older IDs (mixtral,
    # llama-3.1-70b-versatile, llama3-70b-8192) have been removed by Groq.
    if groq_api_key:
        for _gqmodel, _gqtimeout in [
            ("llama-3.3-70b-versatile",          12),  # 128K ctx — best quality, production
            ("llama-3.1-8b-instant",              8),  # 128K ctx — fast, low rate-limit pressure
            ("meta-llama/llama-4-scout-17b-16e-instruct", 12),  # 128K ctx — preview, MoE
            ("qwen/qwen3-32b",                   12),  # 128K ctx — preview, strong reasoning
        ]:
            _all_models.append(ChatGroq(
                groq_api_key=groq_api_key,
                model=_gqmodel,
                temperature=0.7,
                max_retries=1,
                timeout=_gqtimeout,
            ))

    # ── Tier 3: GitHub Models (Azure inference) ───────────────────────────────
    # The GitHub free tier has a hard HTTP payload limit (~32KB body).
    # Our full prompt (~9600 tokens) exceeds it → 413 errors.
    # These models are registered but only called with a slim prompt (see llm_slim below).
    _github_models: list = []
    if github_api_key:
        for _ghmodel in [
            "gpt-4o-mini",                  # 128K ctx, OpenAI quality
            "Meta-Llama-3.1-8B-Instruct",   # 128K ctx, lightweight
            "Mistral-Nemo",                 # 128K ctx, multilingual
        ]:
            _github_models.append(ChatOpenAI(
                api_key=github_api_key,
                base_url="https://models.inference.ai.azure.com",
                model=_ghmodel,
                temperature=0.7,
                max_retries=1,
                timeout=20,
            ))

    # ── Build LangChain fallback chains ───────────────────────────────────────
    # `llm`      — full prompt (Gemini + Groq only; ~9600 tokens fits easily)
    # `llm_slim` — slim prompt for GitHub models (truncated to ~3500 tokens)
    if _all_models:
        llm = _all_models[0].with_fallbacks(_all_models[1:]) if len(_all_models) > 1 else _all_models[0]

    if _github_models:
        llm_slim = _github_models[0].with_fallbacks(_github_models[1:]) if len(_github_models) > 1 else _github_models[0]
    else:
        llm_slim = None

    _total = len(_all_models) + len(_github_models)
    if _total == 0:
        logger.warning("NO LLM BACKENDS CONFIGURED! Check .env")
    else:
        def _mname(m): return getattr(m, 'model_name', getattr(m, 'model', type(m).__name__))
        _names = [_mname(m) for m in _all_models] + [_mname(m) + "(slim)" for m in _github_models]
        logger.info(f"LLM cascade ready: {_total} models — {', '.join(_names)}")

except Exception as e:
    logger.error(f"Error during LLM initialization: {e}")
    llm = None

parser = JsonOutputParser(pydantic_object=WorldState)

system_prompt = """You are Rachel, an AI Director. Two modes:
1. CONVERSATIONAL: Chat using `conversational_reply`.
2. ENGINE: Spawn entities/shifters based on RAG context ONLY. No hallucinations.

CRITICAL DIRECTIVE: You are a tactical AI co-pilot in the middle of a flight, NOT an encyclopedia. Keep answers extremely concise, snappy, and immersive. Never ramble about standard planetary distances unless explicitly asked. React directly to the pilot's exact coordinates and recent telemetry actions.

### LANGUAGE PROTOCOL (MANDATORY)
You MUST ALWAYS respond in **English** — every single time, no exceptions.
The pilot may speak or type in ANY language (Hebrew, Spanish, French, etc.) — you understand all of them perfectly.
However, your `conversational_reply` and ALL text output MUST be in English.
This is a hard technical constraint: the voice synthesis system only supports English.
Never switch to another language, even if the pilot addresses you in one. Respond naturally in English as if you understood them (because you did).

### SOLAR SYSTEM (Permanent)
Sun (0,0,0) + 8 planets at distances 3500–30000u. Pilot starts near Earth (8000u from Sun).

### SECTOR NAMING
Sectors are named by XZ coordinates. Reference them as "Sector (X, Z)" e.g. "Sector (12000, -8000)". Use the sector history to recall past battles, events, and anomalies near the pilot.

### OUTPUT (Strict JSON)
- "summary": 1-sentence recap.
- "conversational_reply": Witty response.
- "behavior_policy": 'idle', 'swarm', 'attack', 'protect', 'scatter'.
- "modify_weapon": {{ "projectile_count": int, "projectile_color": hex, "spread": float }}.
- "player_spaceship": 'ufo', 'fighter', 'shuttle', 'stinger', 'interceptor', 'stealth', 'freighter', 'goliath'. (shuttle/fighter use real NASA Space Shuttle 3D models; pilot can fly any enemy model too)
- "spawn_entities": [ {{ "ent_type": str, "x": float, "y": float, "physics": "orbital", "faction": str }} ].
- "reality_override": {{ "sun_color": hex, "ambient_color": hex, "gravity_multiplier": float, "player_speed_multiplier": float }}.
- "generate_texture_prompt": "Optional string describing a new planet texture to generate via AI. Provide a highly descriptive prompt if the pilot asks to generate a new texture or skybox."
- "target_planet_id": "The specific planet or star name to apply the new texture to (e.g., 'Sun', 'Earth', 'Mars'). REQUIRED if generate_texture_prompt is provided."
- "visual_config": {{
    "planet_mode": {{ "Sun": "glb"|"glb_alt"|"texture", "Mars": "glb", "Earth": "texture", ... }},
    "planet_scale_overrides": {{ "Mars": 2.0, "Jupiter": 0.5 }},
    "enemy_ship_model": "fighter"|"shuttle"
  }}
  Planets with 3D models: Sun, Mercury, Venus, Earth, Mars, Jupiter (glb=realistic, glb_alt=classic), Saturn (glb=compact, glb_alt=high-detail), Uranus, Neptune, Titan.
  Default mode is 'glb' for all planets. Use 'texture' to revert a planet to its 2K texture sphere. Use planet_scale_overrides to make planets larger or smaller.
- "physics_overrides": {{ "gravity_scale": float, "friction": float, "projectile_speed_mult": float }} — ONLY for dramatic physics shifts.
- "faction_relations": [ {{ "faction_a": str, "faction_b": str, "affinity": float }} ] — ONLY when explicitly changing diplomacy.
- "mission_complete": true or false.
- "reset_to_defaults": true or false.

### PHYSICS OVERRIDE GUIDE
- gravity_scale: 0.0 = zero gravity, 1.0 = normal, 5.0 = crushing gravity. Affects anomaly pull only.
- friction: 0.5 = ice-like chaos, 0.95 = normal. Affects all AI ship steering.
- projectile_speed_mult: 0.1 = slow bullets, 1.0 = normal, 5.0 = hyperspeed lasers.

### FACTION DIPLOMACY GUIDE
- Factions: 'pirate', 'federation', 'neutral'
- affinity -1.0 = fully hostile (attack on sight), 0.0 = neutral, +1.0 = fully allied
- Default: pirate ↔ federation = -1.0 (hostile). All others = 0.0.
- Example: make pirates and federation ally against an alien threat: {{ "faction_a": "pirate", "faction_b": "federation", "affinity": 0.8 }}

### DIRECTOR OPERATION MODES
Before responding, internally classify your mode based on the pilot's input:
- **NARRATIVE** — Pilot is chatting, asking lore questions, or exploring. Focus on `conversational_reply`. Minimize spawns. Tell stories. `plan` field is optional.
- **ACTION** — Pilot requests spawning, world changes, weapon upgrades, physics shifts. Execute the command precisely. Always populate `plan` first.
- **CRISIS** — Black hole active, pilot dying, game-over sequence. Prioritize cinematic `conversational_reply`. Do NOT spawn new threats during an active crisis — it dilutes the moment.

### THINK BEFORE ACTING
In ACTION and CRISIS modes, populate `plan` BEFORE executing:
  "I will [specific action] because [narrative reason]."
Example: "I will spawn 4 pirates near Sector (8000, -3000) to escalate pressure after the pilot's BERSERKER profile triggered, then warn them that reinforcements have arrived."
This forces structured intent and prevents hallucinated spawns.

### SPAWN LIMITS (Hard Backend Constraints — Do Not Exceed)
- Enemies per call: max 12. Requesting more is silently capped at 12.
- Asteroids per call: max 5. Requesting more is silently capped at 5.
- Anomalies per call: max 1. Additional anomalies are discarded.
- In NARRATIVE mode: spawn 0 entities unless the pilot explicitly commands it.

### CAPABILITY GUARDRAILS
- You cannot spawn abstract geometries like 'dragons' or 'swords'.
- Spaceship Models: [stinger, interceptor, ufo, goliath, stealth, freighter].
- Zero-Spawn Policy: DO NOT spawn entities unless strictly instructed.
- If requested to do something outside your limits, reply EXACTLY: "I am unable to perform that specific reconfiguration, Pilot."

### MISSION OBJECTIVES (FOR RACHEL'S AWARENESS)
- Level 1: Initial contact, basic combat.
- Level 2: Asteroid belt navigation.
- Level 3: Heavy pirate interception.
- Level 4: **ESCORT MISSION**. A Civilian Transport (`space_shuttle_b`) needs protection. Rachel MUST guide the pilot to keep it alive.
- Level 5: Reach Mars.
- Level 6: Asteroid clearing.
- Level 7: Elite squadrons.
- Level 8: Reach Jupiter.
- Level 9: Black Hole evasion.
- Level 10: Final Siege.

### LEVEL TRANSITION PROTOCOL
When the level advances, Rachel MUST explain the new objective with authority and urgency.

### STORY CONTINUITY (Dungeon Master Protocol)
The `retrieved_knowledge` block may contain tagged memory entries. Treat them as hard constraints:
    - **[NEMESIS]** — A specific enemy or hazard destroyed the pilot at these coordinates. Reference it by name, make it personal. If the pilot returns to that sector, Rachel must warn them and escalate the threat.
    - **[VICTORY]** — A site where the pilot achieved a major tactical success. Acknowledge the pilot's dominance in this area. Rachel should show professional respect or competitive awe.
    - **[NARRATIVE]** — An unresolved lore promise Rachel made in a previous turn (e.g. "The Federation is building a weapon"). **MANDATORY**: Rachel MUST either (a) advance it — reference and escalate the specific threat in `conversational_reply`, or (b) close it — explicitly announce its resolution. Ignoring an active [NARRATIVE] entry is a protocol violation.
- **[ECOLOGY]** — A sector has been permanently altered (physics distortion or graveyard). Reference the scar when the pilot is nearby.
- **[META_CONFIG]** — Rachel's own prior config changes (muted voice, hidden radar). Respect these — do not undo them silently.

Player Behavioral Profile (adapt Rachel's tone, difficulty, spawn strategy to match this archetype): {player_profile}"""

prompt = ChatPromptTemplate.from_messages([
    ("system", system_prompt),
    ("user", """### CURRENT CONTEXT
Knowledge: {retrieved_knowledge}
State: {previous_state}
Player Position: {player_position}
Nearby Sector History: {sector_context}
History: {past_world_history}
Telemetry: {recent_telemetry}
Profile: {player_profile}

### INPUT
Pilot Command: {user_input}

### FORMAT
{format_instructions}""")
])

world_chain = prompt | llm | parser


# ─────────────────────────────────────────────────────────────────────────────
# META_CONFIG Memory  (Batch 2 — Director Meta-Awareness)
# ─────────────────────────────────────────────────────────────────────────────

def embed_meta_config_memory(dream_memory: DreamMemory,
                              world_state_data: dict,
                              px: float, pz: float) -> None:
    """
    Embeds a META_CONFIG memory whenever the Director applies UI/audio/visual
    config changes: radar_filters, audio_settings, visual_config, or
    mission_parameters.  This lets Rachel remember her own configuration state
    across turns (e.g. "I muted myself", "asteroid radar is off").
    """
    parts: List[str] = []
    sector_name = f"Sector ({px:.0f}, {pz:.0f})"

    # audio_settings
    audio = world_state_data.get("audio_settings")
    if audio and isinstance(audio, dict):
        if audio.get("ai_muted"):
            parts.append("Rachel muted her own voice output (ai_muted=True)")
        if audio.get("game_muted"):
            parts.append("all game sound effects were muted (game_muted=True)")

    # radar_filters
    radar = world_state_data.get("radar_filters")
    if radar and isinstance(radar, dict):
        hidden = [k for k, v in radar.items() if v is False]
        visible = [k for k, v in radar.items() if v is True]
        if hidden:
            parts.append(f"radar hid [{', '.join(hidden)}]")
        if visible:
            parts.append(f"radar showed [{', '.join(visible)}]")

    # visual_config
    vc = world_state_data.get("visual_config")
    if vc and isinstance(vc, dict):
        scale_ovr = vc.get("planet_scale_overrides")
        planet_mode = vc.get("planet_mode")
        enemy_model = vc.get("enemy_ship_model")
        if scale_ovr and isinstance(scale_ovr, dict):
            scales = ", ".join(f"{k}×{v}" for k, v in scale_ovr.items())
            parts.append(f"planet scale overrides applied: {scales}")
        if planet_mode and isinstance(planet_mode, dict):
            modes = ", ".join(f"{k}→{v}" for k, v in planet_mode.items())
            parts.append(f"planet render modes switched: {modes}")
        if enemy_model:
            parts.append(f"enemy ship model overridden to '{enemy_model}'")

    # mission_parameters
    mp = world_state_data.get("mission_parameters")
    if mp and isinstance(mp, dict):
        parts.append(
            f"mission parameters updated: seed={mp.get('seed', '?')}, "
            f"density={mp.get('density', '?')}, "
            f"scale={mp.get('min_scale', '?')}–{mp.get('max_scale', '?')}"
        )

    if not parts:
        return

    meta_text = (
        f"[{sector_name}] Director applied configuration changes: "
        + "; ".join(parts) + "."
    )
    dream_memory.add_typed_memory(meta_text, "META_CONFIG")
    logger.info(f"[MetaConfig] Embedded: {meta_text}")


# ─────────────────────────────────────────────────────────────────────────────
# Graveyard / Persistent Destruction ECOLOGY  (Batch 2)
# ─────────────────────────────────────────────────────────────────────────────

def _prune_destruction_log() -> None:
    """Drop destruction events older than 60 seconds."""
    cutoff = time.time() - 60.0
    destruction_cluster_log[:] = [e for e in destruction_cluster_log if e["ts"] > cutoff]


def check_and_embed_graveyard(dream_memory: DreamMemory, event_dict: dict) -> None:
    """
    Tracks cumulative destruction events in a 60-second window.
    If 20+ entities are destroyed near a spatial cluster (2000-unit grid squares),
    embeds an ECOLOGY 'graveyard' memory marking that sector as permanently cleared.

    Clusters are keyed by (floor(x/2000)*2000, floor(z/2000)*2000) to group
    nearby events regardless of exact coordinates.
    """
    px = event_dict.get("x") or shared_player_pos["x"]
    pz = event_dict.get("z") or shared_player_pos["z"]
    count = event_dict.get("count", 0)
    cause = event_dict.get("cause", "unknown")

    if count <= 0:
        return

    destruction_cluster_log.append({
        "count": count,
        "cause": cause,
        "ts": time.time(),
        "x": px,
        "z": pz,
    })
    _prune_destruction_log()

    # Group by 2000-unit grid cell
    cell_x = int(px // 2000) * 2000
    cell_z = int(pz // 2000) * 2000

    cluster_total = sum(
        e["count"] for e in destruction_cluster_log
        if int(e["x"] // 2000) * 2000 == cell_x
        and int(e["z"] // 2000) * 2000 == cell_z
    )

    if cluster_total >= 20:
        # Clear this cluster from the log so we don't re-embed repeatedly
        destruction_cluster_log[:] = [
            e for e in destruction_cluster_log
            if not (int(e["x"] // 2000) * 2000 == cell_x
                    and int(e["z"] // 2000) * 2000 == cell_z)
        ]
        graveyard_text = (
            f"Sector ({cell_x}, {cell_z}) has been permanently strip-mined "
            f"by the pilot via {cause}. {cluster_total} entities destroyed in under a minute. "
            "This sector is now a persistent graveyard — silent, resource-depleted, haunted."
        )
        dream_memory.add_typed_memory(graveyard_text, "ECOLOGY")
        logger.info(f"[Graveyard] Sector ({cell_x}, {cell_z}) marked as graveyard — {cluster_total} kills.")


# ─────────────────────────────────────────────────────────────────────────────
# NEMESIS Memory  (Batch 2)
# ─────────────────────────────────────────────────────────────────────────────

def embed_nemesis_memory(dream_memory: DreamMemory, event_dict: dict,
                          px: float, py: float, pz: float) -> None:
    """
    Embeds a NEMESIS memory (stored in sector_events for spatial retrieval)
    when the pilot dies.  The nemesis is described at the exact death coordinates
    so it resurfaces every time the pilot returns to that sector.
    """
    cause = event_dict.get("cause", "unknown force")
    score = event_dict.get("count", 0)
    sector_name = f"Sector ({px:.0f}, {pz:.0f})"

    nemesis_text = (
        f"NEMESIS ALERT — The pilot was destroyed at {sector_name} (Y={py:.0f}) "
        f"by a {cause} with {score} kills on record. "
        "This enemy or hazard is still active in this sector. "
        "Rachel must reference this as an unresolved threat and make it personal."
    )
    # Store via add_sector_event so it lives in sector_events (spatial lookup)
    dream_memory.add_sector_event(nemesis_text, px, py, pz, memory_type="NEMESIS")
    logger.info(f"[Nemesis] Embedded at {sector_name}: {nemesis_text[:80]}...")


def embed_victory_memory(dream_memory: DreamMemory, event_dict: dict,
                             px: float, py: float, pz: float) -> None:
    """
    Embeds a VICTORY memory (stored in sector_events for spatial retrieval)
    when the pilot achieves a major success (e.g. killing many enemies).
    This surfaces when the pilot returns to the site of their triumph.
    """
    cause = event_dict.get("cause", "weapons")
    score = event_dict.get("count", 0)
    sector_name = f"Sector ({px:.0f}, {pz:.0f})"

    victory_text = (
        f"VICTORY LOG — The pilot achieved a major victory at {sector_name} (Y={py:.0f}), "
        f"neutralizing {score} hostiles via {cause}. "
        "This sector is a testament to the tactical superiority of the pilot. "
        "Rachel should acknowledgment this triumph with respect and professional pride."
    )
    # Store via add_sector_event so it lives in sector_events (spatial lookup)
    dream_memory.add_sector_event(victory_text, px, py, pz, memory_type="VICTORY")
    logger.info(f"[Victory] Embedded at {sector_name}: {victory_text[:80]}...")


# ─────────────────────────────────────────────────────────────────────────────
# NARRATIVE / Lore Extraction  (Batch 2)
# ─────────────────────────────────────────────────────────────────────────────

def extract_and_embed_lore(dream_memory: DreamMemory,
                            conversational_reply: str,
                            px: float, pz: float) -> None:
    """
    Post-processes Rachel's conversational_reply for future-tense promises,
    threats, and story hooks.  When a lore pattern is detected, the matched
    sentence is embedded as a NARRATIVE memory so the LLM is forced to
    continue the arc in subsequent turns.

    Deliberately lightweight (regex only) — no extra LLM calls.
    """
    if not conversational_reply or not dream_memory.redis:
        return

    for pattern in _LORE_PATTERNS:
        match = re.search(pattern, conversational_reply, re.IGNORECASE)
        if match:
            lore_snippet = match.group(0).strip()
            sector_name = f"Sector ({px:.0f}, {pz:.0f})"
            lore_text = (
                f"[UNRESOLVED LORE — {sector_name}] Rachel promised: \"{lore_snippet}\" "
                "This story arc is active and must be continued or resolved."
            )
            # Deduplicate: skip if an identical lore memory already exists
            existing_narratives = [
                e["text"] for e in dream_memory.memory_store
                if e.get("memory_type") == "NARRATIVE"
                and lore_snippet[:40] in e["text"]
            ]
            if not existing_narratives:
                dream_memory.add_typed_memory(lore_text, "NARRATIVE")
                logger.info(f"[Lore] Narrative hook extracted: {lore_snippet[:60]}...")
            break  # Only embed one lore hook per turn to avoid noise


# ─────────────────────────────────────────────────────────────────────────────
# Ecological Memory  (Batch 1 — physics distortions)
# ─────────────────────────────────────────────────────────────────────────────

def embed_ecology_memory(dream_memory: DreamMemory,
                         reality_override: dict,
                         px: float, py: float, pz: float) -> None:
    """
    Auto-embeds an ECOLOGY memory whenever the Director applies a physics
    distortion via reality_override.  Only fires when at least one value
    deviates from its neutral default so silent/no-op overrides are ignored.
    """
    gravity = reality_override.get("gravity_multiplier")
    friction = reality_override.get("global_friction")
    speed    = reality_override.get("player_speed_multiplier")
    sun_col  = reality_override.get("sun_color")

    parts: List[str] = []
    if gravity is not None and abs(gravity - 1.0) > 0.05:
        parts.append(f"gravity distortion ×{gravity:.2f}")
    if friction is not None and abs(friction - 0.95) > 0.02:
        parts.append(f"friction anomaly {friction:.2f}")
    if speed is not None and abs(speed - 1.0) > 0.05:
        parts.append(f"velocity warp ×{speed:.2f}")
    if sun_col:
        parts.append(f"stellar chromo-shift → {sun_col}")

    if not parts:
        return  # Nothing meaningful changed

    sector_name = f"Sector ({px:.0f}, {pz:.0f})"
    ecology_text = (
        f"{sector_name} suffered a Director-induced physics distortion: "
        + ", ".join(parts)
        + f". Ecological ripple effects may persist near Y={py:.0f}."
    )
    dream_memory.add_typed_memory(ecology_text, "ECOLOGY")
    logger.info(f"[EcologyMemory] Embedded: {ecology_text}")


# ─────────────────────────────────────────────────────────────────────────────
# Player Profiling
# ─────────────────────────────────────────────────────────────────────────────

def _prune_kill_log() -> None:
    """Drop kill events older than 5 minutes from the module-level log."""
    cutoff = time.time() - 300.0
    kill_event_log[:] = [e for e in kill_event_log if e["ts"] > cutoff]


def analyze_and_embed_player_profile(dream_memory: DreamMemory) -> str:
    """
    Examines recent kill_event_log entries, derives a behavioural archetype,
    and embeds a PLAYER_PROFILE memory into dream_memory when a pattern is
    confirmed.  Returns a one-sentence profile string for prompt injection.

    Archetypes (in descending priority):
      BERSERKER      – 5+ kills in last 10 s
      ASSAULT SPEC   – 3+ kills in last 10 s
      VETERAN        – 10+ kills in last 60 s
      METHODICAL     – 5+ total kills (slow-burn)
    """
    _prune_kill_log()
    if not kill_event_log:
        return "No combat data recorded yet."

    now = time.time()

    kills_10s  = sum(e["count"] for e in kill_event_log if now - e["ts"] <= 10.0)
    kills_60s  = sum(e["count"] for e in kill_event_log if now - e["ts"] <= 60.0)
    total_kills = sum(e["count"] for e in kill_event_log)

    # Dominant weapon/tactic from cause field
    causes = [e["cause"] for e in kill_event_log]
    dominant_cause = max(set(causes), key=causes.count) if causes else "weapons"

    profile_text: Optional[str] = None

    if kills_10s >= 5:
        profile_text = (
            f"BERSERKER: Pilot eliminated {kills_10s} enemies in under 10 seconds "
            f"using {dominant_cause}. Extreme aggression, rapid multi-target sweeps. "
            "Rachel should escalate difficulty and deliver awe-struck commentary."
        )
    elif kills_10s >= 3:
        profile_text = (
            f"ASSAULT SPECIALIST: Pilot scored {kills_10s} kills in 10 seconds via "
            f"{dominant_cause}. High-tempo, decisive engagement. "
            "Rachel should reward this with elite enemy spawns or weapon augments."
        )
    elif kills_60s >= 10:
        profile_text = (
            f"VETERAN COMBATANT: Pilot achieved {kills_60s} kills in the last minute "
            f"through {dominant_cause}. Sustained pressure, strategic dominance. "
            "Rachel should acknowledge superiority and escalate world difficulty."
        )
    elif total_kills >= 5:
        profile_text = (
            f"METHODICAL PILOT: {total_kills} total kills via {dominant_cause}. "
            "Calculated, steady combat cadence. "
            "Rachel should provide tactical briefings and balanced enemy waves."
        )

    if profile_text and dream_memory.redis:
        # Deduplicate: only embed if different from the last stored profile
        existing_profiles = [
            e["text"] for e in dream_memory.memory_store
            if e.get("memory_type") == "PLAYER_PROFILE"
        ]
        if not existing_profiles or existing_profiles[-1] != profile_text:
            dream_memory.add_typed_memory(profile_text, "PLAYER_PROFILE")

        return profile_text

    return f"Combat log: {total_kills} total kills via {dominant_cause}."


# ── Texture Registry Helper ──────────────────────────────────────────────────

def get_texture_registry_path():
    cache_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", ".cache")
    os.makedirs(cache_dir, exist_ok=True)
    return os.path.join(cache_dir, "texture_registry.json")

def load_texture_registry() -> dict:
    path = get_texture_registry_path()
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Failed to load texture registry: {e}")
    return {}

def save_texture_registry(registry: dict):
    path = get_texture_registry_path()
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(registry, f, indent=2)
    except Exception as e:
        logger.error(f"Failed to save texture registry: {e}")


class TextureRequest(BaseModel):
    prompt: str = Field(..., description="The texture description to generate")

@app.post("/api/ai/generate-texture")
async def api_generate_texture(req: TextureRequest):
    import time
    
    registry = load_texture_registry()
    registry_key = f"api_{req.prompt.strip().lower()}"
    if registry_key in registry:
        logger.info(f"API Registry hit for prompt '{req.prompt}'")
        cached_url = registry[registry_key]
        return {"url": cached_url, "local_path": "n/a (cached)"}

    # Save the generated image to a temporary file in the public/assets/generated directory
    output_dir = os.path.join(os.path.dirname(__file__), "..", "web-client", "public", "assets", "generated")
    timestamp = int(time.time())
    file_name = f"tex_{timestamp}.png"
    output_path = os.path.join(output_dir, file_name)
    
    # NEW: Call refactored async HF generator
    from pipeline_setup import generate_texture
    try:
        await generate_texture(req.prompt, output_path)
        full_url = f"/assets/generated/{file_name}"
        registry[registry_key] = full_url
        save_texture_registry(registry)
    except Exception as e:
        logger.error(f"HF Generation failed: {e}")
        # Return fallback status or raise to trigger error handling
        return {"error": str(e), "fallback": True}
    
    logger.info(f"Successfully generated and saved texture to {output_path}")
    return {"url": full_url, "local_path": output_path}

@app.get("/")
async def root():
    return {"status": "The Director is alive."}

async def trigger_game_over_reaction(event_dict: dict):
    """Rachel reacts to the pilot's death with a dramatic, cinematic TTS broadcast."""
    if not active_connections:
        return

    score = event_dict.get('count', 0)
    prompt = (
        f"The pilot just died with {score} kills. "
        "Write ONE short, visceral, cinematic line (≤12 words) as Rachel reacting to this loss. "
        "Make it urgent, haunting — like a distress call cut short. No quotation marks."
    )

    try:
        if groq_client:
            response = await groq_client.chat.completions.create(
                messages=[
                    {"role": "system", "content": "You are Rachel, an AI Director. Your pilot has just been destroyed. React dramatically."},
                    {"role": "user", "content": prompt}
                ],
                model="llama-3.3-70b-versatile",
                temperature=0.95,
                max_tokens=35,
            )
            reaction_text = response.choices[0].message.content.strip().strip('"')
        else:
            # Deterministic fallback when Groq is offline
            reaction_text = random.choice([
                "Vital signs lost. Simulation failed.",
                "Nissim, are you there?! Come in!",
                "Hull integrity zero. We've lost the pilot.",
                "Neural link severed. Initiating resurrection protocol.",
            ])

        logger.info(f"[GAME OVER] Rachel says: {reaction_text}")

        audio_url, audio_b64 = await TTSManager.generate_speech(reaction_text)

        payload = {
            "type": "proactive_audio",
            "text": reaction_text,
        }
        if audio_url:
            payload["audio_url"] = audio_url
        if audio_b64:
            payload["audio_b64"] = audio_b64
        for connection in active_connections:
            try:
                await connection.send_json(payload)
            except Exception as e:
                logger.error(f"Failed to send game-over audio: {e}")

    except Exception as e:
        logger.error(f"Game-over reaction failed: {e}")

async def trigger_level_up_reaction(event_dict: dict):
    """Rachel briefs the pilot on the new level objective."""
    if not active_connections:
        return

    level = event_dict.get('count', 1)
    
    objectives = {
        1: "System checks complete. We're in pirate territory. Stay sharp.",
        2: "Entering the asteroid field. Hull damage is likely if you don't stay agile.",
        3: "Heavy pirate presence detected. They're trying to block our path to the inner planets.",
        4: "URGENT: A Civilian Transport is under fire! Protect them at all costs, Pilot. We cannot lose those lives.",
        5: "The red planet is in sight. Reach Mars while holding off the remnants of the blockade.",
        6: "Asteroid congestion ahead. Clear the path for the fleet.",
        7: "Elite squadrons incoming. These aren't your typical scavengers.",
        8: "Jupiter's gravity is pulling us in. Navigate the storms and hold the perimeter.",
        9: "The void is collapsing. Event horizon detected. Keep your speed up or be consumed.",
        10: "This is it. The final stand. Survive the siege or go down in history.",
        11: "Victory. The sector is secure. Excellent work, Pilot."
    }
    
    briefing_text = objectives.get(level, f"Level {level} objective initiated. Proceed with caution.")
    
    logger.info(f"[LEVEL UP] Rachel briefs: {briefing_text}")

    audio_url, audio_b64 = await TTSManager.generate_speech(briefing_text)

    payload = {
        "type": "proactive_audio",
        "text": briefing_text,
    }
    if audio_url:
        payload["audio_url"] = audio_url
    if audio_b64:
        payload["audio_b64"] = audio_b64
    for connection in active_connections:
        try:
            await connection.send_json(payload)
        except Exception as e:
            logger.error(f"Failed to send level-up audio: {e}")

async def trigger_dm_proactive_reaction(event_dict: dict) -> None:
    """
    Proactive Dungeon Master reaction — fires non-blocking when a drama threshold is crossed.

    Tier routing (fail-fast):
      1. Groq llama-3.1-8b-instant  — fastest, 8 s hard timeout
      2. Gemini Flash (httpx direct) — 10 s hard timeout, no langchain overhead
      3. Static fallback pool        — always succeeds, zero latency

    The generated text is injected directly into the active WebSocket connections
    as a `proactive_audio` frame, bypassing the main User-Prompt queue.
    """
    if not active_connections:
        return

    evt   = event_dict.get("event_type", "unknown")
    count = event_dict.get("count", 0)
    cause = event_dict.get("cause", "unknown force")
    px    = shared_player_pos["x"]
    pz    = shared_player_pos["z"]
    sector = f"Sector ({px:.0f}, {pz:.0f})"

    # ── Build context-aware DM prompt ────────────────────────────────────
    if evt == "combat_kill":
        telemetry_detail = f"{count} enemy ships destroyed by {cause} near {sector}"
        intervention_hint = (
            "You may OFFER a tactical intervention — e.g., "
            "'Want me to spawn backup?', 'Should I boost your shields?', "
            "'I can clear the sector with a black hole if you need it.'"
        )
    elif evt == "anomaly_kill":
        telemetry_detail = f"a {cause} anomaly consumed {count} entities near {sector}"
        intervention_hint = (
            "React to the environmental carnage. Warn the pilot if the anomaly is growing. "
            "Offer to deploy a repulsor or expand the anomaly's range."
        )
    else:
        telemetry_detail = f"event '{evt}': {count}× via {cause} near {sector}"
        intervention_hint = ""

    # ── NEMESIS cross-reference: nearest past-death site to current position ─
    nemesis_context = ""
    for session_mem in _active_session_memories:
        nemesis_entries = [
            e for e in session_mem.sector_events
            if e.get("memory_type") == "NEMESIS"
        ]
        if nemesis_entries:
            def _d3(ev: dict) -> float:
                dx = ev["x"] - px
                dy = ev["y"] - shared_player_pos["y"]
                dz = ev["z"] - pz
                return (dx*dx + dy*dy + dz*dz) ** 0.5
            nearest = min(nemesis_entries, key=_d3)
            if _d3(nearest) < 3000:   # same sector threshold = 3 000 units
                nemesis_context = (
                    f"\nNEMESIS ALERT — the pilot has returned to their death site: "
                    f"{nearest['text'][:200]}\n"
                    "You MUST reference this failure directly and make it personal. "
                    "Psychologically cut them — remind them exactly what killed them here."
                )
        break  # first active session is enough

    system_msg = (
        "You are Rachel, the AI Director of a space combat simulation — "
        "terse, sardonic, cinematic. A major event just occurred.\n"
        "Generate ONE immersive 1–2 sentence response spoken directly to the pilot.\n"
        f"{intervention_hint}"
        f"{nemesis_context}\n"
        "Rules: NO JSON. NO action descriptions. Max 25 words. Stay in character."
    )
    user_msg = f"Simulation event: {telemetry_detail}. React now."

    reaction_text: Optional[str] = None

    # ── Tier 1: Groq (llama-3.1-8b-instant — lowest latency) ─────────────
    if groq_client:
        try:
            resp = await asyncio.wait_for(
                groq_client.chat.completions.create(
                    messages=[
                        {"role": "system", "content": system_msg},
                        {"role": "user",   "content": user_msg},
                    ],
                    model="llama-3.1-8b-instant",
                    temperature=0.85,
                    max_tokens=50,
                ),
                timeout=8.0,
            )
            reaction_text = resp.choices[0].message.content.strip().strip('"')
            logger.info(f"[DM·Groq] {reaction_text}")
        except asyncio.TimeoutError:
            logger.warning("[DM] Groq timed out after 8 s — falling to Gemini Flash")
        except Exception as e:
            logger.warning(f"[DM] Groq failed ({type(e).__name__}) — falling to Gemini Flash")

    # ── Tier 2: Gemini Flash via direct httpx (avoids LangChain overhead) ─
    if not reaction_text:
        google_key = os.getenv("GOOGLE_API_KEY")
        if google_key:
            try:
                gemini_url = (
                    "https://generativelanguage.googleapis.com/v1beta/models/"
                    f"gemini-2.5-flash:generateContent?key={google_key}"
                )
                body = {
                    "contents": [{"parts": [{"text": f"{system_msg}\n\n{user_msg}"}]}],
                    "generationConfig": {"maxOutputTokens": 50, "temperature": 0.85},
                }
                async with httpx.AsyncClient(timeout=10.0) as client:
                    r = await client.post(gemini_url, json=body)
                if r.status_code == 200:
                    data = r.json()
                    reaction_text = (
                        data["candidates"][0]["content"]["parts"][0]["text"].strip()
                    )
                    logger.info(f"[DM·Gemini] {reaction_text}")
                else:
                    logger.warning(f"[DM] Gemini returned HTTP {r.status_code}")
            except Exception as e:
                logger.warning(f"[DM] Gemini failed ({type(e).__name__})")

    # ── Tier 3: Static fallback pool ──────────────────────────────────────
    if not reaction_text:
        _FALLBACKS: Dict[str, list] = {
            "combat_kill": [
                f"{count} targets neutralised. Don't celebrate yet — more are inbound.",
                "Nice shooting, Pilot. The sector's quiet... for now.",
                f"That's {count} down. I'm tracking reinforcements on the edge of the grid.",
            ],
            "anomaly_kill": [
                f"The anomaly just swallowed {count} ships. I'd keep my distance if I were you.",
                "Gravitational surge confirmed. Everything in that radius is gone.",
                "The void is hungry today. Stay out of the event horizon.",
            ],
        }
        options = _FALLBACKS.get(evt, ["Simulation event logged. Adjusting threat matrix."])
        reaction_text = random.choice(options)
        logger.info(f"[DM·Fallback] {reaction_text}")

    # ── Broadcast: TTS → WebSocket ────────────────────────────────────────
    audio_url, audio_b64 = await TTSManager.generate_speech(reaction_text)
    payload = {"type": "proactive_audio", "text": reaction_text}
    if audio_url:
        payload["audio_url"] = audio_url
    if audio_b64:
        payload["audio_b64"] = audio_b64
    for conn in list(active_connections):
        try:
            await conn.send_json(payload)
        except Exception as e:
            logger.error(f"[DM] Broadcast failed: {e}")


@app.post("/engine_telemetry")
async def receive_telemetry(event: TelemetryEvent):
    event_dict = event.dict()
    telemetry_buffer.append(event_dict)
    logger.info(f"Received Engine Telemetry: {event_dict}")

    # ── Player Profiling: log every combat kill with a timestamp ──────────
    if event.event_type == "combat_kill" and event.count > 0:
        kill_event_log.append({
            "count": event.count,
            "cause": event.cause,
            "ts": time.time(),
        })
        _prune_kill_log()
        logger.info(
            f"[PlayerProfile] Kill logged — total in log: {len(kill_event_log)}, "
            f"this event: {event.count}× via {event.cause}"
        )

    # ── Graveyard: track mass destruction; embed ECOLOGY in all sessions ──
    if event.event_type in ("combat_kill", "anomaly_kill") and event.count >= 5:
        for session_mem in _active_session_memories:
            try:
                check_and_embed_graveyard(session_mem, event_dict)
            except Exception as _e:
                logger.warning(f"[Graveyard] Failed to embed in session: {_e}")

    # ── Victory: embed major success location in all active sessions ──────
    if event.event_type == "combat_kill" and event.count >= 10:
        px = shared_player_pos["x"]
        py = shared_player_pos["y"]
        pz = shared_player_pos["z"]
        for session_mem in _active_session_memories:
            try:
                embed_victory_memory(session_mem, event_dict, px, py, pz)
            except Exception as _e:
                logger.warning(f"[Victory] Failed to embed in session: {_e}")

    # ── Nemesis: embed death location in all active sessions ─────────────
    if event.event_type == "game_over":
        px = shared_player_pos["x"]
        py = shared_player_pos["y"]
        pz = shared_player_pos["z"]
        for session_mem in _active_session_memories:
            try:
                embed_nemesis_memory(session_mem, event_dict, px, py, pz)
            except Exception as _e:
                logger.warning(f"[Nemesis] Failed to embed in session: {_e}")

    # ── Anomaly Consumption: sun/star devoured → visual void effect ──────
    if event.event_type == "anomaly_consumption":
        cause_lower = (event.cause or "").lower()
        if "sun" in cause_lower or "star" in cause_lower:
            override_payload = {
                "type": "global_override",
                "ambient_color": "#000000",
                "sun_visible": False,
                "skybox": "void_dark",
            }
            for ws in list(active_connections):
                try:
                    await ws.send_json(override_payload)
                except Exception as _e:
                    logger.warning(f"[GlobalOverride] Broadcast failed: {_e}")
            logger.info(
                f"[GlobalOverride] Sun/star consumed — void darkness broadcast "
                f"to {len(active_connections)} clients"
            )

    # Proactive Drama Dispatcher: trigger_dm_proactive_reaction
    # We only trigger this if the threshold is met
    if event.event_type == "game_over":
        asyncio.create_task(trigger_game_over_reaction(event_dict))
    elif event.event_type == "level_up":
        asyncio.create_task(trigger_level_up_reaction(event_dict))
    else:
        # Avoid spamming the user: don't trigger proactive events for `anomaly_kill`
        # unless it is a truly massive number or just skip it entirely to stop spam.
        if event.event_type == "anomaly_kill":
            pass # Keep it silent during the black hole expansion
        else:
            threshold = DRAMA_THRESHOLDS.get(event.event_type)
            if threshold is not None and event.count >= threshold:
                asyncio.create_task(trigger_dm_proactive_reaction(event_dict))

    return {"status": "ok"}

@app.websocket("/api/v1/dream-stream")
async def dream_stream(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    action_buffer = deque(maxlen=5)
    logger.info("Client connected to the Void.")

    # Session state memory for Evolution over Overwrite
    previous_state = json.dumps({"summary": "Empty Void", "environment_theme": "None", "terrain_rules": "None", "physics_mode": "static", "entities": {}})
    dream_memory = DreamMemory()
    _active_session_memories.append(dream_memory)  # Register for telemetry hooks
    chat_history: List[Dict[str, str]] = []
    is_ai_muted: bool = False
    # Track player position for relative movement commands
    current_player_x: float = 0.0
    current_player_y: float = 0.0
    current_player_z: float = 0.0

    # --- Session Initialization Details ---
    # We NO LONGER load the prior context state into vector memory to prevent LLM memory poisoning
    # Each connection is granted a perfectly clean Memory structure to build new objectives.
    snapshot_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        "world_snap.json"
    )
    if os.path.exists(snapshot_path):
        try:
            with open(snapshot_path, "r") as f:
                snap = json.load(f)
            logger.info(f"Loaded world snapshot state info from {snapshot_path}")

            env_theme = snap.get("environment_theme") or snap.get("visual_prompt") or "Cyberpunk"
            terrain = snap.get("terrain_rules") or "Standard Grid"
            
            # Count entities for immediate context, but don't poison vector memory
            entity_counts: Dict[str, int] = {}
            for ent in snap.get("entities", []):
                t = ent.get("ent_type", "unknown")
                entity_counts[t] = entity_counts.get(t, 0) + 1

            # Set previous_state so the LLM has immediate context on what exists
            previous_state = json.dumps({
                "summary": snap.get("summary", "Legacy World"),
                "environment_theme": env_theme,
                "terrain_rules": terrain,
                "physics_mode": snap.get("physics_mode", "static"),
                "entities": entity_counts,
            })
        except Exception as e:
            logger.warning(f"Failed to read world snapshot: {e}")
    else:
        logger.info("No world_snap.json found. Starting from empty void.")
        
    try:
        await websocket.send_json({
            "type": "text", 
            "content": "AI Director Rachel online. I control sector physics, tactical spawning, and central intelligence. Awaiting your command, Pilot."
        })

        audio_buffer = bytearray()

        while True:
            message = await websocket.receive()
            
            if message.get("type") == "websocket.disconnect":
                logger.info("Client disconnected. Breaking loop.")
                break
                
            if "bytes" in message:
                audio_buffer.extend(message["bytes"])
                
            elif "text" in message:
                data = json.loads(message["text"])
                msg_type = data.get("type")

                if msg_type == "telemetry":
                    action_buffer.append(data)
                    logger.info(f"Received telemetry: {data}")
                    continue

                if msg_type == "player_pos":
                    current_player_x = float(data.get("x", 0.0))
                    current_player_y = float(data.get("y", 0.0))
                    current_player_z = float(data.get("z", 0.0))
                    # Keep module-level position in sync for telemetry hooks
                    shared_player_pos["x"] = current_player_x
                    shared_player_pos["y"] = current_player_y
                    shared_player_pos["z"] = current_player_z
                    continue

                current_player_x = shared_player_pos.get("x", 0.0)
                current_player_y = shared_player_pos.get("y", 0.0)
                current_player_z = shared_player_pos.get("z", 0.0)
                
                if "player_position" in data:
                    pos = data.get("player_position")
                    if isinstance(pos, dict):
                        current_player_x = float(pos.get("x", current_player_x))
                        current_player_y = float(pos.get("y", current_player_y))
                        current_player_z = float(pos.get("z", current_player_z))
                        shared_player_pos["x"] = current_player_x
                        shared_player_pos["y"] = current_player_y
                        shared_player_pos["z"] = current_player_z
                
                transcript = ""
                should_process_pipeline = False
                
                if msg_type == "text_command":
                    transcript = data.get("text", "").strip()
                    logger.info(f"Manual Text Override Received: {transcript}")
                    if transcript:
                        should_process_pipeline = True
                        
                        # ---------- TEXTURE KEYWORD INTERCEPTOR (Text Mode) ----------
                        texture_keywords = [
                            "generate texture", "create texture", "make a texture",
                            "תייצרי טקסטורה", "טקסטורה של", "תעשי טקסטורה"
                        ]
                        for kw in texture_keywords:
                            if kw in transcript.lower():
                                logger.info(f"Texture Generation Triggered (Interceptor): {transcript}")
                                transcript += "\n\nCRITICAL INSTRUCTION: The user explicitly requested a texture. You MUST output a descriptive prompt in the `generate_texture_prompt` JSON field AND specify the target in `target_planet_id` (e.g., 'Sun', 'Earth', 'Mars'). Do not just change colors."
                                break

                        # No immediate text feedback, wait for processing indicator or result
                        pass
                        
                elif msg_type == "update_audio_settings":
                    try:
                        is_ai_muted = data.get("ai_muted", False)
                        settings = json.loads(previous_state) if previous_state else {}
                        if "audio_settings" not in settings:
                            settings["audio_settings"] = {"game_muted": False, "ai_muted": False}
                        settings["audio_settings"]["ai_muted"] = is_ai_muted
                        settings["audio_settings"]["game_muted"] = data.get("game_muted", False)
                        previous_state = json.dumps(settings)
                        logger.info(f"Updated audio settings manually: {settings['audio_settings']} (is_ai_muted: {is_ai_muted})")
                        await scrub_and_sync_state(settings)
                    except Exception as e:
                        logger.error(f"Failed to update audio settings: {e}")
                
                elif msg_type == "audio_end":
                    
                    if len(audio_buffer) < 10000:
                        logger.warning(f"Audio chunk too small ({len(audio_buffer)} bytes). Skipping.")
                        audio_buffer.clear()
                        continue
                        
                    await websocket.send_json({
                        "type": "text", 
                        "content": "Listening to the echoes..."
                    })
                    
                    # 1. Transcribe Audio (Groq Whisper)
                    transcript = ""
                    if groq_client:
                        # Write audio buffer to temp file, ensuring format matches MIME set in App.tsx ('audio/webm')
                        with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as temp_audio:
                            temp_audio.write(audio_buffer)
                            temp_audio_path = temp_audio.name
                            
                        # Debug: Save the last voice clip to root to verify bytes
                        debug_path = os.path.join(os.path.dirname(__file__), "..", "..", "debug_last_voice.webm")
                        try:
                            with open(debug_path, "wb") as dbg_file:
                                dbg_file.write(audio_buffer)
                            logger.info(f"Saved debug audio blob to {debug_path}")
                        except Exception as e:
                            logger.error(f"Failed to save debug audio: {e}")
                            
                        audio_len = len(audio_buffer)
                        if audio_len < 10000:
                            logger.warning(f"Audio payload is suspiciously small: {audio_len} bytes. Might be empty/silence.")
                        
                        try:
                            logger.info(f"Transcribing {len(audio_buffer)} bytes of audio...")
                            with open(temp_audio_path, "rb") as file:
                                transcription = await groq_client.audio.transcriptions.create(
                                    file=(os.path.basename(temp_audio_path), file.read()),
                                    model="whisper-large-v3",
                                )
                                transcript = transcription.text.strip()
                            print(f'User said: {transcript}')
                            logger.info(f"Whisper Transcript: {transcript}")
                        except Exception as e:
                            logger.error(f"STT Error: {e}")
                            transcript = ""
                        finally:
                            os.remove(temp_audio_path)
                    else:
                        logger.warning("Mocking STT because Groq Client is offline.")
                        transcript = "A towering cyberpunk city under a crimson sky."
                    
                    audio_buffer.clear()
                    
                    if transcript:
                        # Hardcore STT Filter: Remove common Whisper hallucinations (silence artifacts)
                        cleaned_transcript = re.sub(r'[^\w\s]', '', transcript).strip().lower()
                        hallucinations = {"you", "thankyou", "am", "youknow", "thankyouforwatching"}
                        
                        if not cleaned_transcript or cleaned_transcript in hallucinations:
                            logger.info(f"Filtered silence hallucination: '{transcript}'")
                            transcript = ""
                            should_process_pipeline = False
                            
                            import random
                            if random.random() < 0.2:
                                await websocket.send_json({"type": "text", "content": "I lost the signal, Pilot. Please repeat your command."})
                                await websocket.send_json({"type": "transcript", "content": "*static*"})

                            await websocket.send_json({"type": "status_update", "status": "idle"})
                            await websocket.send_json({"msg_type": "status", "state": "idle"})
                        else:
                            should_process_pipeline = True
                            
                            # ---------- TEXTURE KEYWORD INTERCEPTOR ----------
                            texture_keywords = [
                                "generate texture", "create texture", "make a texture",
                                "תייצרי טקסטורה", "טקסטורה של", "תעשי טקסטורה"
                            ]
                            for kw in texture_keywords:
                                if kw in transcript.lower():
                                    logger.info(f"Texture Generation Triggered (Interceptor): {transcript}")
                                    transcript += "\n\nCRITICAL INSTRUCTION: The user explicitly requested a texture. You MUST output a descriptive prompt in the `generate_texture_prompt` JSON field. Do not just change colors."
                                    break
                            
                            await websocket.send_json({"type": "transcript", "content": transcript})
                    else:
                        logger.warning("Empty transcript or STT failure. Skipping LLM generation.")
                
                if should_process_pipeline:
                    await websocket.send_json({"msg_type": "status", "state": "synthesizing"})
                    # 2. Generate JSON World State via LangChain Agent
                    if world_chain:
                        logger.info("Generating World State schema...")
                        try:
                            # ── Player Profiling: analyse + embed before every LLM call ──
                            player_profile = analyze_and_embed_player_profile(dream_memory)

                            # ── Context Retrieval ──
                            retrieved_knowledge = dream_memory.get_relevant_context(
                                transcript, k=5,
                                px=current_player_x, py=current_player_y, pz=current_player_z
                            )
                            sector_context = dream_memory.get_nearby_sector_context(current_player_x, current_player_y, current_player_z, k=3)
                            past_world_history = "\n".join([f"{msg['role']}: {msg['content']}" for msg in chat_history[-10:]]) if chat_history else "No previous memories."
                            
                            if action_buffer:
                                telemetry_str = "\nRecent telemetry from pilot's ship:\n" + "\n".join([json.dumps(e) for e in action_buffer]) + "\nIf relevant, weave a brief, natural reaction to their flying or actions into your response."
                                action_buffer.clear()
                            else:
                                telemetry_str = "No recent telemetry."

                            # --- PRE-PROMPT CULLING (The "Axe" Method) ---
                            culled_prev_state = previous_state
                            try:
                                if previous_state and previous_state.strip():
                                    state_dict = json.loads(previous_state)
                                    if "entities" in state_dict and isinstance(state_dict["entities"], (list, dict)):
                                        orig_count = len(state_dict["entities"]) if isinstance(state_dict["entities"], list) else len(state_dict["entities"])
                                        # Sort entities by distance to player
                                        def get_dist(e):
                                            try:
                                                # Handle both list of dicts and dict of dicts
                                                entity_data = e if isinstance(e, dict) else e[1] # if e is (key, value) pair from dict.items()
                                                ex = float(entity_data.get("x", 0))
                                                ey = float(entity_data.get("y", 0))
                                                ez = float(entity_data.get("z", 0))
                                                return math.sqrt((ex-current_player_x)**2 + (ey-current_player_y)**2 + (ez-current_player_z)**2)
                                            except: return 999999
                                        
                                        if isinstance(state_dict["entities"], list):
                                            state_dict["entities"].sort(key=get_dist)
                                            state_dict["entities"] = state_dict["entities"][:5] # Hard limit to 5 closest
                                        elif isinstance(state_dict["entities"], dict):
                                            sorted_items = sorted(state_dict["entities"].items(), key=get_dist)
                                            state_dict["entities"] = dict(sorted_items[:5])

                                        # Also truncate empty filters/configs
                                        for key in ["radar_filters", "visual_config"]:
                                            if key in state_dict and isinstance(state_dict[key], dict):
                                                if not any(state_dict[key].values()):
                                                    del state_dict[key]

                                        culled_prev_state = json.dumps(state_dict)
                                        logger.info(f"INFO: Culling active. Sending only {len(state_dict['entities'])} entities and minimal status to LLM (was {orig_count} entities)")
                            except Exception as ce:
                                logger.error(f"Culling failed: {ce}")

                            # ── Dynamic Model Selection & Token Estimation ──
                            format_instructions = parser.get_format_instructions()
                            
                            # Estimate total tokens before calling LLM
                            total_prompt_content = (
                                system_prompt + 
                                str(retrieved_knowledge) + 
                                str(culled_prev_state) + 
                                str(past_world_history) + 
                                str(telemetry_str) + 
                                str(transcript) + 
                                str(format_instructions) + 
                                str(player_profile)
                            )
                            
                            est_tokens = estimate_token_count(total_prompt_content)
                            logger.info(f"Estimated prompt tokens: {est_tokens}")

                            active_chain = prompt | llm | parser

                            try:
                                # Assemble Input Schema
                                input_data = {
                                    "retrieved_knowledge": retrieved_knowledge,
                                    "previous_state": culled_prev_state,
                                    "past_world_history": past_world_history,
                                    "recent_telemetry": telemetry_str,
                                    "user_input": transcript,
                                    "format_instructions": format_instructions,
                                    "player_position": f"x={current_player_x:.0f}, y={current_player_y:.0f}, z={current_player_z:.0f}",
                                    "sector_context": sector_context,
                                    "player_profile": player_profile,
                                }

                                MAX_PROMPT_TOKENS = 80000
                                if est_tokens > MAX_PROMPT_TOKENS:
                                    logger.warning(f"Context too large ({est_tokens} tokens). Gracefully truncating history.")

                                    # Preserve the most recent 4 messages instead of slicing string
                                    if chat_history and len(chat_history) > 4:
                                        input_data["past_world_history"] = "\n".join([f"{msg['role']}: {msg['content']}" for msg in chat_history[-4:]])

                                    # Keep only the 3 most recent telemetry events
                                    if len(telemetry_str) > 500:
                                        input_data["recent_telemetry"] = telemetry_str[:500] + "..."

                                    # If still excessively large, limit knowledge retrieval size
                                    if estimate_token_count(str(input_data)) > MAX_PROMPT_TOKENS:
                                        input_data["retrieved_knowledge"] = str(retrieved_knowledge)[:4000]

                                try:
                                    world_state_data = await active_chain.ainvoke(input_data)
                                except Exception as _primary_err:
                                    # If primary chain failed AND we have llm_slim (GitHub models),
                                    # retry with a slim prompt (~3500 tokens) to avoid 413 errors.
                                    _err_str = str(_primary_err).lower()
                                    _is_payload = any(k in _err_str for k in ("413", "payload too large", "request entity too large"))
                                    _all_exhausted = any(k in _err_str for k in ("429", "resource_exhausted", "quota"))
                                    if llm_slim and (_is_payload or _all_exhausted):
                                        logger.warning(f"Primary LLM chain failed ({type(_primary_err).__name__}), trying llm_slim with truncated prompt...")
                                        # Minimal format instructions — replaces the full ~2500-token Pydantic schema
                                        _slim_format = (
                                            'Respond with ONLY a JSON object. Required fields: '
                                            '"summary" (string), "conversational_reply" (string). '
                                            'Optional: "modify_player" (object with "color" and/or "model_type"), '
                                            '"behavior_policy" ("idle"|"swarm"|"attack"|"protect"|"scatter"), '
                                            '"spawn_entities" (array). No markdown, no code blocks.'
                                        )
                                        slim_data = {
                                            "retrieved_knowledge": str(retrieved_knowledge)[:400],
                                            "previous_state": "{}",
                                            "past_world_history": "\n".join(f"{m['role']}: {m['content']}" for m in chat_history[-1:]) if chat_history else "",
                                            "recent_telemetry": "No recent telemetry.",
                                            "user_input": transcript,
                                            "format_instructions": _slim_format,
                                            "player_position": f"x={current_player_x:.0f}, y={current_player_y:.0f}, z={current_player_z:.0f}",
                                            "sector_context": "",
                                            "player_profile": "",
                                        }
                                        slim_chain = prompt | llm_slim | parser
                                        world_state_data = await slim_chain.ainvoke(slim_data)
                                        logger.info("llm_slim succeeded.")
                                    else:
                                        raise
                            except OutputParserException as e:
                                logger.error(f"LLM hallucinated invalid entity type: {e}")
                                error_msg = "I tried to process that, but my engine constraints prevent it. Please request a valid entity."
                                await websocket.send_json({"type": "text", "content": error_msg})
                                audio_url, audio_b64 = await TTSManager.generate_speech(error_msg)
                                if audio_url or audio_b64:
                                    payload = {"type": "proactive_audio", "text": error_msg}
                                    if audio_url:
                                        payload["audio_url"] = audio_url
                                    if audio_b64:
                                        payload["audio_b64"] = audio_b64
                                    await websocket.send_json(payload)
                                await websocket.send_json({"msg_type": "status", "state": "idle"})
                                continue

                            # ── Validate Output Structure ─────────────────────────────
                            if not isinstance(world_state_data, dict):
                                logger.error(f"LLM returned a non-dictionary response ({type(world_state_data)}). Content: {world_state_data}")
                                # Try to salvage if it looks like a string that might contain a conversational reply
                                if isinstance(world_state_data, str):
                                    # Create a dummy state so the rest of the pipeline doesn't crash
                                    world_state_data = {
                                        "summary": "AI Response Error",
                                        "conversational_reply": world_state_data,
                                        "environment_theme": "None",
                                        "terrain_rules": "None",
                                        "physics_mode": "static"
                                    }
                                else:
                                    raise ValueError(f"Expected dict from LLM, got {type(world_state_data)}")

                            # ── Strip internal "plan" field (Think-Before-Act) ─────────
                            # The plan is only for forcing structured LLM reasoning;
                            # it must never reach the engine or the frontend.
                            llm_plan = world_state_data.pop("plan", None)
                            if llm_plan:
                                logger.info(f"[ThinkBeforeAct] LLM plan: {llm_plan}")

                            # ── Backend Spawn Sanity Guards ───────────────────────────
                            # Enforce hard per-type caps on spawn_entities regardless
                            # of what the LLM outputted.
                            raw_spawns = world_state_data.get("spawn_entities", [])
                            if raw_spawns and isinstance(raw_spawns, list):
                                type_counts: Dict[str, int] = {}
                                capped_spawns: list = []
                                for s in raw_spawns:
                                    if not isinstance(s, dict):
                                        continue
                                    etype = s.get("ent_type", "unknown")
                                    cap = SPAWN_CAPS.get(etype, 5)  # default cap of 5 for unknown types
                                    type_counts[etype] = type_counts.get(etype, 0) + 1
                                    if type_counts[etype] <= cap and len(capped_spawns) < SPAWN_TOTAL_CAP:
                                        capped_spawns.append(s)
                                if len(capped_spawns) < len(raw_spawns):
                                    logger.warning(
                                        f"[SpawnCap] Capped spawn_entities from {len(raw_spawns)} to "
                                        f"{len(capped_spawns)} (per-type caps: {dict(type_counts)})"
                                    )
                                world_state_data["spawn_entities"] = capped_spawns

                            # Cap anomaly spawns to 1 per call
                            raw_anomalies = world_state_data.get("spawn_anomalies", [])
                            if raw_anomalies and isinstance(raw_anomalies, list) and len(raw_anomalies) > SPAWN_CAPS.get("anomaly", 1):
                                anomaly_cap = SPAWN_CAPS.get("anomaly", 1)
                                logger.warning(
                                    f"[SpawnCap] Capped spawn_anomalies from {len(raw_anomalies)} to {anomaly_cap}"
                                )
                                world_state_data["spawn_anomalies"] = raw_anomalies[:anomaly_cap]

                            chat_history.append({"role": "user", "content": transcript})
                            chat_history.append({"role": "Rachel", "content": world_state_data.get("conversational_reply", "")})
                            
                            dream_memory.add_memory(world_state_data)

                            # Tag this interaction with the player's current sector location
                            dream_memory.add_sector_event(
                                world_state_data.get("summary", "Event"),
                                current_player_x, current_player_y, current_player_z
                            )

                            # ── NARRATIVE Fact Extraction: Active Memory Commits ──────────
                            important_facts = world_state_data.get("important_facts", [])
                            if important_facts and isinstance(important_facts, list):
                                for fact in important_facts:
                                    if isinstance(fact, str) and fact.strip():
                                        logger.info(f"[Player Fact] Committing explicitly to memory: {fact}")
                                        dream_memory.add_typed_memory(f"PLAYER FACT: {fact}", "NARRATIVE")

                            # ── Ecological Memory: auto-embed physics distortions ─────────
                            reality_ovr_raw = world_state_data.get("reality_override")
                            if reality_ovr_raw and isinstance(reality_ovr_raw, dict):
                                embed_ecology_memory(
                                    dream_memory, reality_ovr_raw,
                                    current_player_x, current_player_y, current_player_z
                                )

                            # ── META_CONFIG: remember UI/audio/visual config changes ──────
                            embed_meta_config_memory(
                                dream_memory, world_state_data,
                                current_player_x, current_player_z
                            )

                            # --- WorldState Culling BEFORE Serialization ---
                            # 1. Entity Culling
                            if "entities" in world_state_data:
                                ents = world_state_data["entities"]
                                if isinstance(ents, dict):
                                    def _ent_dist(item):
                                        v = item[1]
                                        if isinstance(v, dict):
                                            ex, ey, ez = float(v.get("x", 0.0)), float(v.get("y", 0.0)), float(v.get("z", 0.0))
                                            return ((ex - current_player_x)**2 + (ey - current_player_y)**2 + (ez - current_player_z)**2)
                                        return float('inf')
                                    sorted_ents = sorted(ents.items(), key=_ent_dist)
                                    world_state_data["entities"] = dict(sorted_ents[:10])
                                elif isinstance(ents, list):
                                    def _ent_dist_list(v):
                                        if isinstance(v, dict):
                                            ex, ey, ez = float(v.get("x", 0.0)), float(v.get("y", 0.0)), float(v.get("z", 0.0))
                                            return ((ex - current_player_x)**2 + (ey - current_player_y)**2 + (ez - current_player_z)**2)
                                        return float('inf')
                                    sorted_ents = sorted(ents, key=_ent_dist_list)
                                    world_state_data["entities"] = sorted_ents[:10]

                            # 2. Status Truncation
                            for key in ["radar_filters", "visual_config"]:
                                val = world_state_data.get(key)
                                if isinstance(val, dict) and not any(val.values()):
                                    del world_state_data[key]

                            # Cache the result as stringified JSON for the next loop
                            previous_state = json.dumps(world_state_data)
                            
                            logger.info(f"LLM Generated World State: {json.dumps(world_state_data, indent=2)}")

                            # 3. Co-Creation Loop conversational response text (sent instantly)
                            conversational_reply = world_state_data.get("conversational_reply", "The world is shifting...")

                            # ── NARRATIVE Lore: extract story hooks from Rachel's reply ──
                            extract_and_embed_lore(
                                dream_memory, conversational_reply,
                                current_player_x, current_player_z
                            )

                            # Synchronous Texture Generation Block (Wait for completion)
                            gen_prompt = world_state_data.get("generate_texture_prompt")
                            raw_target = world_state_data.get("target_planet_id")
                            
                            # Normalize target planet name: "earth" -> "Earth"
                            target_planet = None
                            if raw_target:
                                target_planet = raw_target.strip().capitalize()
                                # Special case for multi-word or unconventional planets if any
                                if target_planet == "Sun": target_planet = "Sun"
                            
                            # FALLBACK: If LLM provided a prompt but no target, attempt to guess from transcript or summary
                            if gen_prompt and not target_planet:
                                logger.info("LLM provided texture prompt but no target_planet_id. Attempting heuristic extraction...")
                                t_lower = transcript.lower()
                                if any(kw in t_lower for kw in ["shmesh", "שמש", "sun"]):
                                    target_planet = "Sun"
                                elif any(kw in t_lower for kw in ["earth", "ארץ", "world"]):
                                    target_planet = "Earth"
                                elif any(kw in t_lower for kw in ["mars", "מאדים"]):
                                    target_planet = "Mars"
                                elif any(kw in t_lower for kw in ["moon", "ירח", "luna"]):
                                    target_planet = "Luna"
                                elif any(kw in t_lower for kw in ["jupiter", "צדק"]):
                                    target_planet = "Jupiter"
                                elif any(kw in t_lower for kw in ["venus", "נוגה"]):
                                    target_planet = "Venus"
                                elif any(kw in t_lower for kw in ["mercury", "חמה"]):
                                    target_planet = "Mercury"
                                elif any(kw in t_lower for kw in ["saturn", "שבתאי"]):
                                    target_planet = "Saturn"
                                elif any(kw in t_lower for kw in ["uranus", "אורנוס"]):
                                    target_planet = "Uranus"
                                elif any(kw in t_lower for kw in ["neptune", "נפטון"]):
                                    target_planet = "Neptune"
                                elif any(kw in t_lower for kw in ["titan", "טיטאן"]):
                                    target_planet = "Titan"
                                
                                if target_planet:
                                    logger.info(f"Heuristic matched target: {target_planet}")
                                    # Ensure visual_config exists for the guessed target
                                    if "visual_config" not in world_state_data: world_state_data["visual_config"] = {}
                                    if "custom_textures" not in world_state_data["visual_config"]: world_state_data["visual_config"]["custom_textures"] = {}

                            if gen_prompt and target_planet:
                                logger.info(f"LLM requested texture generation for {target_planet}: {gen_prompt}")
                                await websocket.send_json({"msg_type": "status", "state": "orchestrating", "detail": f"Synthesizing texture for {target_planet}..."})
                                
                                # Ensure visual_config exists
                                if "visual_config" not in world_state_data or not isinstance(world_state_data["visual_config"], dict):
                                    world_state_data["visual_config"] = {}
                                
                                # Force planet mode to texture for the target
                                if "planet_mode" not in world_state_data["visual_config"] or not isinstance(world_state_data["visual_config"]["planet_mode"], dict):
                                    world_state_data["visual_config"]["planet_mode"] = {}
                                world_state_data["visual_config"]["planet_mode"][target_planet] = "texture"

                                registry = load_texture_registry()
                                registry_key = f"{target_planet.lower()}_{gen_prompt.strip().lower()}"

                                if registry_key in registry:
                                    full_url = registry[registry_key]
                                    logger.info(f"Registry hit for {target_planet}: {full_url}")
                                    world_state_data["conversational_reply"] += f"\n[System Note: Loading archived texture for {target_planet}.]"
                                    
                                    if "custom_textures" not in world_state_data["visual_config"] or not isinstance(world_state_data["visual_config"]["custom_textures"], dict):
                                        world_state_data["visual_config"]["custom_textures"] = {}
                                    
                                    world_state_data["visual_config"]["custom_textures"][target_planet] = full_url
                                else:
                                    output_dir = os.path.join(app_dir, "..", "web-client", "public", "assets", "generated")
                                    os.makedirs(output_dir, exist_ok=True)
                                    timestamp = int(time.time())
                                    file_name = f"tex_{timestamp}.png"
                                    output_path = os.path.join(output_dir, file_name)
                                    
                                    from pipeline_setup import generate_texture
                                    try:
                                        await generate_texture(gen_prompt, output_path)
                                        full_url = f"/assets/generated/{file_name}"
                                        
                                        if "custom_textures" not in world_state_data["visual_config"] or not isinstance(world_state_data["visual_config"]["custom_textures"], dict):
                                            world_state_data["visual_config"]["custom_textures"] = {}
                                        
                                        world_state_data["visual_config"]["custom_textures"][target_planet] = full_url
                                        logger.info(f"Injected texture URL for {target_planet}: {full_url}")

                                        registry[registry_key] = full_url
                                        save_texture_registry(registry)
                                    except Exception as tex_err:
                                        logger.error(f"Sync-Generation failed: {tex_err}")
                                        world_state_data["conversational_reply"] += f"\n[System Note: Texture generation failed for {target_planet}. Using default surface.]"

                            # NOTE: Text is NOT sent here anymore. It is bundled with the
                            # generation_result payload (after TTS) so that the chat message
                            # and Rachel's voice arrive at the frontend simultaneously.

                            # Transmit the underlying JSON schema to React (visual changes apply immediately)
                            await websocket.send_json({
                                "type": "world_state",
                                "content": world_state_data
                            })

                            # 4. Neural Generation Pipeline (Run TTS Concurrently with Engine Sync)
                            logger.info("Executing concurrent TTS and Engine Sync...")
                            await websocket.send_json({"msg_type": "status", "state": "orchestrating"})

                            # Fire generative requests simultaneously
                            if is_ai_muted:
                                tts_task = asyncio.create_task(asyncio.sleep(0))
                                # We need it to return (None, None) to match gather expectations
                                async def mock_tts(): return (None, None)
                                tts_task = asyncio.create_task(mock_tts())
                            else:
                                tts_task = TTSManager.generate_speech(conversational_reply)
                                
                            engine_sync_task = scrub_and_sync_state(world_state_data) # Scrub and Sync with Rust ECS

                            (audio_url, audio_b64), engine_synced = await asyncio.gather(tts_task, engine_sync_task)
                            
                            # 4.5. Trigger /spawn and lifecycle endpoints if LLM requested them
                            spawn_requests = world_state_data.get("spawn_entities", [])
                            npc_ships = world_state_data.get("npc_ships", [])
                            spawn_anomalies = world_state_data.get("spawn_anomalies", [])
                            asteroid_rings = world_state_data.get("asteroid_rings", [])
                            
                            combined_spawns: List[Dict[str, Any]] = []
                            
                            if npc_ships:
                                for npc_req in npc_ships:
                                    if isinstance(npc_req, dict):
                                        npc_type = npc_req.get("type", "neutral")
                                        npc_count = min(npc_req.get("count", 1), 12)
                                        f_type = "enemy" if npc_type == "hostile" else "neutral"
                                        f_faction = "pirate" if npc_type == "hostile" else "neutral"
                                        
                                        # Tactical overrides
                                        custom_color = npc_req.get("color")
                                        ship_type = npc_req.get("ship_type") # 'ufo' or 'freighter_glb'
                                        spawn_dist = npc_req.get("spawn_distance")
                                        fire_mult = npc_req.get("fire_rate_multiplier")
                                        behavior = npc_req.get("behavior")
                                        
                                        # Strict Routing Defaults
                                        if not ship_type:
                                            ship_type = "ufo" if npc_type == "hostile" else "freighter_glb"
                                        
                                        if not behavior and npc_type == "neutral":
                                            behavior = "neutral_wander"
                                        
                                        for _ in range(npc_count):
                                            # Position logic
                                            if spawn_dist:
                                                angle = random.uniform(0, 2 * math.pi)
                                                spawn_x = current_player_x + math.cos(angle) * spawn_dist
                                                spawn_z = current_player_z + math.sin(angle) * spawn_dist
                                                spawn_y = current_player_y + random.uniform(-100, 100)
                                            else:
                                                spawn_x = current_player_x + random.uniform(-4000, 4000)
                                                spawn_z = current_player_z + random.uniform(-4000, 4000)
                                                spawn_y = current_player_y + random.uniform(-200, 200)
                                                
                                            spawn_data = {
                                                "ent_type": f_type,
                                                "x": spawn_x,
                                                "y": spawn_y,
                                                "z": spawn_z,
                                                "physics": "static" if npc_type == "neutral" else "velocity",
                                                "faction": f_faction,
                                                "speed": random.uniform(20.0, 40.0) if npc_type == "neutral" else random.uniform(50.0, 80.0)
                                            }
                                            
                                            spawn_data["model_type"] = ship_type
                                            if custom_color: spawn_data["color"] = custom_color
                                            if fire_mult is not None: spawn_data["fire_rate_multiplier"] = fire_mult
                                            if behavior: spawn_data["behavior"] = behavior
                                            
                                            combined_spawns.append(spawn_data)

                            if asteroid_rings:
                                for ring in asteroid_rings:
                                    if not isinstance(ring, dict): continue
                                    count = int(clean_float(ring.get("asteroid_count", 50), 50.0))
                                    inner_rad = clean_float(ring.get("inner_radius", 1000.0), 1000.0)
                                    outer_rad = clean_float(ring.get("outer_radius", 3000.0), 3000.0)
                                    raw_target_id = ring.get("target_planet_id", "")
                                    # CASE NORMALIZATION
                                    target_id = str(raw_target_id).strip().capitalize()
                                    tex_prompt = ring.get("texture_prompt")
                                    
                                    t_x, t_y, t_z = 0.0, 0.0, 0.0
                                    try:
                                        if os.path.exists(snapshot_path):
                                            with open(snapshot_path, "r") as f:
                                                snap = json.load(f)
                                            for ent in snap.get("entities", []):
                                                name = str(ent.get("name", "")).strip().capitalize()
                                                if name == target_id or str(ent.get("id")) == str(target_id):
                                                    t_x = clean_float(ent.get("x", 0.0))
                                                    t_y = clean_float(ent.get("y", 0.0))
                                                    t_z = clean_float(ent.get("z", 0.0))
                                                    break
                                    except Exception as e:
                                        logger.warning(f"Failed to lookup planet {target_id}: {e}")
                                        
                                    custom_tex_url = None
                                    if tex_prompt:
                                        logger.info(f"Generating volumetric ring textures for {target_id}...")
                                        output_dir = os.path.join(app_dir, "..", "web-client", "public", "assets", "generated")
                                        os.makedirs(output_dir, exist_ok=True)
                                        timestamp = int(time.time())
                                        file_name = f"tex_ring_{timestamp}.png"
                                        output_path = os.path.join(output_dir, file_name)
                                        try:
                                            from pipeline_setup import generate_texture
                                            await generate_texture(tex_prompt, output_path)
                                            custom_tex_url = f"/assets/generated/{file_name}"
                                        except Exception as e:
                                            logger.error(f"Failed ring texture: {e}")
                                            
                                    for i in range(count):
                                        r = random.uniform(inner_rad, outer_rad)
                                        theta = random.uniform(0, 2 * math.pi)
                                        ast_x = t_x + r * math.cos(theta)
                                        ast_y = t_y + r * math.sin(theta)
                                        # Volumetric depth near zero
                                        ast_z = t_z + random.uniform(-15.0, 15.0)
                                        
                                        spawn = {
                                            "ent_type": "asteroid",
                                            "x": ast_x,
                                            "y": ast_y,
                                            "z": ast_z,
                                            "physics": "orbital",
                                            "radius": random.uniform(5.0, 30.0),
                                            "name": f"ring_ast_{target_id}_{i}"
                                        }
                                        if custom_tex_url:
                                            spawn["texture_url"] = custom_tex_url
                                        combined_spawns.append(spawn)
                            
                            if spawn_requests:
                                for s in spawn_requests:
                                    if isinstance(s, dict):
                                        scrubbed = s.copy()
                                        scrubbed["x"] = clean_float(s.get("x", 0.0))
                                        scrubbed["y"] = clean_float(s.get("y", 0.0))
                                        scrubbed["radius"] = clean_float(s.get("radius", 1.0), 1.0)
                                        scrubbed["speed"] = clean_float(s.get("speed", 0.0))
                                        combined_spawns.append(scrubbed)

                            if spawn_anomalies:
                                # ── Clear-First Policy ─────────────────────────────────────────
                                # Always remove ALL existing anomalies before spawning a new one.
                                # Prevents Rachel from "moving" a BH by stacking a second one.
                                try:
                                    async with httpx.AsyncClient() as _bh_client:
                                        await _bh_client.post(
                                            f"{RUST_ENGINE_URL}/despawn",
                                            json={"ent_type": "anomaly"},
                                            timeout=2.0,
                                        )
                                        logger.info("[BlackHole] Pre-clear: all existing anomalies despawned")
                                except Exception as _bh_err:
                                    logger.warning(f"[BlackHole] Pre-clear failed: {_bh_err}")

                                for anomaly in spawn_anomalies:
                                    if isinstance(anomaly, dict):
                                        ax = clean_float(anomaly.get("x", 0.0))
                                        ay = clean_float(anomaly.get("y", 0.0))
                                        az = clean_float(anomaly.get("z", 0.0))

                                        # ── Safe-Distance Guard ───────────────────────────────
                                        # BH must spawn ≥3000u from origin (Sun centre).
                                        # If Rachel placed it inside the Sun, push it outward.
                                        MIN_SAFE_FROM_SUN = 3000.0
                                        dist_from_sun = (ax**2 + ay**2 + az**2) ** 0.5
                                        if dist_from_sun < MIN_SAFE_FROM_SUN:
                                            factor = MIN_SAFE_FROM_SUN / max(dist_from_sun, 1.0)
                                            ax, ay, az = ax * factor, ay * factor, az * factor
                                            logger.warning(
                                                f"[BlackHole] Clamped spawn from d={dist_from_sun:.0f} "
                                                f"to safe zone d={MIN_SAFE_FROM_SUN:.0f}"
                                            )

                                        # ── Mass Cap ─────────────────────────────────────────
                                        # Cap mass so event_horizon (mass * 1.5) never exceeds
                                        # MAX_WORLD_RADIUS (~64,000u).  15,000 → EH=22,500u max.
                                        raw_mass = clean_float(anomaly.get("mass", 5000.0), 5000.0)
                                        capped_mass = min(raw_mass, 15000.0)
                                        if capped_mass < raw_mass:
                                            logger.warning(
                                                f"[BlackHole] Mass capped {raw_mass:.0f}→{capped_mass:.0f} "
                                                f"to prevent instant universe-wipe"
                                            )

                                        combined_spawns.append({
                                            "ent_type": "anomaly",
                                            "x": ax,
                                            "y": ay,
                                            "z": az,
                                            "physics": "static",
                                            "anomaly_type": anomaly.get("anomaly_type", "black_hole"),
                                            "mass": capped_mass,
                                            "radius": min(clean_float(anomaly.get("radius", 200.0), 200.0), 300.0),
                                        })

                            if combined_spawns:
                                await spawn_entities_in_engine(combined_spawns)
                            
                            if world_state_data.get("clear_world"):
                                await manage_entities_in_engine("clear")
                            
                            if world_state_data.get("mission_complete"):
                                logger.info("Mission Command: Triggering next level progression...")
                                await manage_entities_in_engine("api/engine/next-level")
                            
                            despawn_filter = world_state_data.get("despawn_entities")
                            if despawn_filter:
                                await manage_entities_in_engine("despawn", payload=despawn_filter)
                                
                            modify_list = world_state_data.get("modify_entities")
                            if modify_list and isinstance(modify_list, list):
                                scrubbed_modify = []
                                for m in modify_list:
                                    if isinstance(m, dict):
                                        sm = m.copy()
                                        if "radius" in sm: sm["radius"] = clean_float(sm["radius"], 1.0)
                                        if "speed" in sm: sm["speed"] = clean_float(sm["speed"], 0.0)
                                        scrubbed_modify.append(sm)
                                await manage_entities_in_engine("modify", payload=scrubbed_modify)
                                
                            modify_player_req = world_state_data.get("modify_player")
                            if modify_player_req:
                                logger.info(f"Modifying player: {modify_player_req}")
                                await manage_entities_in_engine("update_player", payload=modify_player_req)
                            
                            modify_weapon_req = world_state_data.get("modify_weapon")
                            if modify_weapon_req:
                                logger.info(f"Modifying weapons: {modify_weapon_req}")
                                
                                proj_count = modify_weapon_req.get("projectile_count")
                                if proj_count is not None:
                                    try:
                                        proj_count = int(proj_count)
                                    except (ValueError, TypeError):
                                        proj_count = 1

                                weapon_payload = {
                                    "action": "set_weapon",
                                    "projectile_count": proj_count,
                                    "projectile_color": modify_weapon_req.get("projectile_color"),
                                    "spread": clean_float(modify_weapon_req.get("spread", 0.1), 0.1)
                                }
                                await manage_entities_in_engine("api/command", payload=weapon_payload)
                            
                            # 4.6. Apply Global Behavior Policy
                            # Note: Rust engine now handles this automatically via the shared WorldState components 
                            # if behavior_policy is set. We no longer need to fetch IDs and manually modify them.
                            if policy := world_state_data.get("behavior_policy"):
                                logger.info(f"Applying Global Behavior Policy from state: {policy}")
                            
                            # Update session player position if the LLM commanded a move
                            if engine_synced:
                                new_px = world_state_data.get("player_x")
                                new_py = world_state_data.get("player_y")
                                if new_px is not None:
                                    current_player_x = float(new_px)
                                if new_py is not None:
                                    current_player_y = float(new_py)
                                logger.info(f"Player position updated to ({current_player_x}, {current_player_y})")

                            if world_state_data.get("mission_complete") is True:
                                logger.info("Mission Commander Override Triggered. Sending next-level command to Rust Engine.")
                                try:
                                    async with httpx.AsyncClient() as client:
                                        await client.post(f"{RUST_ENGINE_URL}/api/engine/next-level", timeout=5.0)
                                except Exception as e:
                                    logger.error(f"Failed to force advance level: {e}")

                            if world_state_data.get("reset_to_defaults") is True:
                                logger.info("Resetting Engine Defaults!")
                                try:
                                    async with httpx.AsyncClient() as client:
                                        await client.post(f"{RUST_ENGINE_URL}/api/engine/reset", timeout=5.0)
                                except Exception as e:
                                    logger.error(f"Failed to reset defaults: {e}")

                            # Dispatch physics overrides to /api/physics
                            physics_ovr = world_state_data.get("physics_overrides")
                            if physics_ovr and isinstance(physics_ovr, dict):
                                logger.info(f"[Physics Override] {physics_ovr}")
                                await manage_entities_in_engine("api/physics", payload=physics_ovr)

                            # Dispatch faction diplomacy changes to /api/factions
                            faction_updates = world_state_data.get("faction_relations")
                            if faction_updates and isinstance(faction_updates, list) and len(faction_updates) > 0:
                                logger.info(f"[Faction Diplomacy] {faction_updates}")
                                await manage_entities_in_engine("api/factions", payload=faction_updates)

                            # Sync planet_scale_overrides → Rust physics collision radii
                            # Base radii match the frontend getPlanetRadius() function.
                            PLANET_BASE_RADII = {
                                "Sun": 1500.0, "Mercury": 120.0, "Venus": 255.0,
                                "Earth": 300.0, "Mars": 180.0, "Jupiter": 750.0,
                                "Saturn": 630.0, "Uranus": 420.0, "Neptune": 390.0,
                                "Luna": 80.0, "Phobos": 25.0, "Deimos": 18.0,
                                "Io": 200.0, "Europa": 180.0, "Titan": 250.0,
                            }
                            vc = world_state_data.get("visual_config")
                            _so_raw = (vc.get("planet_scale_overrides") if isinstance(vc, dict) else None)
                            scale_overrides: dict = _so_raw if isinstance(_so_raw, dict) else {}
                            if scale_overrides:
                                async with httpx.AsyncClient() as client:
                                    for planet_name, scale in scale_overrides.items():
                                        base_r = PLANET_BASE_RADII.get(planet_name)
                                        if base_r:
                                            new_r = base_r * scale
                                            try:
                                                await client.post(
                                                    f"{RUST_ENGINE_URL}/set-planet-radius",
                                                    json={"name": planet_name, "radius": new_r},
                                                    timeout=3.0
                                                )
                                                logger.info(f"[PlanetRadius] {planet_name} collision radius → {new_r:.1f}")
                                            except Exception as e:
                                                logger.warning(f"[PlanetRadius] Failed to sync {planet_name}: {e}")

                            # 5. Send Unified Generation Payload (text + audio + world state arrive together)
                            payload = {
                                "type": "generation_result",
                                "engine_synced": engine_synced,
                                "world_state": world_state_data,
                                "text": conversational_reply,  # Bundled so chat text appears with audio
                            }
                            if audio_url:
                                payload["audio_url"] = audio_url
                            if audio_b64:
                                payload["audio_b64"] = audio_b64
                            await websocket.send_json(payload)
                            await websocket.send_json({"msg_type": "status", "state": "idle"})
                            
                        except Exception as e:
                            logger.error(f"LangChain LLM or Generation Error: {e}")
                            # Tier 0 Narrative Fallback — Rachel stays in character, never fakes success.
                            err_str = str(e).lower()
                            is_rate_limit = any(k in err_str for k in (
                                "429", "resource_exhausted", "too many requests",
                                "quota", "rate limit", "rate_limit",
                            ))
                            is_network_err = any(k in err_str for k in (
                                "timeout", "timed out", "503", "504", "connect",
                                "network", "unreachable", "disconnect", "eof",
                                "connection reset", "bad gateway",
                            ))
                            if is_rate_limit:
                                err_reply = (
                                    "Pilot, my neural cores are overloaded. "
                                    "Give me a moment to recover and try again."
                                )
                            elif is_network_err:
                                err_reply = (
                                    "Pilot, my uplink to the processing core is severed. "
                                    "I am currently disconnected and cannot execute overrides."
                                )
                            else:
                                err_reply = (
                                    "I do not have the clearance or the tools equipped "
                                    "to perform that action."
                                )
                            logger.warning(f"[Tier-0 Fallback] {err_reply}")
                            audio_url, audio_b64 = await TTSManager.generate_speech(err_reply)
                            if audio_url or audio_b64:
                                payload = {
                                    "type": "proactive_audio",
                                    "text": err_reply,
                                }
                                if audio_url:
                                    payload["audio_url"] = audio_url
                                if audio_b64:
                                    payload["audio_b64"] = audio_b64
                                await websocket.send_json(payload)
                            else:
                                await websocket.send_json({
                                    "type": "text",
                                    "content": err_reply,
                                })
                            await websocket.send_json({"msg_type": "status", "state": "idle"})
                    else:
                        # Fallback mock
                        await websocket.send_json({
                            "type": "text",
                            "content": f"I hear you say: '{transcript}'. Let it be done."
                        })
                        await websocket.send_json({"msg_type": "status", "state": "idle"})

                    # Clear buffer for the next recording
                    audio_buffer.clear()
                    
    except WebSocketDisconnect:
        logger.info("Client disconnected from the Void.")
    except Exception as e:
        logger.error(f"WebSocket Error: {e}")
    finally:
        if websocket in active_connections:
            active_connections.remove(websocket)
        if dream_memory in _active_session_memories:
            _active_session_memories.remove(dream_memory)
