import React, { useState, useEffect, useRef, useCallback } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { Activity, Server, Mic, MicOff, Save, Volume2, VolumeX, Trash2 } from 'lucide-react';
import { Canvas } from '@react-three/fiber';
import { GameScene } from './components/GameScene';
import { HUD } from './components/HUD';
import { ChatLog, ChatMessage } from './components/ChatLog';

const WS_URL = 'ws://127.0.0.1:8000/api/v1/dream-stream';

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [directorMessage, setDirectorMessage] = useState<string>("Awaiting connection to The Void...");
  const [worldState, setWorldState] = useState<any>(null);
  const [engineSynced, setEngineSynced] = useState<boolean>(false);
  const [textInput, setTextInput] = useState("");
  const [aiState, setAiState] = useState<"idle" | "synthesizing" | "orchestrating">("idle");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);

  const { sendMessage, lastMessage, readyState } = useWebSocket(WS_URL, {
    shouldReconnect: () => true,
    reconnectInterval: 3000,
  });

  // ECS WebSocket connection
  useEffect(() => {
    console.log('Attempting connection to Rust on 8081...');
  }, []);
  const { lastMessage: ecsMessage, sendMessage: sendEcsMessage, readyState: ecsReadyState } = useWebSocket('ws://127.0.0.1:8081/ws', {
    shouldReconnect: () => true,
    reconnectInterval: 500,
    onOpen: () => console.log('CONNECTED TO RUST ENGINE!'),
    onError: (e) => console.error('Rust engine connection error:', e),
  });

  // Player Input Stream
  const activeKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in the chat input
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;

      const key = e.code;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(key)) {
        if (!activeKeysRef.current.has(key)) {
          activeKeysRef.current.add(key);
          const payload = { msg_type: 'player_input', keys: Array.from(activeKeysRef.current) };
          console.log('[INPUT SEND] KeyDown:', key, payload);
          sendEcsMessage(JSON.stringify(payload));
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.code;
      if (activeKeysRef.current.has(key)) {
        activeKeysRef.current.delete(key);
        const payload = { msg_type: 'player_input', keys: Array.from(activeKeysRef.current) };
        console.log('[INPUT SEND] KeyUp:', key, payload);
        sendEcsMessage(JSON.stringify(payload));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [sendEcsMessage]);

  const [ecsEntities, setEcsEntities] = useState<Record<string, any>>({});
  const ecsEntitiesRef = useRef<Record<string, any>>({});
  const [particles, setParticles] = useState<any[]>([]);
  const particlesRef = useRef<any[]>([]);
  const [zoom, setZoom] = useState(1.0);
  const [isShaking, setIsShaking] = useState(false);
  const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentZoomRef = useRef(1.0);
  const shakeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveToast, setSaveToast] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isRachelEnabled, setIsRachelEnabled] = useState(true);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // ── Survival HUD state ──────────────────────────────────────────────────
  const [playerHealth, setPlayerHealth] = useState(100);
  const [score, setScore] = useState(0);
  const [currentLevel, setCurrentLevel] = useState(1);
  const [objective, setObjective] = useState("");
  const [isGameOver, setIsGameOver] = useState(false);
  const [showDamageFlash, setShowDamageFlash] = useState(false);
  const [showSuccessFlash, setShowSuccessFlash] = useState(false);
  const prevHealthRef = useRef(100);
  const damageFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track entities that just spawned to trigger the birth glow animation
  const [newbornIds, setNewbornIds] = useState<Set<number>>(new Set());
  // Track dying entities for implosion animation
  const [dyingIds, setDyingIds] = useState<Set<number>>(new Set());

  // Initialize AudioContext on first user interaction (browser autoplay policy)
  const initAudio = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      console.log('AudioContext initialized');
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
  }, []);

  // Generative collision sound: sine+sawtooth oscillator pulse
  const playCollisionSound = useCallback((speed: number, distance: number) => {
    if (isMuted || !audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') return;

    const now = ctx.currentTime;

    // Map speed (0.2–2.0) → frequency (200–1200 Hz)
    const freq = 200 + Math.min(speed / 2.0, 1.0) * 1000;

    // Map distance (0–20) → gain (1.0 close → 0.15 far)
    const gain = Math.max(0.15, 1.0 - (distance / 20.0) * 0.85) * 0.25;

    // Primary sine oscillator
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(freq, now);
    osc1.frequency.exponentialRampToValueAtTime(freq * 0.5, now + 0.15);

    // Harmonic sawtooth layer for grit
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(freq * 1.5, now);
    osc2.frequency.exponentialRampToValueAtTime(freq * 0.3, now + 0.12);

    // Envelope
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(gain, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    const sawGain = ctx.createGain();
    sawGain.gain.setValueAtTime(gain * 0.3, now);
    sawGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc1.connect(gainNode).connect(ctx.destination);
    osc2.connect(sawGain).connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.2);
    osc2.start(now);
    osc2.stop(now + 0.15);
  }, [isMuted]);

  const handleSave = async () => {
    initAudio(); // ensure AudioContext is alive on any user click
    try {
      const res = await fetch('http://127.0.0.1:8080/save', { method: 'POST', mode: 'cors' });
      if (res.ok) {
        console.log('Universe saved to disk!');
        setSaveToast(true);
        setTimeout(() => setSaveToast(false), 3000);
      } else {
        console.error('Save failed:', res.status);
      }
    } catch (err) {
      console.error('Save request error:', err);
    }
  };

  const handleClearWorld = async () => {
    try {
      await fetch('http://127.0.0.1:8080/clear', {
        method: 'POST',
        mode: 'cors',
      });
    } catch (err) {
      console.error('Clear failed:', err);
    }
  };

  // Debounced Camera Zoom via scroll wheel
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(prev => {
        const next = Math.max(0.5, Math.min(5.0, prev - e.deltaY * 0.001));
        return next;
      });
    };
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, []);

  // Sync zoom to Rust engine with debouncing (100ms + 0.05 threshold)
  useEffect(() => {
    if (Math.abs(zoom - lastSentZoomRef.current) < 0.05) return;
    if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current);
    zoomDebounceRef.current = setTimeout(() => {
      lastSentZoomRef.current = zoom;
      fetch('http://127.0.0.1:8080/state', {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: worldState?.summary || 'The engine awakens',
          environment_theme: worldState?.environment_theme || 'Dark Neon Grid',
          terrain_rules: worldState?.terrain_rules || 'Flat digital plane',
          physics_mode: worldState?.physics_mode || 'static',
          camera_zoom: Math.round(zoom * 100) / 100, // clean float
        }),
      })
        .then(res => { if (res.ok) console.log('State Sync Success!'); })
        .catch(err => console.warn('Zoom sync failed:', err));
    }, 100);
  }, [zoom, worldState]);

  // Audio and recording state handlers remain unchanged


  // Handle incoming ECS updates
  useEffect(() => {
    if (ecsMessage !== null) {
      if (!(window as any)._loggedRawEcsMessage) {
        console.log("[RAW ECS MESSAGE]", ecsMessage.data);
        (window as any)._loggedRawEcsMessage = true;
      }
      try {
        const data = JSON.parse(ecsMessage.data);
        if (data.type === 'render_frame') {
          // ── Survival data ────────────────────────────────────────────
          if (data.player_health !== undefined) {
            const newHealth = data.player_health as number;
            setPlayerHealth(newHealth);

            // Detect damage: health dropped since last frame
            if (newHealth < prevHealthRef.current && prevHealthRef.current > 0) {
              if (damageFlashTimeoutRef.current) clearTimeout(damageFlashTimeoutRef.current);
              setShowDamageFlash(true);
              damageFlashTimeoutRef.current = setTimeout(() => setShowDamageFlash(false), 550);
            }
            prevHealthRef.current = newHealth;
          }
          if (data.score !== undefined) {
            setScore(data.score as number);
          }
          if (data.current_level !== undefined) {
            setCurrentLevel(data.current_level as number);
          }
          if (data.is_game_over !== undefined) {
            setIsGameOver(data.is_game_over as boolean);
          }
          if (data.objective !== undefined) {
            setObjective(data.objective as string);
          }
          if (data.success_kill === true) {
            if (successFlashTimeoutRef.current) clearTimeout(successFlashTimeoutRef.current);
            setShowSuccessFlash(true);
            successFlashTimeoutRef.current = setTimeout(() => setShowSuccessFlash(false), 400);
          }

          if (data.particles) {
            setParticles(data.particles);
            particlesRef.current = data.particles;

            // If there's a huge surge of particles (e.g. shatter), trigger cinematic shake and audio
            if (data.particles.length > 20 && !document.body.classList.contains('cinematic-shake')) {
              document.body.classList.add('cinematic-shake');
              setTimeout(() => document.body.classList.remove('cinematic-shake'), 600);

              // Play low synthetic shatter/boom
              playCollisionSound(5.0, 10.0); // Abuse collision sound generator for a heavy bass impact
            }
          }
        }
        if (data.type === 'collision_event') {
          // Trigger screen shake for 200ms
          setIsShaking(true);
          if (shakeTimeoutRef.current) clearTimeout(shakeTimeoutRef.current);
          shakeTimeoutRef.current = setTimeout(() => setIsShaking(false), 220);

          // True 3D spatial distance for audio
          const dx = data.dx ?? 0;
          const dy = data.dy ?? 0;
          const dz = data.dz ?? 0;
          const distance3D = (data.dx !== undefined || data.dz !== undefined)
            ? Math.sqrt(dx * dx + dy * dy + dz * dz)
            : (data.distance ?? 10.0);

          // Generative collision audio
          playCollisionSound(data.speed ?? 1.0, distance3D);
        }
        if (data.entities) {
          if (Array.isArray(data.entities)) {
            const entitiesObj: Record<string, any> = {};
            data.entities.forEach((ent: any) => {
              entitiesObj[ent.id] = ent;
            });

            // Print exactly once when we receive our first frame
            if (!(window as any)._loggedFirstFrame) {
              console.log('--- FIRST FRAME RECEIVED ---');
              console.log(`Entities count: ${data.entities.length}`);
              console.log('Entities output:', data.entities);
              (window as any)._loggedFirstFrame = true;
            }

            // ONLY log if the number of entities changes to prevent console spam
            if (Object.keys(ecsEntitiesRef.current).length !== data.entities.length) {
              console.log(`[ECS DEBUG] Received ${data.entities.length} entities from Rust Engine. Keys:`, Object.values(entitiesObj).map(e => e.ent_type));
            }
            ecsEntitiesRef.current = entitiesObj;
            setEcsEntities(entitiesObj);
            if (Object.keys(entitiesObj).length > 0) {
              console.log(`[ECS] Received ${Object.keys(entitiesObj).length} entities from Rust engine`);
            }
          } else {
            ecsEntitiesRef.current = data.entities;
            setEcsEntities(data.entities);
          }

          // Check for newborn and dying entities from the engine
          let hasNew = false;
          let hasDying = false;
          const newIds = new Set(newbornIds);
          const dropIds = new Set(dyingIds);

          data.entities.forEach((ent: any) => {
            if (ent.is_newborn && !newbornIds.has(ent.id)) {
              newIds.add(ent.id);
              hasNew = true;
              // Remove the glow after the 1.2s animation finishes
              setTimeout(() => {
                setNewbornIds(prev => {
                  const s = new Set(prev);
                  s.delete(ent.id);
                  return s;
                });
              }, 1200);
            }
            if (ent.is_dying && !dyingIds.has(ent.id)) {
              dropIds.add(ent.id);
              hasDying = true;
              // Note: Rust removes the entity after 1.0s, so we don't need a rigorous timeout to clean this up,
              // because the entity won't exist in the next tick anyway. But for safety:
              setTimeout(() => {
                setDyingIds(prev => {
                  const s = new Set(prev);
                  s.delete(ent.id);
                  return s;
                });
              }, 1200);
            }
          });
          if (hasNew) setNewbornIds(newIds);
          if (hasDying) setDyingIds(dropIds);
        }
      } catch (err) {
        // ignore parsing errors for tick data
      }
    }
  }, [ecsMessage, playCollisionSound]);

  // Handle incoming WebSocket messages
  useEffect(() => {
    if (lastMessage !== null) {
      try {
        const data = JSON.parse(lastMessage.data);

        if (data.type === 'transcript') {
          // Received back from the Python Director for voice transcriptions
          setChatHistory(prev => [...prev, { sender: 'user', text: data.content, timestamp: new Date() }]);
        } else if (data.type === 'text') {
          // LLM responding to the user
          setDirectorMessage(data.content);
          setChatHistory(prev => [...prev, { sender: 'rachel', text: data.content, timestamp: new Date() }]);
        } else if (data.msg_type === 'status') {
          setAiState(data.state);
        } else if (data.type === 'frame_update') {
          // Legacy frame streaming (Phase 1 mock)
        } else if (data.type === 'world_state') {
          console.log("World State Updated:", data.content);
          setWorldState(data.content);
        } else if (data.type === 'proactive_audio') {
          console.log("Proactive Action Triggered by Engine!");
          setDirectorMessage("Rachel looks on: " + data.text);
          setChatHistory(prev => [...prev, { sender: 'rachel', text: data.text, timestamp: new Date() }]);
          setAiState("synthesizing"); // Re-using valid Loader state Enum

          if (data.audio_b64 && isRachelEnabled) {
            try {
              const audio = new Audio("data:audio/mp3;base64," + data.audio_b64);
              audio.play().catch(e => console.error("Audio playback restricted by browser:", e));
            } catch (err) {
              console.error("Audio initialization failed:", err);
            }
          }
          setTimeout(() => setAiState("idle"), 4000);
        } else if (data.type === 'generation_result') {
          console.log("Received Full Generation Payload!");

          if (data.world_state) {
            setWorldState(data.world_state);
          }
          if (data.engine_synced) {
            setEngineSynced(true);
            setTimeout(() => setEngineSynced(false), 3000); // Briefly flash the synced status
          }
          if (data.audio_b64 && isRachelEnabled) {
            try {
              const audio = new Audio("data:audio/mp3;base64," + data.audio_b64);
              audio.play().catch(e => console.error("Audio playback restricted by browser:", e));
            } catch (err) {
              console.error("Audio initialization failed:", err);
            }
          }
        }
      } catch (err) {
        console.error("Error parsing websocket message", err);
      }
    }
  }, [lastMessage]);

  // Periodically sync player position to the Director for spatial awareness
  useEffect(() => {
    const syncInterval = setInterval(() => {
      // Find the player entity in ecsEntities
      const player = Object.values(ecsEntities).find(ent => ent.ent_type === 'player');
      if (player && readyState === ReadyState.OPEN) {
        sendMessage(JSON.stringify({
          type: 'player_pos',
          x: player.x,
          y: player.y
        }));
      }
    }, 2000); // Every 2 seconds is enough for awareness without flooding
    return () => clearInterval(syncInterval);
  }, [ecsEntities, readyState, sendMessage]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      audioChunks.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = () => {
        const fullBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
        if (readyState === ReadyState.OPEN) {
          // We don't have the transcript yet, but we've finished recording.
          // The transcript will come back via the websocket handled above.
          sendMessage(fullBlob);
          sendMessage(JSON.stringify({ type: 'audio_end' }));
        }
        // Stop the mic tracks
        if (mediaRecorderRef.current && mediaRecorderRef.current.stream) {
          mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
      };

      mediaRecorderRef.current.start(250);
      setIsRecording(true);
      setDirectorMessage('Mic opening...');

      // 500ms lead-in buffer to prevent start clips
      setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          setDirectorMessage('Listening...');
        }
      }, 500);

    } catch (err) {
      console.error("Failed to access microphone:", err);
      setDirectorMessage("Error: Could not access microphone.");
    }
  };

  const stopRecording = () => {
    setDirectorMessage('Adding lead-out buffer...');
    // 500ms lead-out buffer to catch the end of speech
    setTimeout(() => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
      setDirectorMessage('Sending transmission...');
    }, 500);
  };

  const connectionStatus = {
    [ReadyState.CONNECTING]: 'Connecting...',
    [ReadyState.OPEN]: 'Connected to Director',
    [ReadyState.CLOSING]: 'Closing...',
    [ReadyState.CLOSED]: 'Disconnected. Reconnecting...',
    [ReadyState.UNINSTANTIATED]: 'Uninstantiated',
  }[readyState];

  return (
    <>
      {/* Shake + global keyframe style */}
      <style>{`
        @keyframes screen-shake {
          0%   { transform: translate(0, 0) rotate(0deg); }
          20%  { transform: translate(-4px, 3px) rotate(-0.5deg); }
          40%  { transform: translate(4px, -3px) rotate(0.5deg); }
          60%  { transform: translate(-3px, 4px) rotate(-0.3deg); }
          80%  { transform: translate(3px, -2px) rotate(0.3deg); }
          100% { transform: translate(0, 0) rotate(0deg); }
        }
        .shake { animation: screen-shake 0.2s ease-in-out; }
        @keyframes toast-in {
          0%   { opacity: 0; transform: translateY(-12px) scale(0.95); }
          10%  { opacity: 1; transform: translateY(0) scale(1); }
          80%  { opacity: 1; transform: translateY(0) scale(1); }
          100% { opacity: 0; transform: translateY(-8px) scale(0.95); }
        }
        .toast-anim { animation: toast-in 3s ease-in-out forwards; }
        @keyframes newborn-glow {
          0%   { opacity: 0; transform: scale(0.1); filter: brightness(5); }
          40%  { opacity: 1; transform: scale(1.3); filter: brightness(3); }
          100% { opacity: 1; transform: scale(1.0); filter: brightness(1); }
        }
        .newborn { animation: newborn-glow 1.2s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; }
        @keyframes death-implode {
          0%   { opacity: 1; transform: scale(1.0); filter: brightness(1); }
          100% { opacity: 0; transform: scale(0.0); filter: brightness(5); }
        }
        .imploding { animation: death-implode 1.0s cubic-bezier(0.55, 0.085, 0.68, 0.53) forwards; }
        @keyframes attack-pulse {
          0%   { filter: drop-shadow(0 0 8px rgba(239, 68, 68, 0.8)); }
          50%  { filter: drop-shadow(0 0 24px rgba(239, 68, 68, 1.0)); }
          100% { filter: drop-shadow(0 0 8px rgba(239, 68, 68, 0.8)); }
        }
        .behavior-attack { animation: attack-pulse 1s infinite alternate; }
        
        @keyframes protect-shield {
          0%   { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); }
          70%  { box-shadow: 0 0 0 10px rgba(59, 130, 246, 0); }
          100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
        }
        .behavior-protect { animation: protect-shield 2s infinite; outline: 1px solid rgba(59, 130, 246, 0.5); outline-offset: 4px; }
        @keyframes damage-flash {
          0%   { opacity: 1; }
          100% { opacity: 0; }
        }
        @keyframes signal-lost-pulse {
          0%   { opacity: 1; text-shadow: 0 0 40px rgba(239,68,68,0.8), 0 0 80px rgba(239,68,68,0.4); }
          100% { opacity: 0.6; text-shadow: 0 0 20px rgba(239,68,68,0.4); }
        }
        @keyframes low-health-blink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0; }
        }
      `}</style>
      <div
        className={`relative min-h-screen bg-transparent text-neutral-100 flex flex-col antialiased selection:bg-purple-500/30 overflow-hidden${isShaking ? ' shake' : ''}`}
      >

        {/* WebGL 3D Game Scene */}
        <div className="absolute inset-0 z-0 w-full h-full">
          <Canvas gl={{ antialias: true, alpha: true }} shadows>
            <GameScene
              ecsEntities={ecsEntities}
              particles={particles}
              zoom={zoom}
              newbornIds={newbornIds}
              dyingIds={dyingIds}
              realityOverride={worldState?.reality_override}
              playerSpaceship={worldState?.player_spaceship}
            />
          </Canvas>
        </div>

        {/* Tactical HUD Overlay */}
        <HUD
          playerHealth={playerHealth}
          score={score}
          currentLevel={currentLevel}
          entities={ecsEntities}
          showDamageFlash={showDamageFlash}
          showSuccessFlash={showSuccessFlash}
          isGameOver={isGameOver}
          objective={objective}
        />

        {/* The Director's Console (Left Sidebar) */}
        <div className="fixed left-0 top-0 h-screen w-80 bg-black/80 backdrop-blur-xl border-r border-white/10 z-50 flex flex-col p-6 overflow-hidden transition-transform duration-500 ease-in-out">
          <div className="flex items-center space-x-3 mb-8">
            <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse"></div>
            <h2 className="text-xs font-bold text-neutral-400 uppercase tracking-[0.2em]">Director's Console</h2>
          </div>

          <div className="flex-1 flex flex-col gap-6 min-h-0">
            {/* Conversations / Subtitles */}
            <div className="flex-1 flex flex-col bg-white/5 border border-white/10 p-4 rounded-xl shadow-inner group hover:border-purple-500/30 transition-colors min-h-0">
              <h3 className="text-[10px] uppercase tracking-widest text-neutral-500 mb-3 font-bold">Conversational Stream</h3>
              <div className="flex-1 min-h-0">
                <ChatLog messages={chatHistory} />
              </div>
            </div>

            {/* Director's Schema (Visual Prompt) */}
            {worldState && (
              <div className="space-y-4">
                <div className="bg-purple-500/10 border border-purple-500/20 p-4 rounded-xl">
                  <h3 className="text-[10px] font-bold text-purple-400 uppercase tracking-widest mb-2 flex items-center">
                    <Activity className="w-3 h-3 mr-2" /> Current Schema
                  </h3>
                  <p className="text-xs text-neutral-300 font-medium leading-relaxed">
                    <span className="text-neutral-500 font-normal block mb-1 uppercase tracking-tighter">Summary</span>
                    {worldState.summary}
                  </p>
                </div>

                <div className="bg-black/40 border border-white/5 p-4 rounded-xl">
                  <span className="text-[10px] text-neutral-500 font-normal block mb-2 uppercase tracking-widest">Visual Prompt</span>
                  <p className="text-[11px] text-neutral-400 leading-relaxed font-mono italic">
                    {worldState.visual_prompt}
                  </p>
                </div>
              </div>
            )}

            {/* Removed [Raw Engine State] JSON dump for cleaner UI v7.3 */}
          </div>
        </div>

        {/* Main Content Viewport (Unobstructed Center) */}
        <div className="relative z-10 flex flex-col w-full h-full pointer-events-none flex-1">
          {/* Top Spacing for HUD */}
          <div className="h-24 w-full"></div>

          <div className="flex-1 flex items-center justify-center pointer-events-none">
            {/* Void State UI: only visible when truly disconnected from EVERYTHING */}
            {ecsReadyState !== ReadyState.OPEN && Object.keys(ecsEntities).length === 0 && !worldState && (
              <div className="w-full max-w-xl aspect-video bg-neutral-900/50 backdrop-blur rounded-3xl overflow-hidden shadow-2xl border border-neutral-800 ring-1 ring-white/10 flex items-center justify-center pointer-events-auto">
                <div className="flex flex-col items-center justify-center bg-gradient-to-b from-neutral-900/50 to-neutral-950 w-full h-full">
                  <Activity className={`w-12 h-12 text-purple-500/40 mb-4 ${isRecording ? 'animate-pulse text-purple-400' : ''}`} />
                  <p className="text-neutral-500 font-mono text-sm tracking-widest uppercase">
                    {ecsReadyState === ReadyState.CONNECTING ? 'Connecting to Engine...' : 'The Void is Empty'}
                  </p>
                </div>
              </div>
            )}
          </div>


          {/* Control Interface */}
          {/* Persistent Bottom Console (Controls) */}
          <div className="relative z-20 w-full p-8 flex flex-col items-center pointer-events-none mt-auto">
            {/* AI Status Loader */}
            <div className={`mb-4 flex flex-col items-center justify-center transition-opacity duration-300 ${aiState === 'idle' ? 'opacity-0' : 'opacity-100'}`}>
              <Activity className="w-6 h-6 text-purple-400 animate-pulse mb-2" />
              <div className="text-[10px] font-bold tracking-[0.3em] uppercase text-purple-400/80">
                {aiState === 'synthesizing' ? 'Synthesizing...' : 'Syncing Engine...'}
              </div>
            </div>

            <div className="flex items-center gap-8 pointer-events-auto">
              <button
                onMouseDown={aiState === 'idle' ? startRecording : undefined}
                onMouseUp={aiState === 'idle' ? stopRecording : undefined}
                disabled={aiState !== 'idle'}
                className={`
                relative group flex items-center justify-center w-20 h-20 rounded-full
                transition-all duration-300 ease-out shadow-lg
                ${aiState !== 'idle' ? 'opacity-50 cursor-not-allowed bg-neutral-800 text-neutral-500 ring-1 ring-white/5' :
                    isRecording
                      ? 'bg-red-500/20 text-red-500 ring-4 ring-red-500/30 scale-95'
                      : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white ring-1 ring-white/20 hover:scale-105'
                  }
              `}
              >
                {isRecording ? <Mic className="w-8 h-8" /> : <MicOff className="w-8 h-8" />}
                {isRecording && <span className="absolute inset-0 rounded-full animate-ping bg-red-500/20 -z-10"></span>}
              </button>

              {/* Manual Override Inline */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!textInput.trim() || readyState !== ReadyState.OPEN) return;
                  sendMessage(JSON.stringify({ type: 'text_command', text: textInput }));
                  setChatHistory(prev => [...prev, { sender: 'user', text: textInput, timestamp: new Date() }]);
                  setTextInput('');
                  setDirectorMessage('Manual override initiated...');
                }}
                className="flex items-center space-x-2 bg-black/40 backdrop-blur-xl border border-white/10 rounded-full p-1.5 shadow-2xl w-80 group hover:border-purple-500/50 transition-all"
              >
                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Direct Override Command..."
                  className="flex-1 bg-transparent text-neutral-200 placeholder-neutral-600 px-4 py-1.5 outline-none text-[11px] font-mono"
                />
                <button
                  type="submit"
                  disabled={!textInput.trim() || readyState !== ReadyState.OPEN || aiState !== 'idle'}
                  className="bg-neutral-800 hover:bg-purple-600 disabled:opacity-50 text-white px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all"
                >
                  Send
                </button>
              </form>
            </div>
            <p className="mt-4 text-[10px] font-medium text-neutral-500 uppercase tracking-[0.2em] opacity-50">
              {isRecording ? 'Capturing Voice...' : 'Voice Command / Override'}
            </p>
          </div>

          {/* HUD: Target Controls (Save, Audio, TTS Toggle) */}
          <div className="absolute top-6 right-6 flex items-center space-x-3 z-[100] pointer-events-auto">
            <button
              onClick={handleClearWorld}
              title="Clear Matrix"
              className="relative z-[100] flex items-center justify-center w-9 h-9 rounded-lg bg-neutral-800/80 backdrop-blur border border-white/10 hover:bg-neutral-700 hover:border-red-500/40 text-neutral-400 hover:text-red-400 transition-all duration-200 shadow-lg mr-2"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setIsRachelEnabled(r => !r)}
              title={isRachelEnabled ? 'Disable Rachel Voice' : 'Enable Rachel Voice'}
              className={`text-[10px] font-bold tracking-wider uppercase px-3 h-9 rounded-lg backdrop-blur border transition-all duration-200 shadow-lg ${isRachelEnabled
                ? 'bg-purple-900/40 border-purple-500/30 text-purple-300 hover:bg-purple-800/50'
                : 'bg-neutral-800/80 border-white/10 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-400'
                }`}
            >
              Rachel: {isRachelEnabled ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={handleSave}
              title="Save Universe"
              className="flex items-center justify-center w-9 h-9 rounded-lg bg-neutral-800/80 backdrop-blur border border-white/10 hover:bg-neutral-700 hover:border-purple-500/40 text-neutral-400 hover:text-purple-300 transition-all duration-200 shadow-lg"
            >
              <Save className="w-4 h-4" />
            </button>
            <button
              onClick={() => { initAudio(); setIsMuted(m => !m); }}
              title={isMuted ? 'Unmute' : 'Mute'}
              className={`flex items-center justify-center w-9 h-9 rounded-lg backdrop-blur border transition-all duration-200 shadow-lg ${isMuted
                ? 'bg-red-900/40 border-red-500/30 text-red-400 hover:bg-red-800/50'
                : 'bg-neutral-800/80 border-white/10 text-neutral-400 hover:bg-neutral-700 hover:border-emerald-500/40 hover:text-emerald-300'
                }`}
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <div className={`w-2 h-2 rounded-full ${readyState === ReadyState.OPEN ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-amber-500 animate-pulse'}`}></div>
            <span className="text-xs font-mono text-neutral-500 uppercase tracking-wider">{connectionStatus}</span>
          </div>

          {/* Toast: Universe Saved */}
          {saveToast && (
            <div className="absolute top-16 right-6 toast-anim z-50">
              <div className="flex items-center space-x-2 bg-emerald-500/20 backdrop-blur-md border border-emerald-400/30 text-emerald-300 px-4 py-2.5 rounded-xl shadow-2xl">
                <Save className="w-4 h-4" />
                <span className="text-sm font-medium tracking-wide">Universe Saved to Disk</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

