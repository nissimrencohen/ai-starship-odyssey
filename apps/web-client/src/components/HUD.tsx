import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Save, FolderOpen, RotateCcw, FastForward, Volume2, VolumeX, Target, Wifi, WifiOff } from 'lucide-react';

interface HUDProps {
  playerHealth: number;      // 0 – 100
  score: number;
  currentLevel: number;
  entities: Record<string, any>;
  showDamageFlash: boolean;
  showSuccessFlash: boolean;
  isGameOver: boolean;
  objective: string;
  isChatVisible: boolean;
  radarFilters?: Record<string, boolean>;
  audioSettings?: { game_muted: boolean; ai_muted: boolean };
  // Connection & Control Props from App
  readyState: number;
  isRachelEnabled: boolean;
  setIsRachelEnabled: (val: boolean) => void;
  isMuted: boolean;
  setIsMuted: (val: boolean) => void;
  visualConfig?: any;
  spectatorTargetId?: number | null;
  setSpectatorTargetId?: React.Dispatch<React.SetStateAction<number | null>>;
  onReset?: () => void;
  onFocusModeChange?: (isOpen: boolean) => void;
  sidebarWidth?: number;
  isResizing?: boolean;
}

const WORLD_RADIUS = 64000.0;

// Mini-radar constants
const RADAR_R = 70;
const CX = 80;
const CY = 80;

// Tactical map constants
const MAP_CANVAS = 680;
const MAP_CX = MAP_CANVAS / 2;
const MAP_CY = MAP_CANVAS / 2;
const MAP_R = MAP_CANVAS / 2 - 24;

function drawRadarFrame(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  entities: Record<string, any>,
  scale: number,
  visibleTypes: Record<string, boolean>
) {
  const toRX = (wx: number) => cx + wx * scale;
  const toRY = (wz: number) => cy + wz * scale;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = 'rgba(0, 8, 18, 0.92)';
  ctx.fillRect(cx - r - 2, cy - r - 2, (r + 2) * 2, (r + 2) * 2);

  [0.25, 0.5, 0.75, 1.0].forEach(frac => {
    ctx.beginPath();
    ctx.arc(cx, cy, r * frac, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 255, 200, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  ctx.strokeStyle = 'rgba(0, 255, 200, 0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
  ctx.restore();

  const entArray = Object.values(entities) as any[];

  if (visibleTypes['asteroid']) {
    entArray
      .filter(e => e.ent_type === 'asteroid' && !e.is_dying && !e.is_cloaked)
      .forEach(e => {
        const rx = toRX(e.x);
        const ry = toRY(e.z || 0);
        ctx.beginPath();
        ctx.arc(rx, ry, scale > 0.005 ? 1.5 : 1, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(68, 68, 68, 0.18)';
        ctx.fill();
      });
  }

  entArray
    .filter(e => {
      if (e.ent_type === 'planet') return visibleTypes['planet'];
      if (e.ent_type === 'moon') return visibleTypes['moon'];
      return false;
    })
    .filter(e => !e.is_cloaked)
    .forEach(e => {
      const rx = toRX(e.x);
      const ry = toRY(e.z || 0);
      const size = (e.ent_type === 'planet' ? 3.5 : 2.0) * (scale > 0.005 ? 1.8 : 1);
      const color = e.ent_type === 'planet' ? '#60a5fa' : '#a8a8a8';
      const grad = ctx.createRadialGradient(rx, ry, 0, rx, ry, size + 1);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'rgba(59,130,246,0)');
      ctx.beginPath();
      ctx.arc(rx, ry, size, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    });

  entArray
    .filter(e => (e.ent_type === 'enemy' || e.ent_type === 'alien_ship' || e.ent_type === 'companion' || e.ent_type === 'neutral') && !e.is_dying && !e.is_cloaked)
    .forEach(e => {
      const isAlly = e.ent_type === 'companion' || e.faction === 'federation';
      const isNeutral = e.ent_type === 'neutral';

      if (isAlly && !visibleTypes['federation']) return;
      if (isNeutral && !visibleTypes['neutral']) return;
      if (!isAlly && !isNeutral && !visibleTypes['enemy']) return;

      const rx = toRX(e.x);
      const ry = toRY(e.z || 0);
      const dotR = scale > 0.005 ? 3.5 : 2.2;
      ctx.beginPath();
      ctx.arc(rx, ry, dotR, 0, Math.PI * 2);

      if (isAlly) ctx.fillStyle = 'rgba(14, 165, 233, 0.9)';
      else if (isNeutral) ctx.fillStyle = 'rgba(8, 145, 178, 0.9)'; // Cyan
      else ctx.fillStyle = 'rgba(239, 68, 68, 0.85)'; // Hostile Red

      ctx.fill();
      ctx.shadowBlur = 4;
      ctx.shadowColor = ctx.fillStyle as string;
      ctx.stroke();
      ctx.shadowBlur = 0;
    });

  if (visibleTypes['station']) {
    entArray
      .filter(e => (e.ent_type === 'space_station' || e.ent_type === 'station') && !e.is_cloaked)
      .forEach(e => {
        const rx = toRX(e.x);
        const ry = toRY(e.z || 0);
        const sz = scale > 0.005 ? 6 : 4;
        ctx.shadowBlur = 8;
        ctx.shadowColor = '#10b981';
        ctx.fillStyle = '#10b981';
        ctx.fillRect(rx - sz / 2, ry - sz / 2, sz, sz);
        ctx.strokeStyle = '#34d399';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rx - sz / 2, ry - sz / 2, sz, sz);
        ctx.shadowBlur = 0;
      });
  }

  if (visibleTypes['anomaly']) {
    entArray
      .filter(e => e.ent_type === 'anomaly' && !e.is_cloaked)
      .forEach(e => {
        const rx = toRX(e.x);
        const ry = toRY(e.z || 0);
        const sz = scale > 0.005 ? 5 : 3;
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#d946ef';
        ctx.beginPath();
        ctx.arc(rx, ry, sz, 0, Math.PI * 2);
        ctx.fillStyle = '#d946ef';
        ctx.fill();
        ctx.strokeStyle = '#f0abfc';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.shadowBlur = 0;
      });
  }

  if (visibleTypes['sun']) {
    const hasSun = entArray.some(e => e.ent_type === 'sun');
    if (hasSun) {
      const sunR = scale > 0.005 ? 10 : 6;
      const sunGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, sunR);
      sunGrad.addColorStop(0, '#fde68a');
      sunGrad.addColorStop(0.6, '#f59e0b');
      sunGrad.addColorStop(1, 'rgba(251,191,36,0)');
      ctx.beginPath();
      ctx.arc(cx, cy, sunR, 0, Math.PI * 2);
      ctx.fillStyle = sunGrad;
      ctx.fill();
    }
  }

  if (visibleTypes['you']) {
    const playerEnt = entArray.find(e => e.ent_type === 'player');
    if (playerEnt && !playerEnt.is_cloaked) {
      const rx = toRX(playerEnt.x);
      const ry = toRY(playerEnt.z || 0);
      const rot: number = playerEnt.rotation ?? 0;
      const tipLen = scale > 0.005 ? 12 : 8;
      ctx.save();
      ctx.translate(rx, ry);
      ctx.rotate(rot + Math.PI / 2);
      ctx.shadowColor = 'rgba(255, 255, 255, 0.6)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(0, -tipLen);
      ctx.lineTo(-tipLen * 0.6, tipLen * 0.6);
      ctx.lineTo(tipLen * 0.6, tipLen * 0.6);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 255, 200, 0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(cx, cy, scale > 0.005 ? 4 : 2.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = 'cyan'; ctx.lineWidth = 1; ctx.stroke();
    }
  }
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(0, 255, 200, 0.25)'; ctx.lineWidth = 1.5; ctx.stroke();
}

function ControlButton({ icon, label, color, onClick }: { icon: React.ReactNode, label: string, color: string, onClick: () => void }) {
  const colors = {
    cyan: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20',
    green: 'bg-green-500/10 border-green-500/30 text-green-400 hover:bg-green-500/20',
    red: 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20',
    amber: 'bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20',
    fuchsia: 'bg-fuchsia-500/10 border-fuchsia-500/30 text-fuchsia-400 hover:bg-fuchsia-500/20',
  }[color as 'cyan' | 'green' | 'red' | 'amber' | 'fuchsia'];

  return (
    <button onClick={onClick} className={`group flex items-center gap-2 px-3 py-1.5 border rounded-lg text-[9px] font-mono uppercase tracking-[0.2em] transition-all ${colors}`}>
      <span className="group-hover:scale-110 transition-transform">{icon}</span>
      {label}
    </button>
  );
}

export function HUD({
  playerHealth, score, currentLevel, entities, showDamageFlash, showSuccessFlash, isGameOver, objective, isChatVisible, radarFilters, audioSettings, readyState, isRachelEnabled, setIsRachelEnabled, isMuted, setIsMuted, visualConfig, spectatorTargetId, setSpectatorTargetId, onReset, onFocusModeChange, sidebarWidth = 450, isResizing = false
}: HUDProps) {
  const radarRef = useRef<HTMLCanvasElement>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const openMap = useCallback(() => { setIsExpanded(true); onFocusModeChange?.(true); }, [onFocusModeChange]);
  const closeMap = useCallback(() => { setIsExpanded(false); onFocusModeChange?.(false); }, [onFocusModeChange]);
  const [visibilityFilters, setVisibilityFilters] = useState<Record<string, boolean>>({ sun: true, planet: true, moon: true, federation: true, enemy: true, station: true, anomaly: true, asteroid: true, you: true, neutral: true });
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false);

  useEffect(() => {
    if (readyState === 1 && !hasConnectedOnce) {
      setHasConnectedOnce(true);
    }
  }, [readyState, hasConnectedOnce]);

  useEffect(() => { if (radarFilters) setVisibilityFilters(prev => ({ ...prev, ...radarFilters })); }, [radarFilters]);

  // Escape key to exit spectator mode
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && setSpectatorTargetId) {
        setSpectatorTargetId(null);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [setSpectatorTargetId]);

  const [hoveredEntity, setHoveredEntity] = useState<any | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const healthPct = Math.max(0, Math.min(100, playerHealth)) / 100;
  const healthColor = playerHealth > 50 ? '#10b981' : playerHealth > 25 ? '#f59e0b' : '#ef4444';

  useEffect(() => {
    const canvas = radarRef.current; if (!canvas) return; const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height); drawRadarFrame(ctx, CX, CY, RADAR_R, entities, RADAR_R / WORLD_RADIUS, visibilityFilters);
  }, [entities, visibilityFilters]);

  useEffect(() => {
    if (!isExpanded) return; const canvas = mapCanvasRef.current; if (!canvas) return; const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height); drawRadarFrame(ctx, MAP_CX, MAP_CY, MAP_R, entities, MAP_R / WORLD_RADIUS, visibilityFilters);
  }, [entities, isExpanded, visibilityFilters]);

  // ESC closes the tactical map
  useEffect(() => {
    if (!isExpanded) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMap(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isExpanded, closeMap]);

  const handleMapMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = mapCanvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const scale = MAP_R / WORLD_RADIUS; const entArray = Object.values(entities) as any[];
    let nearest: any = null, minDist = 2000 / scale;
    for (const ent of entArray) {
      const px = MAP_CX + ent.x * scale, py = MAP_CY + (ent.z || 0) * scale;
      const d = Math.sqrt((mx - px) ** 2 + (my - py) ** 2);
      if (d < minDist) { minDist = d; nearest = ent; }
    }
    setHoveredEntity(nearest ?? null); setTooltipPos(nearest ? { x: e.clientX, y: e.clientY } : null);
  }, [entities]);

  const handleMapMouseLeave = useCallback(() => { setHoveredEntity(null); setTooltipPos(null); }, []);

  const handleMapClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (hoveredEntity && setSpectatorTargetId) {
      setSpectatorTargetId(hoveredEntity.id);
      closeMap();
    }
  }, [hoveredEntity, setSpectatorTargetId]);

  const playerEnt = Object.values(entities).find((e: any) => e.ent_type === 'player') as any;

  const connectionStatusText = { [0]: 'Connecting...', [1]: 'Connected to Director', [2]: 'Closing...', [3]: 'Director Offline' }[readyState as 0 | 1 | 2 | 3] || 'Director Offline';

  return (
    <>
      {/* ── Initial Splash ────────── */}
      {!hasConnectedOnce && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-2xl transition-opacity duration-1000">
          <div className="flex flex-col items-center space-y-6 animate-pulse">
            <div className="relative">
              <div className="w-24 h-24 rounded-full bg-purple-500/10 border-2 border-purple-500/40 flex items-center justify-center shadow-[0_0_60px_rgba(168,85,247,0.4)]"><Wifi className="w-12 h-12 text-purple-400" /></div>
              <div className="absolute inset-0 rounded-full border border-purple-500/20 animate-ping" />
            </div>
            <div className="text-center space-y-2">
              <div className="text-2xl font-mono text-purple-400 tracking-[0.7em] uppercase font-black">Establishing Link</div>
              <div className="text-[10px] font-mono text-neutral-500 tracking-[0.4em] uppercase">Void Stream Synchronization in progress...</div>
            </div>
          </div>
        </div>
      )}

      {/* ── Overlay Vignettes ────────── */}
      {showDamageFlash && <div className="fixed inset-0 pointer-events-none z-[180] bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(220,30,30,0.65)_100%)] animate-[damage-flash_0.55s_ease-out_forwards]" />}
      {showSuccessFlash && <div className="fixed inset-0 pointer-events-none z-[180] bg-[radial-gradient(ellipse_at_center,transparent_30%,rgba(255,230,100,0.45)_100%)] animate-[damage-flash_0.4s_ease-out_forwards]" />}

      {/* ── Spectator Mode Overlay ────────── */}
      {spectatorTargetId !== null && spectatorTargetId !== undefined && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[300] flex flex-col items-center gap-2 animate-in slide-in-from-top-4 duration-500">
          <div className="bg-purple-900/40 border-2 border-purple-500 text-purple-200 px-8 py-3 rounded-full font-mono font-black uppercase tracking-[0.4em] backdrop-blur-md shadow-[0_0_30px_rgba(168,85,247,0.5)] flex items-center gap-6">
            SPECTATOR MODE - TIME FROZEN
            <button onClick={() => setSpectatorTargetId && setSpectatorTargetId(null)} className="flex items-center justify-center w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 transition-colors">✕</button>
          </div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-purple-400">Press ESC to return to Live Matrix</div>
        </div>
      )}

      {/* ── HUD Elements ────────── */}
      <div
        className={`fixed top-8 z-[150] pointer-events-none flex flex-col gap-10 ${isResizing ? '' : 'transition-all duration-300 ease-out'}`}
        style={{ left: isChatVisible ? `${sidebarWidth + 30}px` : '40px' }}
      >
        <div className="flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-[0.4em] text-neutral-500 font-mono font-bold">Hull Integrity</div>
          <div className="flex items-center gap-4">
            <div className="relative w-64 h-2 bg-black/60 rounded-full overflow-hidden border border-white/10 backdrop-blur-md">
              <div className="h-full rounded-full transition-all duration-300" style={{ width: `${healthPct * 100}%`, backgroundColor: healthColor, boxShadow: `0 0 20px ${healthColor}a0` }} />
            </div>
            <span className="text-xs font-mono font-black tabular-nums" style={{ color: healthColor }}>{Math.ceil(playerHealth)}%</span>
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2.5 max-w-sm">
            <div className="text-[10px] uppercase tracking-[0.4em] text-neutral-400 font-mono font-bold flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse shadow-[0_0_8px_cyan]" />Current Objective</div>
            <div className={`text-xs font-black font-mono tracking-widest uppercase py-3 px-5 border-l-4 rounded-r-2xl transition-all shadow-xl ${objective?.includes("COMMANDER OVERRIDE") ? 'border-[#f59e0b] text-[#f59e0b] bg-[#f59e0b]/10' : 'border-[#38bdf8] text-white bg-white/5'}`}>{objective || "Synchronizing Neural Stream..."}</div>
          </div>
          <div className="flex gap-12">
            <div className="flex flex-col gap-1.5"><div className="text-[9px] uppercase tracking-[0.4em] text-neutral-500 font-mono font-bold">Level</div><div className="text-xl font-black font-mono tracking-tighter text-sky-400 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">{currentLevel}</div></div>
            <div className="flex flex-col gap-1.5 border-l border-white/10 pl-10"><div className="text-[9px] uppercase tracking-[0.4em] text-neutral-500 font-mono font-bold">Kills</div><div className="text-xl font-black font-mono tracking-tighter text-purple-400 drop-shadow-[0_0_15px_rgba(168,85,247,0.5)]">{score}</div></div>
          </div>
        </div>
      </div>

      {/* Atmospheric Insertion Warning */}
      {(() => {
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

        let nearestAltitude = Infinity;
        if (playerEnt) {
          const px = playerEnt.x || 0;
          const py = playerEnt.y || 0;
          const pz = playerEnt.z || 0;
          Object.values(entities).forEach((ent: any) => {
            if (ent.ent_type === 'planet' || ent.ent_type === 'moon') {
              const dx = ent.x - px;
              const dy = (ent.y || 0) - py;
              const dz = (ent.z || 0) - pz;
              const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

              // Use the exact same radius calculation as EntityRenderer
              const r = ent.ent_type === 'planet' ? getPlanetRadius(ent.name) : (ent.radius || 30);

              const vScale = visualConfig?.planet_scale_overrides?.[ent.name] ?? 1.0;
              const scale = ent.scale || 1.0;
              const surfaceDist = dist - (r * scale * vScale);
              if (surfaceDist < nearestAltitude) nearestAltitude = surfaceDist;
            }
          });
        }
        if (nearestAltitude > 0 && nearestAltitude < 150) {
          return (
            <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[200] animate-[attack-pulse_1s_infinite_alternate] pointer-events-none drop-shadow-[0_0_20px_rgba(239,68,68,0.8)]">
              <div className="bg-red-500/20 border border-red-500 text-red-400 px-6 py-2 rounded-full font-mono font-black uppercase tracking-[0.3em] text-[12px] backdrop-blur-md">
                LOW ORBIT - ATMOSPHERIC INSERTION AVAILABLE
              </div>
            </div>
          );
        }
        return null;
      })()}

      {/* ── Top-Right Block ────────── */}
      <div className="fixed top-8 right-8 z-[150] flex flex-col items-end gap-4">
        <div className="flex items-center gap-2 p-1.5 bg-black/50 backdrop-blur-2xl border border-white/5 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.6)]">
          <ControlButton icon={<Save className="w-4 h-4" />} label="Save" color="cyan" onClick={async () => { try { await fetch("http://127.0.0.1:8080/save", { method: "POST" }); } catch (e) { } }} />
          <ControlButton icon={<FolderOpen className="w-4 h-4" />} label="Load" color="green" onClick={async () => { try { await fetch("http://127.0.0.1:8080/load", { method: "POST" }); } catch (e) { } }} />
          <ControlButton icon={<RotateCcw className="w-4 h-4" />} label="Reset" color="red" onClick={onReset ?? (async () => { try { await fetch("http://127.0.0.1:8080/api/engine/reset", { method: "POST" }); } catch (e) { } })} />
          {!isGameOver && <ControlButton icon={<FastForward className="w-4 h-4" />} label="Skip" color="amber" onClick={async () => { try { await fetch("http://127.0.0.1:8080/api/engine/next-level", { method: "POST" }); } catch (e) { } }} />}

        </div>
      </div>

      {/* ── Radar Block ────────── */}
      <div className="fixed z-[150] flex flex-col items-center gap-4" style={{ bottom: '40px', right: '40px' }}>
        <div className="flex flex-col items-center gap-1 font-mono select-none">
          <div className="text-[11px] uppercase tracking-[0.5em] text-neutral-500 font-black">Tactical Sphere</div>
          {playerEnt && <div className="text-cyan-500/50 text-[9px] tracking-[0.2em] font-bold">POS: {playerEnt.x.toFixed(0)}, {(playerEnt.z || 0).toFixed(0)}</div>}
        </div>
        <div className="relative cursor-pointer group rounded-full border border-cyan-500/20 p-2 transition-all hover:border-cyan-500/50 hover:shadow-[0_0_40px_rgba(0,255,200,0.2)]" onClick={openMap}>
          <canvas ref={radarRef} width={160} height={160} className="rounded-full bg-black/70 backdrop-blur-sm" />
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300"><div className="bg-black/90 text-[10px] font-mono text-cyan-400 tracking-[0.4em] uppercase px-5 py-2.5 rounded-full border border-cyan-500/40 backdrop-blur-md shadow-2xl">Focus</div></div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 mt-1 max-w-[350px]">
          {[
            { key: 'sun', color: 'bg-yellow-400', label: 'Sun' },
            { key: 'planet', color: 'bg-blue-400', label: 'Planets' },
            { key: 'moon', color: 'bg-neutral-400', label: 'Moons' },
            { key: 'enemy', color: 'bg-red-500', label: 'Hostiles' },
            { key: 'station', color: 'bg-emerald-500', label: 'Stations' },
            { key: 'anomaly', color: 'bg-fuchsia-500', label: 'Anomalies' },
            { key: 'asteroid', color: 'bg-neutral-600', label: 'Asteroids' },
            { key: 'neutral', color: 'bg-cyan-600', label: 'Travelers' }
          ].map(item => (
            <div key={item.key} className="flex items-center gap-2">
              <button
                onClick={() => setVisibilityFilters(prev => ({ ...prev, [item.key]: !prev[item.key] }))}
                className={`flex items-center gap-2 text-[9px] font-mono uppercase tracking-widest transition-opacity hover:opacity-100 ${visibilityFilters[item.key] ? 'text-neutral-400' : 'text-neutral-800 opacity-40'}`}
              >
                <div className={`w-2 h-2 rounded-full ${item.color} shadow-[0_0_8px_currentColor]`} />
                {item.label}
              </button>
              {visibilityFilters[item.key] && setSpectatorTargetId && (
                <button
                  onClick={() => {
                    const ents = Object.values(entities);
                    let target = ents.find((e: any) => e.name === 'Gateway Core' && e.ent_type === item.key);
                    if (!target) {
                      const player = ents.find((e: any) => e.ent_type === 'player') as any;
                      const candidates = ents.filter((e: any) => e.ent_type === item.key);
                      if (player && candidates.length > 0) {
                        candidates.sort((a, b) => {
                          const da = Math.pow(a.x - player.x, 2) + Math.pow((a.z || 0) - player.z, 2);
                          const db = Math.pow(b.x - player.x, 2) + Math.pow((b.z || 0) - player.z, 2);
                          return da - db;
                        });
                        target = candidates[0];
                      } else if (candidates.length > 0) {
                        target = candidates[0];
                      }
                    }
                    if (target) setSpectatorTargetId(target.id);
                  }}
                  className="w-4 h-4 rounded-full border border-white/10 flex items-center justify-center text-[7px] text-neutral-500 hover:text-cyan-400 hover:border-cyan-500/50 transition-all bg-white/5"
                  title={`Focus on ${item.label}`}
                >
                  <Target className="w-2 h-2" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div >

      {/* ── Expanded Map Overlay ────────── */}
      {
        isExpanded && (
          <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/95 backdrop-blur-3xl animate-in fade-in duration-500" onClick={(e) => e.target === e.currentTarget && closeMap()}>
            <div className="relative flex flex-col items-center gap-8 animate-in zoom-in-95 duration-500">
              <div className="flex items-center justify-between w-full px-6">
                <div className="flex flex-col gap-1.5"><div className="text-2xl font-mono uppercase tracking-[0.5em] text-cyan-500 font-black">Tactical Sector Map</div>{playerEnt && <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-widest font-bold">Unit Registry &nbsp;<span className="text-cyan-400 ml-4">X {playerEnt.x.toFixed(0)} &nbsp; Z {(playerEnt.z || 0).toFixed(0)}</span></div>}</div>
                <button onClick={closeMap} className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-white hover:bg-neutral-800 hover:border-red-500/50 transition-all text-3xl font-light">×</button>
              </div>
              <div className="relative rounded-full border border-white/5 p-6 shadow-[0_0_150px_rgba(34,211,238,0.15)]"><canvas ref={mapCanvasRef} width={MAP_CANVAS} height={MAP_CANVAS} className="cursor-crosshair rounded-full" onMouseMove={handleMapMouseMove} onMouseLeave={handleMapMouseLeave} onClick={handleMapClick} /></div>
              <div className="flex flex-wrap items-center justify-center gap-8 p-6 bg-white/5 rounded-3xl backdrop-blur-2xl border border-white/5 shadow-2xl">
                {[
                  { key: 'sun', color: '#fde68a', label: 'SUN' },
                  { key: 'planet', color: '#60a5fa', label: 'PLANETS' },
                  { key: 'moon', color: '#a8a8a8', label: 'MOONS' },
                  { key: 'federation', color: '#0ea5e9', label: 'FEDERATION' },
                  { key: 'enemy', color: '#ef4444', label: 'HOSTILES' },
                  { key: 'station', color: '#10b981', label: 'STATIONS' },
                  { key: 'anomaly', color: '#d946ef', label: 'ANOMALIES' },
                  { key: 'asteroid', color: '#444444', label: 'ASTEROIDS' },
                  { key: 'neutral', color: '#0891b2', label: 'TRAVELERS' },
                  { key: 'you', color: '#ffffff', label: 'YOU' }
                ].map(({ key, color, label }) => (
                  <button key={key} onClick={() => setVisibilityFilters(prev => ({ ...prev, [key]: !prev[key] }))} className={`flex items-center gap-2.5 text-[10px] font-mono tracking-widest transition-opacity ${visibilityFilters[key] ? 'text-neutral-200' : 'text-neutral-600 opacity-40'}`}>
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 15px ${color}` }} />{label}
                  </button>
                ))}
              </div>
            </div>
            {hoveredEntity && tooltipPos && (
              <div className="fixed z-[510] pointer-events-none" style={{ left: tooltipPos.x + 30, top: tooltipPos.y - 50 }}>
                <div className="bg-black/95 border border-cyan-500/40 rounded-2xl px-6 py-4 text-[12px] font-mono shadow-[0_0_50px_rgba(0,0,0,0.8)] backdrop-blur-3xl min-w-[240px] animate-in slide-in-from-left-2 duration-200">
                  <div className="text-cyan-400 font-black uppercase tracking-[0.3em] mb-3 border-b border-white/10 pb-3">{hoveredEntity.name || hoveredEntity.ent_type}</div>
                  <div className="space-y-2 text-neutral-400 uppercase tracking-widest text-[10px]">
                    <div className="flex justify-between"><span>Registry</span> <span className="text-neutral-100">{hoveredEntity.ent_type}</span></div>
                    {hoveredEntity.faction && <div className="flex justify-between"><span>Affiliation</span> <span className="text-neutral-100">{hoveredEntity.faction}</span></div>}
                    <div className="flex justify-between"><span>Matrix</span> <span className="text-neutral-100">{hoveredEntity.x.toFixed(0)}, {(hoveredEntity.z || 0).toFixed(0)}</span></div>
                    {playerEnt && (
                      <div className="flex justify-between pt-3 border-t border-white/5 text-cyan-400 font-black"><span>Proximity</span><span>{(Math.sqrt((hoveredEntity.x - playerEnt.x) ** 2 + ((hoveredEntity.z || 0) - (playerEnt.z || 0)) ** 2)).toFixed(0)} U</span></div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      }
    </>
  );
}
