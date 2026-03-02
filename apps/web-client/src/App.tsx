import React, { useState, useEffect, useRef, useCallback } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { Activity, Server, Mic, MicOff, Save, Volume2, VolumeX, ChevronLeft, Send } from 'lucide-react';
import { Canvas } from '@react-three/fiber';
import { GameScene } from './components/GameScene';
import { HUD } from './components/HUD';
import { ChatLog, ChatMessage } from './components/ChatLog';

const WS_URL = 'ws://127.0.0.1:8000/api/v1/dream-stream';

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [directorMessage, setDirectorMessage] = useState<string>("Awaiting connection to The Void...");
  const [worldState, setWorldState] = useState<any>(null);
  const [engineSynced, setEngineSynced] = useState(false);

  // Voice & Audio Meter State
  const [volumeLevel, setVolumeLevel] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const hasAudioDetected = useRef(false);

  // Focus & Layout hooks
  const [textInput, setTextInput] = useState("");
  const [aiState, setAiState] = useState<"idle" | "synthesizing" | "orchestrating">("idle");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isChatVisible, setIsChatVisible] = useState(true);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);

  const { sendMessage, lastMessage, readyState } = useWebSocket(WS_URL, {
    shouldReconnect: () => true,
    reconnectInterval: 3000,
  });

  // ECS WebSocket connection
  const { lastMessage: ecsMessage, sendMessage: sendEcsMessage, readyState: ecsReadyState } = useWebSocket('ws://127.0.0.1:8081/ws', {
    shouldReconnect: () => true,
    reconnectInterval: 500,
    onError: (e) => console.error('Rust engine connection error:', e),
  });

  // Player Input Stream
  const activeKeysRef = useRef<Set<string>>(new Set());
  const camYawRef = useRef<number>(Math.PI); // Face toward sun/Earth at spawn
  const camPitchRef = useRef<number>(0);
  const isPointerLockedRef = useRef<boolean>(false);
  const [isPointerLocked, setIsPointerLocked] = useState(false);

  // 60fps input loop — applies keyboard yaw, sends every frame when keys held (for reliable thrust)
  const lastSentRef = useRef({ keys: '', yaw: 0, pitch: 0 });
  useEffect(() => {
    let frame: number;
    const YAW_SPEED = 0.028; // ~1.6°/frame @ 60fps → smooth keyboard turn
    const loop = () => {
      // Keyboard yaw: A/ArrowLeft = turn left, D/ArrowRight = turn right
      if (activeKeysRef.current.has('KeyA') || activeKeysRef.current.has('ArrowLeft')) {
        camYawRef.current -= YAW_SPEED;
      }
      if (activeKeysRef.current.has('KeyD') || activeKeysRef.current.has('ArrowRight')) {
        camYawRef.current += YAW_SPEED;
      }

      const keysStr = Array.from(activeKeysRef.current).sort().join(',');
      const yaw = camYawRef.current;
      const pitch = camPitchRef.current;
      const last = lastSentRef.current;

      // Always send while any key is held (ensures thrust/shoot is never lost to WS reconnects)
      const anyKeyHeld = activeKeysRef.current.size > 0;
      const changed =
        anyKeyHeld ||
        keysStr !== last.keys ||
        Math.abs(yaw - last.yaw) > 0.0005 ||
        Math.abs(pitch - last.pitch) > 0.0005;

      if (changed) {
        sendEcsMessage(JSON.stringify({
          msg_type: 'player_input',
          keys: Array.from(activeKeysRef.current),
          cam_yaw: yaw,
          cam_pitch: pitch,
        }));
        lastSentRef.current = { keys: keysStr, yaw, pitch };
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [sendEcsMessage]);

  // Key tracking
  useEffect(() => {
    const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight']);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      if (GAME_KEYS.has(e.code)) { e.preventDefault(); activeKeysRef.current.add(e.code); }
    };
    const handleKeyUp = (e: KeyboardEvent) => { activeKeysRef.current.delete(e.code); };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); };
  }, []);

  // Mouse look (pointer lock)
  useEffect(() => {
    const MOUSE_SENSITIVITY = 0.002;
    const MAX_PITCH = Math.PI / 2.5; // ~72° up/down limit

    const handleMouseMove = (e: MouseEvent) => {
      if (!isPointerLockedRef.current) return;
      camYawRef.current += e.movementX * MOUSE_SENSITIVITY;
      camPitchRef.current = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, camPitchRef.current - e.movementY * MOUSE_SENSITIVITY));
    };

    const handleLockChange = () => {
      const locked = document.pointerLockElement !== null;
      isPointerLockedRef.current = locked;
      setIsPointerLocked(locked);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('pointerlockchange', handleLockChange);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('pointerlockchange', handleLockChange);
    };
  }, []);

  // Tab targeting: cycle through enemies sorted by distance from player
  useEffect(() => {
    const handleTab = (e: KeyboardEvent) => {
      if (e.code !== 'Tab') return;
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      e.preventDefault();

      const ents = ecsEntitiesRef.current;
      const player = Object.values(ents).find((ent: any) => ent.ent_type === 'player') as any;
      const px = player?.x || 0;
      const pz = player?.z || 0;

      const enemies = Object.values(ents).filter(
        (ent: any) => (ent.ent_type === 'enemy' || ent.ent_type === 'alien_ship') && !ent.is_dying
      ) as any[];

      if (enemies.length === 0) { setTargetedEntityId(null); return; }

      enemies.sort((a, b) => {
        const da = Math.sqrt((a.x - px) ** 2 + ((a.z || 0) - pz) ** 2);
        const db = Math.sqrt((b.x - px) ** 2 + ((b.z || 0) - pz) ** 2);
        return da - db;
      });

      const ids = enemies.map((e: any) => e.id as number);
      setTargetedEntityId(prev => {
        const currentIdx = ids.indexOf(prev as number);
        const nextIdx = e.shiftKey
          ? (currentIdx <= 0 ? ids.length - 1 : currentIdx - 1)
          : (currentIdx + 1) % ids.length;
        return ids[nextIdx];
      });
    };
    window.addEventListener('keydown', handleTab);
    return () => window.removeEventListener('keydown', handleTab);
  }, []); // stable — reads ecsEntitiesRef directly (ref, not state)

  const requestPointerLock = useCallback(() => {
    const canvas = document.querySelector('canvas');
    if (canvas && !isPointerLockedRef.current) {
      canvas.requestPointerLock();
    }
  }, []);

  const [ecsEntities, setEcsEntities] = useState<Record<string, any>>({});
  const ecsEntitiesRef = useRef<Record<string, any>>({});
  const [particles, setParticles] = useState<any[]>([]);
  const particlesRef = useRef<any[]>([]);
  const [zoom, setZoom] = useState(1.5);
  const [isShaking, setIsShaking] = useState(false);
  const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentZoomRef = useRef(1.5);
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
  const [showBoundaryFlash, setShowBoundaryFlash] = useState(false);
  const prevHealthRef = useRef(100);
  const damageFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boundaryFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tab targeting state
  const [targetedEntityId, setTargetedEntityId] = useState<number | null>(null);

  // Track entities that just spawned to trigger the birth glow animation
  const [newbornIds, setNewbornIds] = useState<Set<number>>(new Set());
  // Track dying entities for implosion animation
  const [dyingIds, setDyingIds] = useState<Set<number>>(new Set());

  // Initialize AudioContext on first user interaction (browser autoplay policy)
  const initAudio = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      // AudioContext initialized
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
        const next = Math.max(0.5, Math.min(5.0, prev + e.deltaY * 0.001));
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
        .then(res => { if (!res.ok) console.warn('State Sync failed:', res.status); })
        .catch(err => console.warn('Zoom sync failed:', err));
    }, 100);
  }, [zoom, worldState]);

  // Handle incoming ECS updates
  useEffect(() => {
    if (ecsMessage !== null) {
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
          let entitiesObj: Record<string, any> = {};
          if (Array.isArray(data.entities)) {
            data.entities.forEach((ent: any) => {
              entitiesObj[ent.id] = ent;
            });

            (window as any)._loggedFirstFrame = true;
            ecsEntitiesRef.current = entitiesObj;
            setEcsEntities(entitiesObj);
          } else {
            ecsEntitiesRef.current = data.entities;
            setEcsEntities(data.entities);
          }

          // Boundary proximity — flash blue when within 2 000 u of the 32 000 u shell
          const playerEntBoundary = Array.isArray(data.entities)
            ? data.entities.find((e: any) => e.ent_type === 'player')
            : null;
          if (playerEntBoundary) {
            const bx = playerEntBoundary.x || 0;
            const by = playerEntBoundary.y || 0;
            const bz = playerEntBoundary.z || 0;
            if (Math.sqrt(bx * bx + by * by + bz * bz) > 30000) {
              if (boundaryFlashTimeoutRef.current) clearTimeout(boundaryFlashTimeoutRef.current);
              setShowBoundaryFlash(true);
              boundaryFlashTimeoutRef.current = setTimeout(() => setShowBoundaryFlash(false), 800);
            }
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
        } else if (data.type === 'status_update') {
          setAiState(data.status);
          if (data.status === 'idle') {
            setDirectorMessage('Awaiting connection to The Void...');
          }
        } else if (data.type === 'frame_update') {
          // Legacy frame streaming (Phase 1 mock)
        } else if (data.type === 'world_state') {
          setWorldState(data.content);
        } else if (data.type === 'proactive_audio') {
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
          y: player.y,
          z: player.z ?? 0,
        }));
      }
    }, 2000); // Every 2 seconds is enough for awareness without flooding
    return () => clearInterval(syncInterval);
  }, [ecsEntities, readyState, sendMessage]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      // Volume Meter Setup
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioCtx();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      hasAudioDetected.current = false;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const checkVolume = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        setVolumeLevel(average);

        if (average > 2) {
          hasAudioDetected.current = true;
        }

        animationFrameRef.current = requestAnimationFrame(checkVolume);
      };
      checkVolume();

      let mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/wav')) {
        mimeType = 'audio/wav';
      } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')) {
        mimeType = 'audio/webm;codecs=pcm';
      } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      }

      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType });
      audioChunks.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.current.push(event.data);
          setDirectorMessage('Vocalizing...');
        }
      };

      mediaRecorderRef.current.onstop = () => {
        // Stop the mic tracks
        if (mediaRecorderRef.current && mediaRecorderRef.current.stream) {
          mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }

        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
          audioContextRef.current.close().catch(console.error);
        }
        setVolumeLevel(0);

        if (!hasAudioDetected.current) {
          console.warn("No audio detected during recording.");
          setDirectorMessage('No audio detected! Please check your microphone source.');
          setAiState('idle');
          return;
        }

        const fullBlob = new Blob(audioChunks.current, { type: mimeType });
        if (readyState === ReadyState.OPEN) {
          // We don't have the transcript yet, but we've finished recording.
          // The transcript will come back via the websocket handled above.
          sendMessage(fullBlob);
          sendMessage(JSON.stringify({ type: 'audio_end' }));
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
    // 200ms lead-out buffer to catch the end of speech
    setTimeout(() => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
      setDirectorMessage('Sending transmission...');
    }, 200);
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
        @keyframes boundary-flash {
          0%   { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>

      {/* Clears the error state explicitly */}
      <div style={{ display: 'none' }}>
        {(() => {
          (window as any).clearFailedState = () => {
            setAiState('idle');
            setDirectorMessage('Awaiting connection to The Void...');
            setChatHistory(prev => prev.filter(m => m.text !== "The Architect's connection is unstable."));
          };
          return null;
        })()}
      </div>

      <div
        className={`relative min-h-screen bg-transparent text-neutral-100 flex flex-col antialiased selection:bg-purple-500/30 overflow-hidden${isShaking ? ' shake' : ''}`}
      >

        {/* WebGL 3D Game Scene */}
        <div className="absolute inset-0 z-0 w-full h-full" onClick={requestPointerLock}>
          {!isPointerLocked && (
            <div className="absolute inset-0 flex items-end justify-center z-10 pb-8 pointer-events-none">
              <div className="bg-black/60 backdrop-blur text-white/70 text-xs font-mono px-4 py-2 rounded-full border border-white/10">
                Click to enable mouse look · Esc to release
              </div>
            </div>
          )}
          <Canvas gl={{ antialias: true, alpha: true }} shadows>
            <GameScene
              ecsEntities={ecsEntities}
              particles={particles}
              zoom={zoom}
              newbornIds={newbornIds}
              dyingIds={dyingIds}
              realityOverride={worldState?.reality_override}
              playerSpaceship={worldState?.player_spaceship}
              camYawRef={camYawRef}
              camPitchRef={camPitchRef}
              targetedEntityId={targetedEntityId}
            />
          </Canvas>
        </div>

        {/* Boundary Warning Flash */}
        {showBoundaryFlash && (
          <div
            className="absolute inset-0 pointer-events-none z-[175]"
            style={{
              background: 'radial-gradient(ellipse at center, transparent 30%, rgba(100, 40, 255, 0.55) 100%)',
              animation: 'boundary-flash 0.8s ease-out forwards',
            }}
          />
        )}

        {/* ── Top-right control bar ──────────────────────────────────────── */}
        <div className="fixed z-[150] flex items-center gap-2" style={{ top: '24px', right: '24px' }}>
          {/* Director connection status */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-black/40 backdrop-blur border border-white/10 rounded-lg">
            <div className={`w-1.5 h-1.5 rounded-full ${readyState === ReadyState.OPEN ? 'bg-green-400' : 'bg-red-500 animate-pulse'}`} />
            <span className="text-[9px] font-mono text-neutral-400 uppercase tracking-widest">
              {readyState === ReadyState.OPEN ? 'Connected to Director' : 'Director Offline'}
            </span>
          </div>

          {/* Rachel voice toggle */}
          <button
            onClick={() => setIsRachelEnabled(v => !v)}
            className={`px-2.5 py-1.5 border rounded-lg text-[9px] font-mono font-bold uppercase tracking-widest transition-all ${isRachelEnabled
                ? 'bg-purple-500/20 border-purple-500/50 text-purple-400 hover:bg-purple-500/30'
                : 'bg-neutral-800/60 border-white/10 text-neutral-500 hover:text-neutral-300'
              }`}
            title="Toggle Rachel voice"
          >
            Rachel: {isRachelEnabled ? 'ON' : 'OFF'}
          </button>


          {/* Mute */}
          <button
            onClick={() => setIsMuted(v => !v)}
            className="w-8 h-8 flex items-center justify-center bg-black/40 backdrop-blur border border-white/10 rounded-lg text-neutral-400 hover:text-white hover:bg-white/10 transition-all"
            title={isMuted ? 'Unmute sounds' : 'Mute sounds'}
          >
            {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
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
          isChatVisible={isChatVisible}
        />

        {/* The Director's Console (Left Sidebar) */}
        <div className={`fixed left-0 top-0 h-screen w-[450px] bg-black/80 backdrop-blur-3xl border-r border-white/10 z-50 flex flex-col p-6 transition-all duration-500 cubic-bezier(0.4, 0, 0.2, 1) shadow-[10px_0_50px_rgba(0,0,0,0.5)] ${isChatVisible ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0'}`}>
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center space-x-3">
              <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse"></div>
              <h2 className="text-xs font-bold text-neutral-400 uppercase tracking-[0.2em]">Director's Console</h2>
            </div>
            <button
              onClick={() => setIsChatVisible(false)}
              className="p-1 hover:bg-white/10 rounded-lg transition-colors text-neutral-500 hover:text-white"
              title="Minimize Console"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 flex flex-col gap-6 min-h-0">
            {/* Conversations / Subtitles */}
            <div className="flex-1 flex flex-col bg-white/5 border border-white/10 p-4 rounded-xl shadow-inner group hover:border-purple-500/30 transition-colors min-h-0">
              <h3 className="text-[10px] uppercase tracking-widest text-neutral-500 mb-3 font-bold">Conversational Stream</h3>
              <div className="flex-1 min-h-0">
                <ChatLog messages={chatHistory} onRetry={() => (window as any).clearFailedState && (window as any).clearFailedState()} />
              </div>
            </div>

            {/* Removed [Raw Engine State] JSON dump for cleaner UI v7.3 */}
          </div>

          {/* New Relocated Control Interface inside sidebar */}
          <div className="mt-6 pt-6 border-t border-white/5 space-y-4">
            <div className="flex items-center gap-4">
              <button
                onMouseDown={aiState === 'idle' ? startRecording : undefined}
                onMouseUp={aiState === 'idle' ? stopRecording : undefined}
                disabled={aiState !== 'idle'}
                className={`
                    relative group flex items-center justify-center w-12 h-12 rounded-full
                    transition-all duration-300 ease-out shadow-lg
                    ${aiState !== 'idle' ? 'opacity-50 cursor-not-allowed bg-neutral-800 text-neutral-500 ring-1 ring-white/5' :
                    isRecording
                      ? 'bg-red-500/20 text-red-500 ring-4 ring-red-500/30 scale-95'
                      : 'bg-neutral-800 hover:bg-purple-600 transition-colors text-neutral-300 hover:text-white ring-1 ring-white/20 hover:scale-105'
                  }
                  `}
              >
                {isRecording ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
                {isRecording && <span className="absolute inset-0 rounded-full animate-ping bg-red-500/20 -z-10"></span>}
                {/* Visual Volume Meter */}
                {isRecording && (
                  <div
                    className="absolute -inset-2 border-2 border-purple-500 rounded-full opacity-50 z-0 transition-transform duration-75"
                    style={{
                      transform: `scale(${1 + Math.min(volumeLevel / 50, 0.5)})`,
                      opacity: volumeLevel > 5 ? 0.8 : 0.2
                    }}
                  />
                )}
              </button>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!textInput.trim() || readyState !== ReadyState.OPEN) return;
                  sendMessage(JSON.stringify({ type: 'text_command', text: textInput }));
                  setChatHistory(prev => [...prev, { sender: 'user', text: textInput, timestamp: new Date() }]);
                  setTextInput('');
                  setDirectorMessage('Manual override initiated...');
                }}
                className="flex-1 flex items-center bg-black/40 backdrop-blur-xl border border-white/10 rounded-full p-1 pl-3 shadow-2xl group hover:border-purple-500/50 transition-all focus-within:border-purple-500/50 focus-within:ring-1 focus-within:ring-purple-500/20"
              >
                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Command..."
                  className="flex-1 bg-transparent text-neutral-200 placeholder-neutral-600 px-2 py-1.5 outline-none text-xs font-mono"
                />
                <button
                  type="submit"
                  disabled={!textInput.trim()}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${textInput.trim()
                    ? 'bg-purple-500/20 text-purple-400 hover:bg-purple-600 hover:text-purple-200 transition-colors shadow-[0_0_15px_rgba(168,85,247,0.2)]'
                    : 'bg-neutral-800 text-neutral-600 grayscale'
                    }`}
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </form>
            </div>
            <div className="flex items-center justify-between px-2">
              <span className="text-[9px] font-medium text-neutral-500 uppercase tracking-widest">
                {isRecording ? 'Capturing Voice...' : 'Voice / Override'}
              </span>
              {aiState !== 'idle' && (
                <div className="flex items-center gap-2">
                  <Activity className="w-2.5 h-2.5 text-purple-400 animate-pulse" />
                  <span className="text-[8px] font-bold text-purple-500/80 uppercase tracking-tighter">Syncing...</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Global UI Toggle (Visible when sidebar is hidden) */}
        {!isChatVisible && (
          <button
            onClick={() => setIsChatVisible(true)}
            className="fixed left-6 top-6 z-50 w-10 h-10 bg-black/40 backdrop-blur-xl border border-white/10 rounded-xl flex items-center justify-center text-neutral-400 hover:text-white hover:bg-white/10 transition-all shadow-2xl group"
          >
            <Server className="w-5 h-5 group-hover:scale-110 transition-transform" />
          </button>
        )}
      </div>
    </>
  );
}
