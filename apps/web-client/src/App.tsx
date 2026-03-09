import { useState, useEffect, useRef, useCallback } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { Activity, Server, Mic, MicOff, ChevronLeft, Send, Wifi, Bot, Volume2, VolumeX } from 'lucide-react';
import { Canvas } from '@react-three/fiber';
import { GameScene } from './components/GameScene';
import { HUD } from './components/HUD';
import { ChatLog, ChatMessage } from './components/ChatLog';

const WS_URL = 'ws://localhost:8000/api/v1/dream-stream';
const RESET_DEBOUNCE_MS = 1000;

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [directorMessage, setDirectorMessage] = useState<string>("Awaiting connection to The Void...");
  const [worldState, setWorldState] = useState<any>(null);
  const [customTextureUrl, setCustomTextureUrl] = useState<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Voice & Audio Meter State
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const audioQueueRef = useRef<Array<{ url: string; text: string }>>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const hasAudioDetected = useRef(false);

  // Focus & Layout hooks
  const [textInput, setTextInput] = useState("");
  const [aiState, setAiState] = useState<"idle" | "synthesizing" | "orchestrating">("idle");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isChatVisible, setIsChatVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(450);
  const [isResizing, setIsResizing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);

  const { sendMessage, lastMessage, readyState } = useWebSocket(WS_URL, {
    shouldReconnect: () => true,
    reconnectInterval: 3000,
  });

  const dispatchTelemetryRef = useRef((action: string, details: string, severity: string) => { });
  useEffect(() => {
    dispatchTelemetryRef.current = (action: string, details: string, severity: string) => {
      if (readyState === ReadyState.OPEN) {
        const payload = { type: 'telemetry', action, details, severity };
        // Silent telemetry dispatch
        sendMessage(JSON.stringify(payload));
      }
    };
  }, [readyState, sendMessage]);

  // ECS WebSocket connection
  const { lastMessage: ecsMessage, sendMessage: sendEcsMessage } = useWebSocket('ws://localhost:8081/ws', {
    shouldReconnect: () => true,
    reconnectInterval: 500,
    onError: (e) => { }, // Suppressed error spam
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

      const isLocked = spectatorTargetIdRef.current !== null || isTimeFrozenRef.current || isFocusModePausedRef.current;
      if (changed && !isLocked) {
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
      if (e.code === 'Escape') {
        setSpectatorTargetId(null);
        // Ensure tactical map and engine pause are cleared when escaping
        handleFocusModeChange(false);
      }
      if (e.code === 'Space' && !activeKeysRef.current.has('Space')) {
        dispatchTelemetryRef.current('fired_weapon', 'laser', 'low');
      }
      if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !activeKeysRef.current.has(e.code)) {
        dispatchTelemetryRef.current('rapid_acceleration', 'boost_engaged', 'low');
      }
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
    // Initialize AudioContext on first user gesture (browser autoplay policy)
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    setIsAudioUnlocked(true);
  }, []);

  const [ecsEntities, setEcsEntities] = useState<Record<string, any>>({});
  const ecsEntitiesRef = useRef<Record<string, any>>({});
  const ecsFrameCounterRef = useRef(0);
  const [particles, setParticles] = useState<any[]>([]);
  const particlesRef = useRef<any[]>([]);
  const [zoom, setZoom] = useState(1.5);
  const [isShaking, setIsShaking] = useState(false);
  const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentZoomRef = useRef(1.5);
  const shakeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const handleToggleMute = useCallback((muted: boolean) => {
    setIsMuted(muted);
    sendMessage(JSON.stringify({
      type: 'update_audio_settings',
      ai_muted: muted,
      game_muted: muted
    }));
  }, [sendMessage]);
  const [isRachelEnabled, setIsRachelEnabled] = useState(true);
  // ── Survival HUD state ──────────────────────────────────────────────────
  const [playerHealth, setPlayerHealth] = useState(100);
  const [score, setScore] = useState(0);
  const [currentLevel, setCurrentLevel] = useState(1);
  const [objective, setObjective] = useState("");
  const [isGameOver, setIsGameOver] = useState(false);
  const [blackHoleDeath, setBlackHoleDeath] = useState(false);
  const blackHoleDeathFiredRef = useRef(false);
  const [showDeathScreen, setShowDeathScreen] = useState(false);
  const [deathReason, setDeathReason] = useState<'health' | 'blackhole' | 'restart'>('health');
  const [deathStats, setDeathStats] = useState({ score: 0, level: 1 });
  const [showLevelTransition, setShowLevelTransition] = useState(false);
  const [transitionLevel, setTransitionLevel] = useState(1);
  const prevLevelRef = useRef(0); // Initialize to 0 to catch the first level if it starts at 1
  const levelTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showDamageFlash, setShowDamageFlash] = useState(false);
  const [showSuccessFlash, setShowSuccessFlash] = useState(false);
  const [showBoundaryFlash, setShowBoundaryFlash] = useState(false);
  const lastResetTimeRef = useRef(0);
  const prevHealthRef = useRef(100);
  const damageFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boundaryFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startResizing = useCallback(() => setIsResizing(true), []);
  const stopResizing = useCallback(() => setIsResizing(false), []);
  const resize = useCallback((e: MouseEvent) => {
    if (isResizing) {
      const newWidth = Math.max(300, Math.min(e.clientX, window.innerWidth * 0.5));
      setSidebarWidth(newWidth);
    }
  }, [isResizing]);

  useEffect(() => {
    if (isResizing) {
      window.addEventListener('mousemove', resize);
      window.addEventListener('mouseup', stopResizing);
    } else {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
    }
    return () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
    };
  }, [isResizing, resize, stopResizing]);

  // Tab targeting state
  const [targetedEntityId, setTargetedEntityId] = useState<number | null>(null);

  // Spectator mode state
  const [spectatorTargetId, setSpectatorTargetId] = useState<number | null>(null);
  const spectatorTargetIdRef = useRef<number | null>(null);
  useEffect(() => { spectatorTargetIdRef.current = spectatorTargetId; }, [spectatorTargetId]);

  const [isTimeFrozen, setIsTimeFrozen] = useState(false);
  const isTimeFrozenRef = useRef(false);
  useEffect(() => { isTimeFrozenRef.current = isTimeFrozen; }, [isTimeFrozen]);

  // Focus mode pause (tactical map open)
  const isFocusModePausedRef = useRef(false);

  // Full reset: clears BH overlay + calls engine reset
  const bhAutoResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleFullReset = useCallback(async () => {
    lastResetTimeRef.current = Date.now();
    if (bhAutoResetTimerRef.current) { clearTimeout(bhAutoResetTimerRef.current); bhAutoResetTimerRef.current = null; }
    try { await fetch('http://127.0.0.1:8080/api/engine/reset', { method: 'POST' }); } catch (_) { }
    setBlackHoleDeath(false);
    blackHoleDeathFiredRef.current = false;
    setSpectatorTargetId(null);
    setIsGameOver(false);
    setShowDeathScreen(false);
    setShowLevelTransition(false);
    prevLevelRef.current = 0;
    setZoom(1.5);
  }, []);

  // Show the dramatic death/restart screen — requires user interaction to continue
  const triggerDeathScreen = useCallback((reason: 'health' | 'blackhole' | 'restart') => {
    setDeathStats({ score, level: currentLevel });
    setDeathReason(reason);
    setShowDeathScreen(true);
  }, [score, currentLevel]);

  // Pause/resume Rust physics when tactical map opens/closes or spectator mode changes
  const syncEnginePauseState = useCallback(() => {
    const shouldPause = isFocusModePausedRef.current || spectatorTargetIdRef.current !== null;
    fetch(`http://127.0.0.1:8080/api/${shouldPause ? 'pause' : 'resume'}`, { method: 'POST' }).catch(() => { });
  }, []);

  const handleFocusModeChange = useCallback((isOpen: boolean) => {
    isFocusModePausedRef.current = isOpen;
    syncEnginePauseState();
  }, [syncEnginePauseState]);

  // Planet radii for zoom calculation
  const getPlanetRadius = (name: string) => {
    switch (name) {
      case 'Mercury': return 120;
      case 'Venus': return 255;
      case 'Earth': return 300;
      case 'Mars': return 180;
      case 'Jupiter': return 750;
      case 'Saturn': return 630;
      case 'Uranus': return 420;
      case 'Neptune': return 390;
      default: return 150;
    }
  };

  const prevSpectatorTargetId = useRef<number | null>(null);
  const visualConfig = worldState?.visual_config;

  useEffect(() => {
    // When spectator target changes, recalculate default zoom
    if (spectatorTargetId !== prevSpectatorTargetId.current) {
      if (spectatorTargetId !== null) {
        const target = ecsEntitiesRef.current[spectatorTargetId];
        if (target) {
          let r = 30; // Default radius fallback
          if (target.ent_type === 'planet') {
            r = target.name === 'Sun' || target.name === 'sun' ? 1000 : getPlanetRadius(target.name);
          } else if (target.ent_type === 'moon') {
            r = target.radius || 30;
          } else if (target.radius) {
            r = target.radius;
          } else if (target.ent_type === 'player') {
            r = 15;
          }

          const vScale = visualConfig?.planet_scale_overrides?.[target.name] ?? 1.0;
          const totalRadius = r * vScale;

          const idealZoom = (totalRadius * 3.5 - 300) / 100;
          setZoom(Math.max(0.01, Math.min(25.0, idealZoom)));

          // Initialize yaw/pitch for spectator mode
          if (target.ent_type === 'planet' || target.ent_type === 'moon' || target.name === 'Sun' || target.name === 'sun') {
            // Stars/Planets: look from "outside in" relative to system center
            camYawRef.current = Math.atan2(target.z || 0, target.x || 0);
          } else if (target.rotation !== undefined) {
            // Ships/Entities: look from their heading
            camYawRef.current = target.rotation;
          }
          camPitchRef.current = 0.15;
        }
      } else {
        // Returned to player
        setZoom(1.5);
        const playerEnt = Object.values(ecsEntitiesRef.current).find((e: any) => e.ent_type === 'player') as any;
        if (playerEnt) {
          camYawRef.current = playerEnt.rotation || 0;
          camPitchRef.current = 0;
        }
      }
      syncEnginePauseState();
      prevSpectatorTargetId.current = spectatorTargetId;
    }
  }, [spectatorTargetId, syncEnginePauseState, visualConfig]);

  // Track entities that just spawned to trigger the birth glow animation
  const [newbornIds, setNewbornIds] = useState<Set<number>>(new Set());
  // Track dying entities for implosion animation
  const [dyingIds, setDyingIds] = useState<Set<number>>(new Set());

  // Global visual overrides (e.g. blackout events)
  const [globalOverride, setGlobalOverride] = useState<{
    sun_visible?: boolean;
    ambient_color?: string;
    ambient_intensity?: number;
    skybox_color?: string;
  }>({
    sun_visible: true,
    ambient_intensity: 0.4,
  });

  // Generative collision sound: sine+sawtooth oscillator pulse
  const playCollisionSound = useCallback((speed: number, distance: number) => {
    if (isMuted || !audioContextRef.current) return;
    const ctx = audioContextRef.current;
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

  // Play audio from HTTP URL (Piper TTS)
  const playAudioFromUrl = useCallback((url: string, text: string) => {
    if (!isRachelEnabled) return;

    if (!isAudioUnlocked) {
      audioQueueRef.current.push({ url, text });
      return;
    }

    const audio = new Audio(url);
    audio.play().catch(e => { });
  }, [isRachelEnabled, isAudioUnlocked]);

  // Process queued audio when unlocked
  const playQueuedAudio = useCallback(() => {
    while (audioQueueRef.current.length > 0) {
      const { url } = audioQueueRef.current.shift() || {};
      if (url && isRachelEnabled) {
        const audio = new Audio(url);
        audio.play().catch(e => { });
      }
    }
  }, [isRachelEnabled]);

  // Unlock audio on first user interaction (click or key press)
  useEffect(() => {
    if (isAudioUnlocked) return; // Already unlocked

    const unlockAudio = () => {
      setIsAudioUnlocked(true);
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume();
      }
      playQueuedAudio();
      // Remove listeners once unlocked
      document.removeEventListener('click', unlockAudio);
      document.removeEventListener('keydown', unlockAudio);
    };

    document.addEventListener('click', unlockAudio);
    document.addEventListener('keydown', unlockAudio);

    return () => {
      document.removeEventListener('click', unlockAudio);
      document.removeEventListener('keydown', unlockAudio);
    };
  }, [isAudioUnlocked, playQueuedAudio]);

  // Debounced Camera Zoom via scroll wheel
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(prev => {
        // Normal mode: 0.01 (dist=301, ultra-tight) → 10.0 (dist=1300, tactical view)
        // Spectator/radar-focus mode: wider range allowed (0.01 to 25.0)
        const isSpectator = spectatorTargetIdRef.current !== null;
        const [minZ, maxZ] = isSpectator ? [0.01, 25.0] : [0.01, 10.0];
        return Math.max(minZ, Math.min(maxZ, prev + e.deltaY * 0.002));
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
      fetch('http://localhost:8080/state', {
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
        .then(res => { })
        .catch(err => { });
    }, 300);
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
              dispatchTelemetryRef.current('took_damage', `Health dropped to ${newHealth}`, 'high');
            }
            prevHealthRef.current = newHealth;
          }
          if (data.score !== undefined) {
            setScore(data.score as number);
          }
          if (data.current_level !== undefined) {
            const newLevel = data.current_level as number;
            if (newLevel > prevLevelRef.current && prevLevelRef.current > 0) {
              // Level up detected — show transition screen
              setTransitionLevel(newLevel);
              setShowLevelTransition(true);

              // If dying, dismiss death screen because level victory takes priority
              if (showDeathScreen) {
                setShowDeathScreen(false);
              }

              if (levelTransitionTimerRef.current) clearTimeout(levelTransitionTimerRef.current);
              levelTransitionTimerRef.current = setTimeout(() => {
                setShowLevelTransition(false);
                levelTransitionTimerRef.current = null;
              }, 3500);
            }
            prevLevelRef.current = newLevel;
            setCurrentLevel(newLevel);
          }
          if (data.is_game_over !== undefined) {
            const isGameOverNow = data.is_game_over as boolean;
            setIsGameOver(isGameOverNow);

            if (isGameOverNow) {
              // Avoid showing the death screen if we just reset (prevents re-triggering from laggy frames)
              const timeSinceReset = Date.now() - lastResetTimeRef.current;
              if (timeSinceReset < RESET_DEBOUNCE_MS) return;

              // Show death screen — wait for user interaction (no auto-reset)
              if (!blackHoleDeathFiredRef.current && !showDeathScreen) {
                triggerDeathScreen('health');
              }
            } else {
              // Engine auto-resurrected after 3s delay -> dismiss the death screen automatically
              // so the user isn't stuck behind the overlay while they are actually alive.
              if (showDeathScreen && deathReason === 'health') {
                setShowDeathScreen(false);
              }

              // Clear black hole death overlay only when transitioning OUT of a BH death
              if (blackHoleDeathFiredRef.current) {
                setBlackHoleDeath(false);
                blackHoleDeathFiredRef.current = false;
                setSpectatorTargetId(null);
              }
            }
          }
          if (data.is_transitioning !== undefined) {
            setIsTransitioning(data.is_transitioning as boolean);
          }
          if (data.black_hole_death === true && !blackHoleDeathFiredRef.current) {
            blackHoleDeathFiredRef.current = true;
            setBlackHoleDeath(true);
            // Focus camera on the black hole
            const frameEnts: any[] = Array.isArray(data.entities) ? data.entities : [];
            const bhEnt = (frameEnts.find((e: any) => e.anomaly_type === 'black_hole') ??
              Object.values(ecsEntitiesRef.current).find((e: any) => e.anomaly_type === 'black_hole')) as any;
            if (bhEnt) setSpectatorTargetId(bhEnt.id);
            // Zoom out dramatically
            setZoom(prev => Math.min(prev + 8, 25));
            // Show death screen after BH animation (3s drama, then death screen)
            if (bhAutoResetTimerRef.current) clearTimeout(bhAutoResetTimerRef.current);
            bhAutoResetTimerRef.current = setTimeout(() => {
              triggerDeathScreen('blackhole');
              bhAutoResetTimerRef.current = null;
            }, 3000);
          }
          if (data.objective !== undefined) {
            setObjective(data.objective as string);
          }
          if (data.radar_filters !== undefined) {
            // radar_filters is handled via prop passing to HUD
          }
          if (data.audio_settings !== undefined) {
            const settings = data.audio_settings;
            if (settings.game_muted !== undefined) setIsMuted(settings.game_muted);
            if (settings.ai_muted !== undefined) setIsRachelEnabled(!settings.ai_muted);
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

          dispatchTelemetryRef.current('collision', `Collided at speed ${data.speed ?? 1.0}`, 'medium');

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
          } else {
            entitiesObj = data.entities;
          }

          // Always update the ref (60fps) — used by 3D scene via useFrame (no React re-render)
          ecsEntitiesRef.current = entitiesObj;

          // Boundary proximity — flash blue when within 4 000 u of the 64 000 u shell
          const playerEntBoundary = Array.isArray(data.entities)
            ? data.entities.find((e: any) => e.ent_type === 'player')
            : null;
          if (playerEntBoundary) {
            const bx = playerEntBoundary.x || 0;
            const by = playerEntBoundary.y || 0;
            const bz = playerEntBoundary.z || 0;
            if (Math.sqrt(bx * bx + by * by + bz * bz) > 60000) {
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

          if (Array.isArray(data.entities)) {
            data.entities.forEach((ent: any) => {
              if (ent.is_newborn && !newbornIds.has(ent.id)) {
                newIds.add(ent.id);
                hasNew = true;
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
                setTimeout(() => {
                  setDyingIds(prev => {
                    const s = new Set(prev);
                    s.delete(ent.id);
                    return s;
                  });
                }, 1200);
              }
            });
          }
          if (hasNew) setNewbornIds(newIds);
          if (hasDying) setDyingIds(dropIds);

          // Throttle React state updates to ~10fps to avoid 60fps re-renders.
          // Spawn/despawn events always get an immediate update so meshes appear/disappear promptly.
          ecsFrameCounterRef.current++;
          if (hasNew || hasDying || ecsFrameCounterRef.current % 6 === 0) {
            setEcsEntities(entitiesObj);
          }
        } else if (data.type === 'global_override') {
          setGlobalOverride(prev => ({
            ...prev,
            sun_visible: data.sun_visible !== undefined ? data.sun_visible : prev.sun_visible,
            ambient_color: data.ambient_color || prev.ambient_color,
            ambient_intensity: data.ambient_intensity !== undefined ? data.ambient_intensity : prev.ambient_intensity,
            skybox_color: data.skybox_color || prev.skybox_color,
          }));
          if (data.is_time_frozen !== undefined) setIsTimeFrozen(data.is_time_frozen);
        }
      } catch (err) {
        // ignore parsing errors for tick data
      }
    }
  }, [ecsMessage, playCollisionSound, handleFullReset, triggerDeathScreen, showDeathScreen]);

  // Handle incoming WebSocket messages
  useEffect(() => {
    if (lastMessage !== null) {
      try {
        const data = JSON.parse(lastMessage.data);

        if (data.type === 'transcript') {
          // Received back from the Python Director for voice transcriptions
          setChatHistory(prev => [...prev, { sender: 'user', text: data.content, timestamp: new Date() }]);
        } else if (data.type === 'text') {
          // Only used for error/fallback messages now (Tier 0 narrative fallback).
          // Normal LLM replies arrive bundled inside 'generation_result'.

          // Deduplication: Don't add if it's the exact same as the last Rachel message (e.g. double welcome)
          setChatHistory(prev => {
            if (prev.length > 0) {
              const last = prev[prev.length - 1];
              if (last.sender === 'rachel' && last.text === data.content) return prev;
            }
            return [...prev, { sender: 'rachel', text: data.content, timestamp: new Date() }];
          });
          setDirectorMessage(data.content);
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
        } else if (data.type === 'texture_ready') {
          setCustomTextureUrl(data.url);
          setDirectorMessage("New AI texture applied.");
          setAiState("idle");
        } else if (data.type === 'proactive_audio') {
          setDirectorMessage("Rachel looks on: " + data.text);
          setChatHistory(prev => [...prev, { sender: 'rachel', text: data.text, timestamp: new Date() }]);
          setAiState("synthesizing");

          // Check for audio_url first (Piper TTS), fall back to audio_b64 (ElevenLabs)
          if (data.audio_url) {
            playAudioFromUrl(data.audio_url, data.text);
          } else if (data.audio_b64 && isRachelEnabled) {
            try {
              const audio = new Audio("data:audio/mp3;base64," + data.audio_b64);
              audio.play().catch(e => { });
            } catch (err) { }
          }
          setTimeout(() => setAiState("idle"), 4000);
        } else if (data.type === 'generation_result') {
          // Text + Audio arrive together for synchronized display
          if (data.text) {
            setDirectorMessage(data.text);
            setChatHistory(prev => [...prev, { sender: 'rachel', text: data.text, timestamp: new Date() }]);
          }
          if (data.world_state) {
            setWorldState(data.world_state);
          }
          // Check for audio_url first (Piper TTS), fall back to audio_b64 (ElevenLabs)
          if (data.audio_url) {
            playAudioFromUrl(data.audio_url, data.text || "");
          } else if (data.audio_b64 && isRachelEnabled) {
            try {
              const audio = new Audio("data:audio/mp3;base64," + data.audio_b64);
              audio.play().catch(e => { });
            } catch (err) { }
          }
        }
      } catch (err) {
        // Suppress parsing errors
      }
    }
  }, [lastMessage, playAudioFromUrl, isRachelEnabled]);

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
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        if (audioContextRef.current) {
          audioContextRef.current.close().catch(() => { });
          audioContextRef.current = null;
        }
        analyserRef.current = null;
        setVolumeLevel(0);

        if (!hasAudioDetected.current) {
          setDirectorMessage('No audio detected! Please check your microphone source.');
          setAiState('idle');
          return;
        }

        const fullBlob = new Blob(audioChunks.current, { type: mimeType });
        if (readyState === ReadyState.OPEN) {
          // We don't have the transcript yet, but we've finished recording.
          // The transcript will come back via the websocket handled above.
          sendMessage(fullBlob);
          const playerEnt = Object.values(ecsEntitiesRef.current).find((e: any) => e.ent_type === 'player') as any;
          sendMessage(JSON.stringify({
            type: 'audio_end',
            player_position: {
              x: playerEnt?.x || 0,
              y: playerEnt?.y || 0,
              z: playerEnt?.z || 0
            }
          }));
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
        @keyframes bh-warp {
          0%   { opacity: 0; transform: scale(1.05); }
          30%  { opacity: 1; transform: scale(1.0); }
          100% { opacity: 1; transform: scale(1.0); }
        }
        @keyframes death-fade-in {
          0%   { opacity: 0; }
          100% { opacity: 1; }
        }
        @keyframes death-glitch {
          0%   { transform: translate(0, 0) skewX(0deg); opacity: 0; }
          10%  { transform: translate(-3px, 2px) skewX(-2deg); opacity: 0.3; }
          20%  { transform: translate(5px, -1px) skewX(3deg); opacity: 0.6; }
          30%  { transform: translate(-2px, 3px) skewX(-1deg); opacity: 0.4; }
          40%  { transform: translate(4px, -2px) skewX(2deg); opacity: 0.8; }
          50%  { transform: translate(0, 0) skewX(0deg); opacity: 1; }
          100% { transform: translate(0, 0) skewX(0deg); opacity: 1; }
        }
        @keyframes death-scanline {
          0%   { top: -10%; }
          100% { top: 110%; }
        }
        @keyframes death-pulse {
          0%, 100% { opacity: 0.4; }
          50%      { opacity: 1; }
        }
        @keyframes death-stats-slide {
          0%   { transform: translateY(30px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        @keyframes death-prompt-blink {
          0%, 100% { opacity: 0.3; }
          50%      { opacity: 1; }
        }
        @keyframes lvl-enter {
          0%   { opacity: 0; transform: scale(0.8); }
          50%  { opacity: 1; transform: scale(1.05); }
          70%  { transform: scale(0.98); }
          100% { opacity: 1; transform: scale(1.0); }
        }
        @keyframes lvl-exit {
          0%   { opacity: 1; transform: scale(1.0); }
          100% { opacity: 0; transform: scale(1.3); filter: blur(8px); }
        }
        @keyframes lvl-number-slam {
          0%   { transform: scale(4) rotate(-5deg); opacity: 0; filter: blur(10px); }
          40%  { transform: scale(1.1) rotate(1deg); opacity: 1; filter: blur(0); }
          55%  { transform: scale(0.95) rotate(-0.5deg); }
          70%  { transform: scale(1.02) rotate(0deg); }
          100% { transform: scale(1.0) rotate(0deg); opacity: 1; }
        }
        @keyframes lvl-line-expand {
          0%   { width: 0; opacity: 0; }
          100% { width: 200px; opacity: 1; }
        }
        @keyframes lvl-subtitle-rise {
          0%   { transform: translateY(20px); opacity: 0; letter-spacing: 0.8em; }
          100% { transform: translateY(0); opacity: 1; letter-spacing: 0.5em; }
        }
        @keyframes lvl-flash {
          0%   { opacity: 0.6; }
          100% { opacity: 0; }
        }
        @keyframes lvl-ring-expand {
          0%   { transform: scale(0); opacity: 0.8; }
          100% { transform: scale(3); opacity: 0; }
        }
        @keyframes lvl-particles {
          0%   { transform: translateY(0) scale(1); opacity: 1; }
          100% { transform: translateY(-80px) scale(0); opacity: 0; }
        }
        @keyframes cinematic-shake {
          0%,100% { transform: translate(0,0) rotate(0deg); }
          15% { transform: translate(-6px, 4px) rotate(-1deg); }
          30% { transform: translate(6px, -4px) rotate(1deg); }
          45% { transform: translate(-4px, 6px) rotate(-0.5deg); }
          60% { transform: translate(4px, -6px) rotate(0.5deg); }
          75% { transform: translate(-2px, 2px) rotate(-0.3deg); }
        }
        .cinematic-shake { animation: cinematic-shake 0.6s ease-in-out; }
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
              ecsEntitiesRef={ecsEntitiesRef}
              particles={particles}
              zoom={zoom}
              newbornIds={newbornIds}
              dyingIds={dyingIds}
              realityOverride={worldState?.reality_override}
              playerSpaceship={worldState?.player_spaceship}
              visualConfig={worldState?.visual_config}
              camYawRef={camYawRef}
              camPitchRef={camPitchRef}
              targetedEntityId={targetedEntityId}
              spectatorTargetId={spectatorTargetId}
              globalOverride={globalOverride}
              customTextureUrl={customTextureUrl}
            />
          </Canvas>
        </div>

        {/* Black Hole Death Overlay */}
        {blackHoleDeath && (
          <div className="absolute inset-0 z-[190] pointer-events-none flex items-center justify-center" style={{ animation: 'bh-warp 0.8s ease-in forwards' }}>
            <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at center, transparent 20%, rgba(0,0,0,0.6) 60%, rgba(0,0,0,0.97) 100%)' }} />
            <div className="relative flex flex-col items-center gap-6 z-10">
              <div className="text-red-500 text-[11px] font-mono font-black uppercase tracking-[0.6em] animate-pulse">Signal Lost</div>
              <div className="text-white/90 text-4xl font-mono font-black uppercase tracking-[0.3em]" style={{ textShadow: '0 0 40px rgba(255,30,30,0.8)' }}>CONNECTION SEVERED</div>
              <div className="text-neutral-500 text-[11px] font-mono uppercase tracking-[0.4em]">Consumed by Schwarzschild Radius</div>
              <div className="mt-4 text-neutral-600 text-[10px] font-mono uppercase tracking-[0.3em] animate-pulse">Rebooting neural link...</div>
            </div>
          </div>
        )}

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

        {/* ── Death / Game Over Screen ── */}
        {showDeathScreen && (
          <div
            className="absolute inset-0 z-[200] flex items-center justify-center cursor-pointer"
            style={{ animation: 'death-fade-in 0.6s ease-out forwards' }}
            onClick={handleFullReset}
            onKeyDown={handleFullReset}
            tabIndex={0}
            ref={(el) => el?.focus()}
          >
            {/* Dark vignette background */}
            <div className="absolute inset-0" style={{
              background: deathReason === 'blackhole'
                ? 'radial-gradient(ellipse at center, rgba(20,0,40,0.85) 0%, rgba(0,0,0,0.97) 60%)'
                : deathReason === 'restart'
                  ? 'radial-gradient(ellipse at center, rgba(0,10,30,0.85) 0%, rgba(0,0,0,0.97) 60%)'
                  : 'radial-gradient(ellipse at center, rgba(40,0,0,0.85) 0%, rgba(0,0,0,0.97) 60%)',
            }} />

            {/* Scanline effect */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
              <div className="absolute left-0 w-full h-[2px] opacity-20" style={{
                background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)',
                animation: 'death-scanline 2s linear infinite',
              }} />
            </div>

            {/* CRT noise overlay */}
            <div className="absolute inset-0 pointer-events-none opacity-[0.03]" style={{
              backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noise\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noise)\'/%3E%3C/svg%3E")',
            }} />

            {/* Main content */}
            <div className="relative flex flex-col items-center gap-8 z-10">
              {/* Glitch title */}
              <div style={{ animation: 'death-glitch 1.2s ease-out forwards' }}>
                <div className="text-[11px] font-mono font-black uppercase tracking-[0.8em] mb-4" style={{
                  color: deathReason === 'blackhole' ? '#a855f7' : deathReason === 'restart' ? '#38bdf8' : '#ef4444',
                  animation: 'death-pulse 2s ease-in-out infinite',
                  textShadow: deathReason === 'blackhole'
                    ? '0 0 20px rgba(168,85,247,0.6)'
                    : deathReason === 'restart'
                      ? '0 0 20px rgba(56,189,248,0.6)'
                      : '0 0 20px rgba(239,68,68,0.6)',
                }}>
                  {deathReason === 'blackhole' ? 'Event Horizon Breach' : deathReason === 'restart' ? 'System Reboot' : 'Hull Integrity Critical'}
                </div>

                <div className="text-5xl font-mono font-black uppercase tracking-[0.2em] text-white/95" style={{
                  textShadow: deathReason === 'blackhole'
                    ? '0 0 60px rgba(168,85,247,0.5), 0 0 120px rgba(168,85,247,0.2)'
                    : deathReason === 'restart'
                      ? '0 0 60px rgba(56,189,248,0.5), 0 0 120px rgba(56,189,248,0.2)'
                      : '0 0 60px rgba(239,68,68,0.5), 0 0 120px rgba(239,68,68,0.2)',
                }}>
                  {deathReason === 'blackhole' ? 'CONSUMED' : deathReason === 'restart' ? 'RESETTING' : 'DESTROYED'}
                </div>
              </div>

              {/* Subtitle */}
              <div className="text-neutral-500 text-[11px] font-mono uppercase tracking-[0.5em]" style={{ animation: 'death-stats-slide 0.8s ease-out 0.4s both' }}>
                {deathReason === 'blackhole'
                  ? 'Spacetime fabric torn beyond repair'
                  : deathReason === 'restart'
                    ? 'Neural link reinitializing...'
                    : 'All systems offline — no life signs detected'}
              </div>

              {/* Stats */}
              {deathReason !== 'restart' && (
                <div className="flex gap-12 mt-4" style={{ animation: 'death-stats-slide 0.8s ease-out 0.7s both' }}>
                  <div className="flex flex-col items-center gap-1">
                    <div className="text-[9px] uppercase tracking-[0.5em] text-neutral-600 font-mono font-bold">Final Level</div>
                    <div className="text-3xl font-black font-mono text-sky-400" style={{ textShadow: '0 0 20px rgba(56,189,248,0.5)' }}>{deathStats.level}</div>
                  </div>
                  <div className="w-px bg-white/10" />
                  <div className="flex flex-col items-center gap-1">
                    <div className="text-[9px] uppercase tracking-[0.5em] text-neutral-600 font-mono font-bold">Total Kills</div>
                    <div className="text-3xl font-black font-mono text-purple-400" style={{ textShadow: '0 0 20px rgba(168,85,247,0.5)' }}>{deathStats.score}</div>
                  </div>
                </div>
              )}

              {/* Prompt to continue */}
              <div className="mt-8 text-neutral-400 text-[10px] font-mono uppercase tracking-[0.4em]" style={{ animation: 'death-prompt-blink 1.5s ease-in-out infinite 1.2s both' }}>
                [ Click or press any key to restart ]
              </div>

              {/* Decorative line */}
              <div className="w-48 h-px mt-2" style={{
                background: deathReason === 'blackhole'
                  ? 'linear-gradient(90deg, transparent, rgba(168,85,247,0.4), transparent)'
                  : deathReason === 'restart'
                    ? 'linear-gradient(90deg, transparent, rgba(56,189,248,0.4), transparent)'
                    : 'linear-gradient(90deg, transparent, rgba(239,68,68,0.4), transparent)',
              }} />
            </div>
          </div>
        )}

        {showLevelTransition && (
          <div
            className="absolute inset-0 z-[205] pointer-events-none flex items-center justify-center overflow-hidden"
            style={{
              animation: `lvl-enter 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards, lvl-exit 0.8s ease-in 2.7s forwards`,
              background: 'radial-gradient(circle at center, rgba(15, 23, 42, 0.95) 0%, rgba(2, 6, 23, 1) 100%)',
            }}
          >
            {/* Flash burst */}
            <div className="absolute inset-0" style={{
              background: 'radial-gradient(circle at center, rgba(56,189,248,0.3) 0%, transparent 60%)',
              animation: 'lvl-flash 1.0s ease-out forwards',
            }} />

            {/* Expanding ring */}
            <div className="absolute" style={{
              width: 200, height: 200,
              border: '2px solid rgba(56,189,248,0.4)',
              borderRadius: '50%',
              animation: 'lvl-ring-expand 1.5s ease-out forwards',
            }} />
            <div className="absolute" style={{
              width: 200, height: 200,
              border: '1px solid rgba(168,85,247,0.3)',
              borderRadius: '50%',
              animation: 'lvl-ring-expand 1.5s ease-out 0.2s forwards',
            }} />

            {/* Rising particles */}
            {[...Array(8)].map((_, i) => (
              <div key={i} className="absolute" style={{
                width: 4, height: 4,
                borderRadius: '50%',
                background: i % 2 === 0 ? '#38bdf8' : '#a855f7',
                boxShadow: i % 2 === 0 ? '0 0 8px #38bdf8' : '0 0 8px #a855f7',
                left: `${45 + Math.sin(i * 0.785) * 15}%`,
                top: `${55 + Math.cos(i * 0.785) * 8}%`,
                animation: `lvl-particles 1.2s ease-out ${0.3 + i * 0.08}s forwards`,
                opacity: 0,
              }} />
            ))}

            {/* Content */}
            <div className="relative flex flex-col items-center z-10">
              {/* Pre-title */}
              <div className="text-[10px] font-mono font-bold uppercase tracking-[0.8em] text-sky-400/60 mb-6" style={{
                animation: 'lvl-subtitle-rise 0.6s ease-out 0.2s both',
              }}>
                Entering
              </div>

              {/* Big level number */}
              <div className="flex items-baseline gap-4 mb-4">
                <div className="text-[11px] font-mono font-bold uppercase tracking-[0.5em] text-neutral-500" style={{
                  animation: 'lvl-subtitle-rise 0.6s ease-out 0.3s both',
                }}>
                  Level
                </div>
                <div className="text-8xl font-black font-mono text-white" style={{
                  animation: 'lvl-number-slam 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.1s both',
                  textShadow: '0 0 80px rgba(56,189,248,0.6), 0 0 160px rgba(168,85,247,0.3), 0 4px 0 rgba(0,0,0,0.3)',
                  WebkitTextStroke: '1px rgba(56,189,248,0.3)',
                }}>
                  {transitionLevel}
                </div>
              </div>

              {/* Decorative line */}
              <div className="h-px bg-gradient-to-r from-transparent via-sky-400/50 to-transparent" style={{
                animation: 'lvl-line-expand 0.6s ease-out 0.5s both',
              }} />

              {/* Subtitle */}
              <div className="mt-5 text-[10px] font-mono uppercase tracking-[0.5em] text-neutral-400" style={{
                animation: 'lvl-subtitle-rise 0.6s ease-out 0.7s both',
              }}>
                {transitionLevel <= 3 ? 'Threat Level: Low'
                  : transitionLevel <= 6 ? 'Threat Level: Moderate'
                    : transitionLevel <= 9 ? 'Threat Level: High'
                      : transitionLevel <= 12 ? 'Threat Level: Extreme'
                        : 'Threat Level: Apocalyptic'}
              </div>
            </div>
          </div>
        )}

        {/* Tactical HUD Overlay — Now handles all status icons and buttons */}
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
          radarFilters={worldState?.radar_filters}
          audioSettings={worldState?.audio_settings}
          readyState={readyState}
          isRachelEnabled={isRachelEnabled}
          setIsRachelEnabled={setIsRachelEnabled}
          isMuted={isMuted}
          setIsMuted={handleToggleMute}
          visualConfig={worldState?.visual_config}
          spectatorTargetId={spectatorTargetId}
          setSpectatorTargetId={setSpectatorTargetId}
          onReset={() => triggerDeathScreen('restart')}
          onFocusModeChange={handleFocusModeChange}
          sidebarWidth={sidebarWidth}
          isResizing={isResizing}
        />

        {/* Cinematic Level Transition Overlay */}
        {isTransitioning && (
          <div className="fixed inset-0 z-[100] pointer-events-none flex items-center justify-center overflow-hidden">
            {/* Warp Speed Streaks */}
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-pulse" />
            <div className="absolute inset-0 opacity-40">
              {[...Array(20)].map((_, i) => (
                <div
                  key={i}
                  className="absolute bg-white rounded-full animate-warp-streak"
                  style={{
                    top: `${Math.random() * 100}%`,
                    left: `${Math.random() * 100}%`,
                    width: `${2 + Math.random() * 5}px`,
                    height: `${40 + Math.random() * 100}px`,
                    animationDelay: `${Math.random() * 2}s`,
                    opacity: 0.3 + Math.random() * 0.7,
                  }}
                />
              ))}
            </div>

            {/* Transition Text */}
            <div className="relative group flex flex-col items-center">
              <div className="absolute -inset-20 bg-purple-600/20 blur-[100px] rounded-full animate-pulse" />
              <h1 className="text-6xl font-black text-white italic tracking-[1em] uppercase animate-level-text shadow-2xl">
                Level {currentLevel} Secured
              </h1>
              <div className="h-0.5 w-64 bg-gradient-to-r from-transparent via-purple-500 to-transparent mt-4 animate-scale-x" />
              <p className="mt-4 text-purple-400 font-mono text-sm tracking-[0.5em] uppercase opacity-80">
                Engaging Slipstream Drive
              </p>
            </div>
          </div>
        )}

        {/* The Director's Console (Left Sidebar) */}
        <div
          className={`fixed left-0 top-0 h-screen bg-black/80 backdrop-blur-3xl border-r border-white/10 z-50 flex flex-col p-6 shadow-[10px_0_50px_rgba(0,0,0,0.5)] ${isChatVisible ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0'}`}
          style={{ width: `${sidebarWidth}px`, transition: isResizing ? 'none' : 'transform 0.5s ease-out, opacity 0.5s ease-out' }}
        >
          {/* Resize Handle */}
          <div
            onMouseDown={startResizing}
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-purple-500/30 transition-colors z-[60]"
          />

          <div className="flex flex-col gap-4 mb-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-2.5 h-2.5 rounded-full ${readyState === 1 ? 'bg-green-500 shadow-[0_0_12px_rgba(34,197,94,0.6)]' : 'bg-red-500 animate-pulse shadow-[0_0_12px_rgba(239,68,68,0.6)]'}`} />
                <h2 className="text-[11px] font-black text-white/90 uppercase tracking-[0.3em]">Link Sync</h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const nextState = !isRachelEnabled;
                    setIsRachelEnabled(nextState);
                    handleToggleMute(!nextState);
                  }}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all ${isRachelEnabled ? 'bg-purple-500/10 border-purple-500/20 text-purple-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}
                  title={isRachelEnabled ? "Mute Rachel" : "Unmute Rachel"}
                >
                  {isRachelEnabled ? <Bot className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
                  <span className="text-[10px] font-mono font-bold uppercase tracking-tight">
                    {isRachelEnabled ? 'Voice: Up' : 'Muted'}
                  </span>
                </button>
                <button
                  onClick={() => setIsChatVisible(false)}
                  className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-neutral-500 hover:text-white"
                  title="Minimize Console"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 flex flex-col gap-6 min-h-0">
            {/* Conversations / Subtitles */}
            <div className="flex-1 flex flex-col bg-white/5 border border-white/10 rounded-xl shadow-inner group hover:border-purple-500/30 transition-colors min-h-0 overflow-hidden">
              <div className="flex-1 min-h-0">
                <ChatLog
                  messages={chatHistory}
                  onRetry={() => (window as any).clearFailedState && (window as any).clearFailedState()}
                  isThinking={aiState !== 'idle'}
                />
              </div>
            </div>
          </div>

          {/* Control Interface inside sidebar */}
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
                  const playerEnt = Object.values(ecsEntitiesRef.current).find((e: any) => e.ent_type === 'player') as any;
                  sendMessage(JSON.stringify({
                    type: 'text_command',
                    text: textInput,
                    player_position: {
                      x: playerEnt?.x || 0,
                      y: playerEnt?.y || 0,
                      z: playerEnt?.z || 0
                    }
                  }));
                  setChatHistory(prev => [...prev, { sender: 'user', text: textInput, timestamp: new Date() }]);
                  setTextInput('');
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

          </div>
        </div>

        {/* Global UI Toggle (Visible when sidebar is hidden) */}
        {!isChatVisible && (
          <button
            onClick={() => setIsChatVisible(true)}
            className="fixed left-8 bottom-8 z-50 w-12 h-12 bg-black/60 backdrop-blur-xl border border-white/20 rounded-xl flex items-center justify-center text-purple-400 hover:text-white hover:bg-purple-600/20 transition-all shadow-[0_0_30px_rgba(168,85,247,0.2)] group"
            title="Open Director Console"
          >
            <Server className="w-6 h-6 group-hover:scale-110 transition-transform" />
          </button>
        )}
      </div>

    </>
  );
}
