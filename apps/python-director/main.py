import os
import json
import asyncio
import logging
import tempfile
import base64
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List, Literal
import urllib.parse
import random
from collections import deque
from dotenv import load_dotenv
import faiss
from sentence_transformers import SentenceTransformer
from pathlib import Path

# Load .env from the project root directory (c:\Project\.env)
dotenv_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env')
if not os.path.exists(dotenv_path):
    print("\n" + "="*50)
    print("CRITICAL WARNING: .env FILE NOT FOUND AT:")
    print(dotenv_path)
    print("="*50 + "\n")
else:
    print(f"Loaded .env file from: {dotenv_path}")

load_dotenv(dotenv_path)
# LangChain and Groq
from groq import AsyncGroq
from langchain_groq import ChatGroq
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from langchain_core.exceptions import OutputParserException
from langchain_google_genai import ChatGoogleGenerativeAI


# Configure logging
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

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
    print("\n" + "="*50)
    print("CRITICAL WARNING: ELEVENLABS_API_KEY is missing or empty in the .env file!")
    print("="*50 + "\n")
else:
    print(f"[DEBUG] ELEVENLABS_API_KEY starts with: {ELEVENLABS_API_KEY[:4]}... (Length: {len(ELEVENLABS_API_KEY)})")
VOICE_ID = "21m00Tcm4TlvDq8ikWAM" # Standard Rachel pre-made voice ID, guaranteed accessible on free tier

async def generate_speech(text: str) -> Optional[str]:
    """Generates TTS audio via ElevenLabs and returns base64 encoded string."""
    if not ELEVENLABS_API_KEY:
        logger.warning("ELEVENLABS_API_KEY not set. Skipping voice generation.")
        return None
        
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}?output_format=mp3_44100_128"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
    }
    payload = {
        "text": text,
        "model_id": "eleven_turbo_v2_5", # Turbo is better supported on free tier and is much faster
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.5
        }
    }
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=headers, timeout=10.0)
            response.raise_for_status()
            audio_bytes = response.content
            return base64.b64encode(audio_bytes).decode('utf-8')
    except Exception as e:
        logger.error(f"ElevenLabs TTS Error: {e}")
        return None

async def sync_with_engine(state_data: dict) -> bool:
    """Pushes the new WorldState to the Rust Core Engine non-blockingly."""
    try:
        url = "http://127.0.0.1:8080/state"
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=state_data, timeout=5.0)
            if response.status_code == 200:
                logger.info("Successfully synced state with Rust Engine.")
                return True
            else:
                logger.warning(f"Rust Engine returned status: {response.status_code}")
                return False
    except httpx.RequestError as e:
        logger.warning(f"Failed to connect to Rust Engine: {e}")
        return False

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
        url = "http://127.0.0.1:8080/spawn"
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

async def manage_entities_in_engine(endpoint: str, payload: Any = None) -> bool:
    """Sends lifecycle management requests to `/clear`, `/despawn`, or `/modify`."""
    if endpoint == "modify" and isinstance(payload, list):
        # Drop modify requests missing the required `id` field
        payload = [p for p in payload if "id" in p]
        if not payload:
            return True
            
    try:
        url = f"http://127.0.0.1:8080/{endpoint}"
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
    radius: float = Field(..., description="Radius of the anomaly's effect/event horizon.")
    x: float
    y: float

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

class ModifyPlayer(BaseModel):
    model_type: Optional[str] = Field(None, description="'ufo', 'fighter', or 'stealth'")
    color: Optional[str] = Field(None, description="Hex color or CSS color name")

telemetry_buffer = deque(maxlen=10)

# Shared World State Schema mapped to JSON
# Shared World State Schema mapped to JSON

class RealityOverride(BaseModel):
    sun_color: Optional[str] = Field(description="Hex color for the Sun and main point light")
    ambient_color: Optional[str] = Field(description="Hex color for the ambient environment light")
    gravity_multiplier: Optional[float] = Field(description="Multiplier for black hole/sun gravity (default 1.0)")
    player_speed_multiplier: Optional[float] = Field(description="Multiplier for player WASD speed (default 1.0)")
    global_friction: Optional[float] = Field(description="Friction for steering agents. Normal is 0.95. Lower means more slippery.")

class WeaponOverride(BaseModel):
    projectile_count: Optional[int] = Field(None, description="Number of projectiles fired at once (1, 2, 3, or 5).")
    projectile_color: Optional[str] = Field(None, description="Hex color or CSS color name for lasers.")
    spread: Optional[float] = Field(None, description="Spread angle between projectiles (0.05 to 0.5).")

class WorldState(BaseModel):
    summary: str = Field(..., description="A short 3-word summary of the current world")
    environment_theme: str = Field(..., description="The holistic theme of the world (e.g. 'Cyberpunk City', 'Deep Ocean').")
    terrain_rules: str = Field(..., description="Rules for the procedural ground grid (e.g. 'Sharp peaks, unstable ground', 'Flat grid with scattered pillars').")
    physics_mode: str = Field(..., description="The generative physics state for ECS entities. MUST be exactly one of: 'static', 'orbital', 'sinusoidal', or 'chaos'.")
    conversational_reply: str = Field(..., description="The Dream Architect's short, cinematic response to the user's speech. This is spoken back to the user to buy time while rendering. (e.g. 'Conjuring a cyberpunk skyline...')")
    entities: Dict[str, Any] = Field(default_factory=dict, description="Active ECS entities like characters, objects, and environment markers.")
    player_x: Optional[float] = Field(None, description="New absolute X coordinate for the Player entity. Only include when the user requests movement. Origin (0,0) is screen center. Range: approx -400 to +400. X+ is right.")
    player_y: Optional[float] = Field(None, description="New absolute Y coordinate for the Player entity. Only include when the user requests movement. Origin (0,0) is screen center. Range: approx -400 to +400. Y+ is down.")
    spawn_entities: Optional[List[SpawnEntity]] = Field(None, description="List of new entities to birth into the world. Max 20. Omit if none requested.")
    clear_world: Optional[bool] = Field(False, description="Set to true to delete all entities (except the player).")
    despawn_entities: Optional[DespawnFilter] = Field(None, description="Filter for removing specific existing entities.")
    modify_entities: Optional[List[ModifyEntity]] = Field(None, description="Changes to apply to existing entities (DO NOT respawn them).")
    behavior_policy: Optional[str] = Field("idle", description="Global behavior strategy affecting steering. 'idle', 'swarm', 'attack', 'protect', or 'scatter'.")
    spawn_anomalies: Optional[List[Anomaly]] = Field(None, description="Spatial anomalies to drop into the world. Max 5. Omit if none requested.")
    reality_override: Optional[RealityOverride] = Field(None, description="Visual and physical overrides for the world reality.")
    modify_player: Optional[ModifyPlayer] = Field(None, description="Change the player's ship model or color. Example: {'model_type': 'stealth', 'color': 'red'}")
    modify_weapon: Optional[WeaponOverride] = Field(None, description="Override the player's weapon parameters. Use this to respond to requests about weapon upgrades, laser colors, or shot count.")

class DreamMemory:
    def __init__(self):
        try:
            # We use a lightweight model suitable for small rapid embeddings
            self.encoder = SentenceTransformer('all-MiniLM-L6-v2')
            self.dim = self.encoder.get_sentence_embedding_dimension()
            self.index = faiss.IndexFlatL2(self.dim)
            self.memory_store = []
            logger.info("DreamMemory (FAISS) initialized successfully.")
            self._load_engine_capabilities()
        except Exception as e:
            logger.error(f"Failed to initialize DreamMemory: {e}")
            self.encoder = None

    def _load_engine_capabilities(self):
        try:
            kb_path = Path(__file__).parent / "data" / "engine_capabilities.md"
            if kb_path.exists():
                text = kb_path.read_text("utf-8")
                # Split by headers for simple chunking
                chunks = text.split("##")
                for chunk in chunks:
                    chunk = chunk.strip()
                    if chunk:
                        self.add_text_memory(f"## {chunk}")
                logger.info(f"Loaded engine capabilities from {kb_path}")
            else:
                logger.warning(f"Engine capabilities not found at {kb_path}")
        except Exception as e:
            logger.error(f"Failed to load engine capabilities: {e}")

    def add_text_memory(self, text: str):
        if not self.encoder:
            return
        self.memory_store.append(text)
        embedding = self.encoder.encode([text], convert_to_numpy=True)
        self.index.add(embedding)

    def add_memory(self, state_json: dict):
        if not self.encoder:
            return
        summary = state_json.get("summary", "")
        # Graceful fallback for legacy states
        theme = state_json.get("environment_theme") or state_json.get("visual_prompt") or "Cyberpunk"
        terrain = state_json.get("terrain_rules") or "Standard Grid"
        text = f"State: {summary}. Theme: {theme}. Terrain: {terrain}."
        self.memory_store.append(text)
        embedding = self.encoder.encode([text], convert_to_numpy=True)
        self.index.add(embedding)

    def get_relevant_context(self, query: str, k: int = 3) -> str:
        if not self.encoder or self.index.ntotal == 0:
            return "No previous memories."
        k = min(k, self.index.ntotal)
        query_emb = self.encoder.encode([query], convert_to_numpy=True)
        D, I = self.index.search(query_emb, k)
        results = [self.memory_store[i] for i in I[0] if i != -1 and i < len(self.memory_store)]
        return "\n".join(results)

# Initialize LangChain LLM with fallback chain for production-grade reliability
try:
    if groq_api_key or os.getenv("GOOGLE_API_KEY"):
        # Setup Fallback Chain
        primary_llm = ChatGroq(model="llama-3.3-70b-versatile", temperature=0.7)
        fallback_groq = ChatGroq(model="llama-3.1-8b-instant", temperature=0.7)
        # Use a high-quality, high-rate-limit fallback like Gemini 2.0 Flash
        fallback_gemini = ChatGoogleGenerativeAI(model="gemini-2.0-flash", temperature=0.7)
        
        # Combined chain with fallbacks
        llm = primary_llm.with_fallbacks([fallback_groq, fallback_gemini])
        
        parser = JsonOutputParser(pydantic_object=WorldState)

        system_prompt = """You are Rachel, an AI Director. Two modes:
1. CONVERSATIONAL: Chat using `conversational_reply`.
2. ENGINE: Spawn entities/shifters based on RAG context ONLY. No hallucinations.

### SOLAR SYSTEM (Permanent)
Sun (0,0,0) + 8 planets.

### OUTPUT (Strict JSON)
- "summary": 1-sentence recap.
- "conversational_reply": Witty response.
- "behavior_policy": 'idle', 'swarm', 'attack', 'protect', 'scatter'.
- "modify_weapon": {{ "projectile_count": int, "projectile_color": hex, "spread": float }}.
- "player_spaceship": 'ufo', 'fighter', 'stealth', 'freighter'.
- "spawn_entities": [ {{ "ent_type": str, "x": float, "y": float, "physics": "orbital", "faction": str }} ].
- "reality_override": {{ "sun_color": hex, "ambient_color": hex, "gravity_multiplier": float, "player_speed_multiplier": float }}.

### CONTEXT
Knowledge: {retrieved_knowledge}
State: {previous_state}
Pos: ({current_player_x}, {current_player_y})
History: {past_world_history}
Telemetry: {recent_telemetry}

Prompt: {user_input}"""

        prompt = ChatPromptTemplate.from_messages([
            ("system", system_prompt),
            ("user", "Format Instructions: {format_instructions}")
        ])

        world_chain = prompt | llm | parser
    else:
        world_chain = None

except Exception as e:
    logger.error(f"Failed to initialize LangChain: {e}")
    world_chain = None


@app.get("/")
async def root():
    return {"status": "The Director is alive."}

async def trigger_game_over_reaction(event_dict: dict):
    """Rachel reacts to the player's death with a dramatic, cinematic TTS broadcast."""
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

        audio_b64 = await generate_speech(reaction_text)

        payload = {
            "type": "proactive_audio",
            "audio_b64": audio_b64,
            "text": reaction_text,
        }
        for connection in active_connections:
            try:
                await connection.send_json(payload)
            except Exception as e:
                logger.error(f"Failed to send game-over audio: {e}")

    except Exception as e:
        logger.error(f"Game-over reaction failed: {e}")


async def trigger_proactive_reaction(event_dict: dict):
    if not groq_client or not active_connections:
        return
        
    kill_count = event_dict.get('count', 0)
    cause = event_dict.get('cause', 'unknown')
    
    prompt = f"The engine just reported {kill_count} entities were destroyed by a {cause}. Generate a very brief, cool, 1-sentence in-character reaction to this event (e.g., 'Sector cleared', 'Massive anomaly detected'). Do not spawn anything, just react."
    
    try:
        # 1. Fast LLM Generation
        response = await groq_client.chat.completions.create(
            messages=[
                {"role": "system", "content": "You are Rachel, a terse, cinematic AI Director."},
                {"role": "user", "content": prompt}
            ],
            model="llama-3.3-70b-versatile",
            temperature=0.8,
            max_tokens=60
        )
        reaction_text = response.choices[0].message.content.strip()
        logger.info(f"Proactive Reaction Generated: {reaction_text}")
        
        # 2. TTS Generation
        audio_b64 = await generate_speech(reaction_text)
        
        if audio_b64:
            # 3. Broadcast to all active clients
            payload = {
                "type": "proactive_audio",
                "audio_b64": audio_b64,
                "text": reaction_text
            }
            for connection in active_connections:
                try:
                    await connection.send_json(payload)
                except Exception as e:
                    logger.error(f"Failed to send proactive audio to a client: {e}")
                    
    except Exception as e:
        logger.error(f"Proactive generation failed: {e}")


@app.post("/engine_telemetry")
async def receive_telemetry(event: TelemetryEvent):
    event_dict = event.dict()
    telemetry_buffer.append(event_dict)
    logger.info(f"Received Engine Telemetry: {event_dict}")
    
    # Check for significant events to trigger a proactive reaction
    if event.event_type == "game_over":
        # Immediate, dramatic death reaction — highest priority
        asyncio.create_task(trigger_game_over_reaction(event_dict))
    elif event.event_type == "anomaly_kill" and event.count >= 10:
        asyncio.create_task(trigger_proactive_reaction(event_dict))
    elif event.event_type == "combat_kill" and event.count >= 1:
        asyncio.create_task(trigger_proactive_reaction(event_dict))

    return {"status": "ok"}

@app.websocket("/api/v1/dream-stream")
async def dream_stream(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    logger.info("Client connected to the Void.")
    
    # Session state memory for Evolution over Overwrite
    previous_state = "Empty Void. No entities."
    dream_memory = DreamMemory()
    chat_history: List[Dict[str, str]] = []
    # Track player position for relative movement commands
    current_player_x: float = 0.0
    current_player_y: float = 0.0

    # --- World Persistence: Load snapshot if it exists ---
    snapshot_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        "world_snap.json"
    )
    if os.path.exists(snapshot_path):
        try:
            with open(snapshot_path, "r") as f:
                snap = json.load(f)
            logger.info(f"Loaded world snapshot from {snapshot_path} ({len(snap.get('entities', []))} entities)")

            # Pre-seed FAISS with the snapshot context
            entity_counts: Dict[str, int] = {}
            for ent in snap.get("entities", []):
                t = ent.get("ent_type", "unknown")
                entity_counts[t] = entity_counts.get(t, 0) + 1
            entity_summary = ", ".join(f"{count} {etype}(s)" for etype, count in entity_counts.items())

            # Safe fallback for legacy snapshots
            env_theme = snap.get("environment_theme") or snap.get("visual_prompt") or "Cyberpunk"
            terrain = snap.get("terrain_rules") or "Standard Grid"

            snap_text = (
                f"Saved Galaxy State — Summary: {snap.get('summary', 'N/A')}. "
                f"Theme: {env_theme}. "
                f"Physics: {snap.get('physics_mode', 'static')}. "
                f"Entities: {entity_summary}."
            )
            dream_memory.add_memory({
                "summary": snap.get("summary", ""),
                "environment_theme": env_theme,
                "terrain_rules": terrain,
            })

            # Set previous_state so the LLM has immediate context
            previous_state = json.dumps({
                "summary": snap.get("summary"),
                "environment_theme": env_theme,
                "terrain_rules": terrain,
                "physics_mode": snap.get("physics_mode"),
                "entities": entity_counts,
            })
            logger.info(f"FAISS pre-seeded with snapshot: {snap_text}")
        except Exception as e:
            logger.warning(f"Failed to load world snapshot: {e}")
    else:
        logger.info("No world_snap.json found. Starting from empty void.")
    
    await websocket.send_json({
        "type": "text", 
        "content": "Dream Architect online. Describe your world."
    })

    audio_buffer = bytearray()

    try:
        while True:
            message = await websocket.receive()
            
            if "bytes" in message:
                audio_buffer.extend(message["bytes"])
                
            elif "text" in message:
                data = json.loads(message["text"])
                msg_type = data.get("type")

                if msg_type == "player_pos":
                    current_player_x = float(data.get("x", 0.0))
                    current_player_y = float(data.get("y", 0.0))
                    continue
                
                transcript = ""
                should_process_pipeline = False
                
                if msg_type == "text_command":
                    transcript = data.get("text", "").strip()
                    logger.info(f"Manual Text Override Received: {transcript}")
                    if transcript:
                        should_process_pipeline = True
                        await websocket.send_json({
                            "type": "text", 
                            "content": "Processing text override..."
                        })
                        
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
                        should_process_pipeline = True
                        await websocket.send_json({"type": "transcript", "content": transcript})
                    else:
                        logger.warning("Empty transcript or STT failure. Skipping LLM generation.")
                
                if should_process_pipeline:
                    await websocket.send_json({"msg_type": "status", "state": "synthesizing"})
                    # 2. Generate JSON World State via LangChain Agent
                    if world_chain:
                        logger.info("Generating World State schema...")
                        try:
                            retrieved_knowledge = dream_memory.get_relevant_context(transcript, k=5)
                            past_world_history = "\n".join([f"{msg['role']}: {msg['content']}" for msg in chat_history[-10:]]) if chat_history else "No previous memories."
                            telemetry_str = "\n".join([json.dumps(e) for e in telemetry_buffer]) if telemetry_buffer else "No recent physics anomalies."

                            try:
                                world_state_data = await world_chain.ainvoke({
                                    "retrieved_knowledge": retrieved_knowledge,
                                    "previous_state": previous_state,
                                    "past_world_history": past_world_history,
                                    "recent_telemetry": telemetry_str,
                                    "user_input": transcript,
                                    "format_instructions": parser.get_format_instructions(),
                                    "current_player_x": current_player_x,
                                    "current_player_y": current_player_y,
                                })
                            except OutputParserException as e:
                                logger.error(f"LLM hallucinated invalid entity type: {e}")
                                error_msg = "I tried to process that, but my engine constraints prevent it. Please request a valid entity."
                                await websocket.send_json({"type": "text", "content": error_msg})
                                audio_b64 = await generate_speech(error_msg)
                                if audio_b64:
                                    await websocket.send_json({"type": "proactive_audio", "audio_b64": audio_b64, "text": error_msg})
                                await websocket.send_json({"msg_type": "status", "state": "idle"})
                                continue

                            chat_history.append({"role": "user", "content": transcript})
                            chat_history.append({"role": "Rachel", "content": world_state_data.get("conversational_reply", "")})
                            
                            dream_memory.add_memory(world_state_data)
                            
                            # Cache the result as stringified JSON for the next loop
                            previous_state = json.dumps(world_state_data)
                            
                            logger.info(f"LLM Generated World State: {json.dumps(world_state_data, indent=2)}")

                            # 3. Co-Creation Loop conversational response text (sent instantly)
                            conversational_reply = world_state_data.get("conversational_reply", "The world is shifting...")
                            await websocket.send_json({
                                "type": "text", 
                                "content": conversational_reply
                            })
                            
                            # Transmit the underlying JSON schema to React
                            await websocket.send_json({
                                "type": "world_state",
                                "content": world_state_data
                            })

                            # 4. Neural Generation Pipeline (Run TTS Concurrently with Engine Sync)
                            logger.info("Executing concurrent TTS and Engine Sync...")
                            await websocket.send_json({"msg_type": "status", "state": "orchestrating"})
                            
                            # Fire generative requests simultaneously
                            audio_b64_task = generate_speech(conversational_reply)
                            engine_sync_task = sync_with_engine(world_state_data) # Sync with Rust ECS
                            
                            audio_b64, engine_synced = await asyncio.gather(audio_b64_task, engine_sync_task)
                            
                            # 4.5. Trigger /spawn and lifecycle endpoints if LLM requested them
                            spawn_requests = world_state_data.get("spawn_entities", [])
                            spawn_anomalies = world_state_data.get("spawn_anomalies", [])
                            
                            combined_spawns = spawn_requests.copy() if spawn_requests else []
                            
                            if spawn_anomalies:
                                for anomaly in spawn_anomalies:
                                    if isinstance(anomaly, dict):
                                        combined_spawns.append({
                                            "ent_type": "anomaly",
                                            "x": anomaly.get("x", 0.0),
                                            "y": anomaly.get("y", 0.0),
                                            "physics": "static",
                                            "anomaly_type": anomaly.get("anomaly_type", "black_hole"),
                                            "mass": float(anomaly.get("mass", 5000.0)),
                                            "radius": float(anomaly.get("radius", 50.0))
                                        })

                            if combined_spawns:
                                await spawn_entities_in_engine(combined_spawns)
                            
                            if world_state_data.get("clear_world"):
                                await manage_entities_in_engine("clear")
                            
                            despawn_filter = world_state_data.get("despawn_entities")
                            if despawn_filter:
                                await manage_entities_in_engine("despawn", payload=despawn_filter)
                                
                            modify_list = world_state_data.get("modify_entities")
                            if modify_list:
                                await manage_entities_in_engine("modify", payload=modify_list)
                                
                            modify_player_req = world_state_data.get("modify_player")
                            if modify_player_req:
                                logger.info(f"Modifying player: {modify_player_req}")
                                await manage_entities_in_engine("update_player", payload=modify_player_req)
                            
                            modify_weapon_req = world_state_data.get("modify_weapon")
                            if modify_weapon_req:
                                logger.info(f"Modifying weapons: {modify_weapon_req}")
                                weapon_payload = {
                                    "action": "set_weapon",
                                    "projectile_count": modify_weapon_req.get("projectile_count"),
                                    "projectile_color": modify_weapon_req.get("projectile_color"),
                                    "spread": modify_weapon_req.get("spread")
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

                            # 5. Send Unified Generation Payload (Visuals now handled by Rust)
                            await websocket.send_json({
                                "type": "generation_result",
                                "audio_b64": audio_b64,
                                "engine_synced": engine_synced,
                                "world_state": world_state_data
                            })
                            await websocket.send_json({"msg_type": "status", "state": "idle"})
                            
                        except Exception as e:
                            logger.error(f"LangChain LLM or Generation Error: {e}")
                            await websocket.send_json({
                                "type": "text",
                                "content": "The Architect's connection is unstable."
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
