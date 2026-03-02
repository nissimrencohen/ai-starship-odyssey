import React, { useRef, useEffect, useState, useCallback } from 'react';

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
}

const WORLD_RADIUS = 32000.0;   // Matches MAX_WORLD_RADIUS in Rust

// Mini-radar constants
const RADAR_R = 70;
const CX = 80;
const CY = 80;

// Tactical map constants
const MAP_CANVAS = 680;
const MAP_CX = MAP_CANVAS / 2;
const MAP_CY = MAP_CANVAS / 2;
const MAP_R = MAP_CANVAS / 2 - 24; // radius with padding

function drawRadarFrame(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  entities: Record<string, any>,
  scale: number, // r / WORLD_RADIUS
  visibleTypes: Record<string, boolean>
) {
  const toRX = (wx: number) => cx + wx * scale;
  const toRY = (wz: number) => cy + wz * scale;

  // Clip to circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  // Background
  ctx.fillStyle = 'rgba(0, 8, 18, 0.92)';
  ctx.fillRect(cx - r - 2, cy - r - 2, (r + 2) * 2, (r + 2) * 2);

  // Concentric range rings
  [0.25, 0.5, 0.75, 1.0].forEach(frac => {
    ctx.beginPath();
    ctx.arc(cx, cy, r * frac, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 255, 200, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  // Cross-hair lines
  ctx.strokeStyle = 'rgba(0, 255, 200, 0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();

  ctx.restore();

  const entArray = Object.values(entities) as any[];

  // 1. Asteroids — faint background noise
  // 1. Asteroids — faint background noise
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

  // 2. Planets & Moons
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

  // 3. Enemies & Hostiles
  entArray
    .filter(e => (e.ent_type === 'enemy' || e.ent_type === 'alien_ship' || e.ent_type === 'companion') && !e.is_dying && !e.is_cloaked)
    .forEach(e => {
      const isAlly = e.ent_type === 'companion' || e.faction === 'federation';
      if (isAlly && !visibleTypes['federation']) return;
      if (!isAlly && !visibleTypes['enemy']) return;

      const rx = toRX(e.x);
      const ry = toRY(e.z || 0);
      const dotR = scale > 0.005 ? 3.5 : 2.2;
      ctx.beginPath();
      ctx.arc(rx, ry, dotR, 0, Math.PI * 2);

      // All pirates/aliens are now Red
      if (isAlly) {
        ctx.fillStyle = 'rgba(14, 165, 233, 0.9)'; // Blue for allies
      } else {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.85)'; // Red for all hostiles
      }

      ctx.fill();
      ctx.shadowBlur = 4;
      ctx.shadowColor = ctx.fillStyle as string;
      ctx.stroke();
      ctx.shadowBlur = 0;
    });

  // 4. Space Stations
  if (visibleTypes['station']) {
    entArray
      .filter(e => e.ent_type === 'space_station' && !e.is_cloaked)
      .forEach(e => {
        const rx = toRX(e.x);
        const ry = toRY(e.z || 0);
        const sz = scale > 0.005 ? 5 : 3;
        ctx.fillStyle = '#10b981';
        ctx.fillRect(rx - sz / 2, ry - sz / 2, sz, sz);
        ctx.strokeStyle = '#34d399';
        ctx.lineWidth = 1;
        ctx.strokeRect(rx - sz / 2, ry - sz / 2, sz, sz);
      });
  }

  // 5. Sun
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

  // 6. Player — triangle pointing in direction of travel
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
      // Fallback dot at center when player position unknown
      ctx.beginPath();
      ctx.arc(cx, cy, scale > 0.005 ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = 'cyan';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  // Outer border ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0, 255, 200, 0.25)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

export function HUD({ playerHealth, score, currentLevel, entities, showDamageFlash, showSuccessFlash, isGameOver, objective, isChatVisible }: HUDProps) {
  const radarRef = useRef<HTMLCanvasElement>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);

  const [isExpanded, setIsExpanded] = useState(false);
  const [visibilityFilters, setVisibilityFilters] = useState<Record<string, boolean>>({
    sun: true,
    planet: true,
    moon: false,
    federation: true,
    enemy: true,
    station: true,
    asteroid: false,
    you: true
  });
  const [hoveredEntity, setHoveredEntity] = useState<any | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const healthPct = Math.max(0, playerHealth) / 100;
  const healthColor =
    healthPct > 0.6 ? '#22c55e' :
      healthPct > 0.3 ? '#eab308' :
        '#ef4444';

  // ── Mini-radar repaint ─────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = radarRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawRadarFrame(ctx, CX, CY, RADAR_R, entities, RADAR_R / WORLD_RADIUS, visibilityFilters);
  }, [entities, visibilityFilters]);

  // ── Tactical map repaint ───────────────────────────────────────────────────
  useEffect(() => {
    if (!isExpanded) return;
    const canvas = mapCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawRadarFrame(ctx, MAP_CX, MAP_CY, MAP_R, entities, MAP_R / WORLD_RADIUS, visibilityFilters);
  }, [entities, isExpanded, visibilityFilters]);

  // ── Hover detection on expanded map ───────────────────────────────────────
  const handleMapMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = mapCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Convert canvas pixels → world coords
    const scale = MAP_R / WORLD_RADIUS;
    const wx = (mx - MAP_CX) / scale;
    const wz = (my - MAP_CY) / scale;

    // Find nearest entity within a 2000-unit world-space threshold
    const entArray = Object.values(entities) as any[];
    let nearest: any = null;
    let minDist = 2000 / scale; // pixel threshold
    for (const ent of entArray) {
      const px = MAP_CX + ent.x * scale;
      const py = MAP_CY + (ent.z || 0) * scale;
      const d = Math.sqrt((mx - px) ** 2 + (my - py) ** 2);
      if (d < minDist) {
        minDist = d;
        nearest = ent;
      }
    }

    setHoveredEntity(nearest ?? null);
    setTooltipPos(nearest ? { x: e.clientX, y: e.clientY } : null);
  }, [entities]);

  const handleMapMouseLeave = useCallback(() => {
    setHoveredEntity(null);
    setTooltipPos(null);
  }, []);

  // Player position for coordinate readout
  const playerEnt = Object.values(entities).find((e: any) => e.ent_type === 'player') as any;

  return (
    <>
      {/* ── Damage Flash Vignette ─────────────────────────────────────── */}
      {showDamageFlash && (
        <div
          className="fixed inset-0 pointer-events-none z-[180]"
          style={{
            background:
              'radial-gradient(ellipse at center, transparent 45%, rgba(220, 30, 30, 0.65) 100%)',
            animation: 'damage-flash 0.55s ease-out forwards',
          }}
        />
      )}

      {/* ── Success Flash Overlay ────────────────────────────────────────── */}
      {showSuccessFlash && (
        <div
          className="fixed inset-0 pointer-events-none z-[180]"
          style={{
            background:
              'radial-gradient(ellipse at center, transparent 30%, rgba(255, 230, 100, 0.45) 100%)',
            animation: 'damage-flash 0.4s ease-out forwards',
          }}
        />
      )}

      {/* ── Game Over Overlay ────────────────────────────────────────── */}
      {isGameOver && (
        <div className="fixed inset-0 pointer-events-none z-[190] flex items-center justify-center">
          <div className="text-center select-none">
            <div
              className="text-7xl font-black tracking-[0.25em] uppercase"
              style={{
                color: '#ef4444',
                textShadow: '0 0 40px rgba(239,68,68,0.8), 0 0 80px rgba(239,68,68,0.4)',
                animation: 'signal-lost-pulse 0.8s ease-in-out infinite alternate',
              }}
            >
              SIGNAL LOST
            </div>
            <div className="mt-3 text-neutral-400 text-xs font-mono tracking-[0.4em] uppercase">
              Rebooting Neural Link...
            </div>
          </div>
        </div>
      )}

      {/* ── Commander Override Banner ────────────────────────────────────── */}
      {objective?.includes("COMMANDER OVERRIDE") && (
        <div className="fixed top-32 left-1/2 -translate-x-1/2 z-[200] pointer-events-none">
          <div
            className="px-8 py-3 bg-[#f59e0b]/20 border border-[#f59e0b]/60 rounded text-[#f59e0b] font-mono tracking-[0.4em] font-black text-lg uppercase shadow-[0_0_40px_rgba(245,158,11,0.6)]"
            style={{ animation: 'attack-pulse 0.8s infinite alternate' }}
          >
            COMMANDER OVERRIDE ACTIVE
          </div>
        </div>
      )}

      {/* ── Health Bar — top-left (past the Director sidebar) ────────── */}
      <div
        className="fixed top-6 z-[150] pointer-events-none"
        style={{
          left: isChatVisible ? '470px' : '80px',
          transition: 'left 0.3s ease-in-out'
        }}
      >
        <div className="text-[8px] uppercase tracking-[0.22em] text-neutral-500 mb-1 font-mono">
          HULL INTEGRITY
        </div>
        <div className="flex items-center gap-2.5">
          <div className="relative w-44 h-2.5 bg-neutral-900/80 rounded-full overflow-hidden border border-white/10">
            <div
              className="h-full rounded-full"
              style={{
                width: `${healthPct * 100}%`,
                backgroundColor: healthColor,
                boxShadow: `0 0 8px ${healthColor}99`,
                transition: 'width 0.3s ease, background-color 0.4s ease',
              }}
            />
            {[25, 50, 75].map(p => (
              <div
                key={p}
                className="absolute top-0 h-full w-px bg-black/40"
                style={{ left: `${p}%` }}
              />
            ))}
          </div>
          <span
            className="text-[10px] font-mono font-bold tabular-nums w-8"
            style={{ color: healthColor }}
          >
            {Math.ceil(playerHealth)}
          </span>
        </div>

        {healthPct <= 0.3 && !isGameOver && (
          <div
            className="mt-1 text-[8px] font-mono tracking-widest uppercase"
            style={{
              color: '#ef4444',
              animation: 'low-health-blink 0.6s step-end infinite',
            }}
          >
            ⚠ CRITICAL
          </div>
        )}

      </div>

      {/* ── Level & Kill Score — top-right ────────────────────────────────────── */}
      <div
        className="fixed z-[150] pointer-events-auto text-right flex flex-col items-end"
        style={{ top: '68px', right: '24px' }}
      >
        <div className="flex gap-6">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/50 mb-0.5 font-bold">
              MISSION OBJECTIVE
            </div>
            <div
              className="text-lg font-black font-mono tracking-wider"
              style={
                objective?.includes("COMMANDER OVERRIDE")
                  ? { color: '#f59e0b', textShadow: '0 0 20px rgba(245,158,11,0.8)' }
                  : { color: '#fbbf24', textShadow: '0 0 10px rgba(251,191,36,0.3)' }
              }
            >
              {objective || "Infiltrating System..."}
            </div>
          </div>
          <div className="text-right border-l border-white/10 pl-6 ml-2">
            <div className="text-[8px] uppercase tracking-[0.22em] text-neutral-500 mb-0.5 font-mono">
              LEVEL
            </div>
            <div
              className="text-3xl font-black font-mono tabular-nums"
              style={{
                color: '#38bdf8',
                textShadow: '0 0 12px rgba(56,189,248,0.5)',
              }}
            >
              {currentLevel}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[8px] uppercase tracking-[0.22em] text-neutral-500 mb-0.5 font-mono">
              KILLS
            </div>
            <div
              className="text-3xl font-black font-mono tabular-nums"
              style={{
                color: '#a855f7',
                textShadow: '0 0 12px rgba(168,85,247,0.5)',
              }}
            >
              {score}
            </div>
          </div>
        </div>

        {/* Game Controls */}
        <div className="mt-4 flex gap-2">
          <button
            onClick={async () => {
              try {
                const r = await fetch("http://127.0.0.1:8080/save", { method: "POST" });
                const j = await r.json();
                console.log("[HUD] Save:", j.status);
              } catch (e) { console.error("Save failed", e); }
            }}
            className="px-3 py-1 bg-cyan-500/10 border border-cyan-500/40 text-[10px] font-mono text-cyan-400 hover:bg-cyan-500/20 transition-colors uppercase tracking-widest cursor-pointer"
            title="Save current game state to disk"
          >
            💾 Save
          </button>
          <button
            onClick={async () => {
              try {
                const r = await fetch("http://127.0.0.1:8080/load", { method: "POST" });
                const j = await r.json();
                console.log("[HUD] Load:", j);
              } catch (e) { console.error("Load failed", e); }
            }}
            className="px-3 py-1 bg-green-500/10 border border-green-500/40 text-[10px] font-mono text-green-400 hover:bg-green-500/20 transition-colors uppercase tracking-widest cursor-pointer"
            title="Load last saved game state"
          >
            📂 Load
          </button>
          <button
            onClick={async () => {
              try {
                await fetch("http://127.0.0.1:8080/api/engine/reset", { method: "POST" });
              } catch (e) { console.error("Reset failed", e); }
            }}
            className="px-3 py-1 bg-red-500/10 border border-red-500/40 text-[10px] font-mono text-red-400 hover:bg-red-500/20 transition-colors uppercase tracking-widest cursor-pointer"
            title="Full restart: reset to level 1, respawn enemies"
          >
            ↺ Restart
          </button>
          {!isGameOver && (
            <button
              onClick={async () => {
                try {
                  await fetch("http://127.0.0.1:8080/api/engine/next-level", { method: "POST" });
                } catch (e) { console.error("Level skip failed", e); }
              }}
              className="px-3 py-1 bg-amber-500/10 border border-amber-500/40 text-[10px] font-mono text-amber-500 hover:bg-amber-500/20 transition-colors uppercase tracking-widest cursor-pointer"
            >
              ⏭ Skip
            </button>
          )}
        </div>
      </div>

      {/* ── Mini Tactical Radar — bottom-right (clickable to expand) ─────── */}
      <div
        className="fixed z-[150] flex flex-col items-center"
        style={{ bottom: '36px', right: '32px' }}
      >
        <div className="text-[8px] uppercase tracking-[0.22em] text-neutral-500 mb-1 font-mono text-center select-none">
          TACTICAL RADAR
          {playerEnt && (
            <div className="text-cyan-500/80 mt-0.5">
              [{playerEnt.x.toFixed(0)}, {(playerEnt.z || 0).toFixed(0)}]
            </div>
          )}
        </div>
        <div
          className="relative cursor-pointer group"
          onClick={() => setIsExpanded(true)}
          title="Open Tactical Map"
        >
          <canvas
            ref={radarRef}
            width={160}
            height={160}
            style={{ display: 'block' }}
          />
          {/* Expand hint overlay */}
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none">
            <div className="bg-black/60 text-[9px] font-mono text-cyan-400 tracking-widest uppercase px-2 py-1 rounded border border-cyan-500/30">
              EXPAND
            </div>
          </div>
        </div>
        {/* Legend */}
        <div className="flex items-center justify-center gap-3 mt-1.5 flex-wrap max-w-[180px]">
          {[
            { key: 'sun', color: 'bg-yellow-400', label: 'SUN' },
            { key: 'planet', color: 'bg-blue-400', label: 'PLANET' },
            { key: 'federation', color: 'bg-[#0ea5e9]', label: 'FED' },
            { key: 'enemy', color: 'bg-red-500', label: 'ENEMY' },
            { key: 'station', color: 'bg-[#10b981]', label: 'STATION' },
          ].map(item => (
            <button
              key={item.key}
              onClick={() => setVisibilityFilters(prev => ({ ...prev, [item.key]: !prev[item.key] }))}
              className={`flex items-center gap-1 text-[8px] font-mono transition-opacity hover:opacity-100 ${visibilityFilters[item.key] ? 'text-neutral-400' : 'text-neutral-700 opacity-40'}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${item.color}`} />
              {item.label}
            </button>
          ))}
          <button
            onClick={() => setVisibilityFilters(prev => ({ ...prev, you: !prev.you }))}
            className={`flex items-center gap-1 text-[8px] font-mono transition-opacity hover:opacity-100 ${visibilityFilters.you ? 'text-neutral-400' : 'text-neutral-700 opacity-40'}`}
          >
            <span className="w-1.5 h-1.5 bg-white inline-block" style={{ clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' }} />
            YOU
          </button>
        </div>
      </div>

      {/* ── Full-Screen Tactical Map Overlay ─────────────────────────────── */}
      {isExpanded && (
        <div
          className="fixed inset-0 z-[500] flex items-center justify-center"
          style={{ background: 'rgba(0, 4, 10, 0.92)', backdropFilter: 'blur(6px)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setIsExpanded(false); }}
        >
          <div className="relative flex flex-col items-center">
            {/* Header */}
            <div className="flex items-center justify-between w-full mb-3 px-1">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-[0.3em] text-cyan-500">
                  TACTICAL OVERVIEW — SECTOR MAP
                </div>
                {playerEnt && (
                  <div className="text-[9px] font-mono text-neutral-500 mt-0.5">
                    PLAYER COORDS &nbsp;
                    <span className="text-cyan-400">
                      X {playerEnt.x.toFixed(0)} &nbsp; Z {(playerEnt.z || 0).toFixed(0)}
                    </span>
                  </div>
                )}
              </div>
              <button
                onClick={() => setIsExpanded(false)}
                className="ml-8 w-8 h-8 rounded-lg bg-neutral-800/80 border border-white/10 flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors text-lg font-bold leading-none"
                title="Close Tactical Map"
              >
                ×
              </button>
            </div>

            {/* Map canvas */}
            <div
              className="relative"
              style={{
                borderRadius: '50%',
                boxShadow: '0 0 60px rgba(0,255,200,0.12), 0 0 120px rgba(0,0,0,0.8)',
                overflow: 'hidden',
              }}
            >
              <canvas
                ref={mapCanvasRef}
                width={MAP_CANVAS}
                height={MAP_CANVAS}
                style={{ display: 'block', cursor: 'crosshair' }}
                onMouseMove={handleMapMouseMove}
                onMouseLeave={handleMapMouseLeave}
              />
            </div>

            {/* Footer legend */}
            <div className="flex items-center justify-center gap-5 mt-3">
              {[
                { key: 'sun', color: '#fde68a', label: 'SUN' },
                { key: 'planet', color: '#60a5fa', label: 'PLANET' },
                { key: 'moon', color: '#a8a8a8', label: 'MOON' },
                { key: 'federation', color: '#0ea5e9', label: 'FEDERATION' },
                { key: 'enemy', color: '#ef4444', label: 'ENEMY' },
                { key: 'station', color: '#10b981', label: 'STATION' },
                { key: 'asteroid', color: '#444', label: 'ASTEROID' },
                { key: 'you', color: '#ffffff', label: 'YOU' },
              ].map(({ key, color, label }) => (
                <button
                  key={key}
                  onClick={() => setVisibilityFilters(prev => ({ ...prev, [key]: !prev[key] }))}
                  className={`flex items-center gap-1.5 text-[9px] font-mono transition-opacity hover:opacity-100 ${visibilityFilters[key] ? 'text-neutral-300' : 'text-neutral-600 opacity-40'}`}
                >
                  <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: color }} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Hover tooltip */}
          {hoveredEntity && tooltipPos && (
            <div
              className="fixed z-[510] pointer-events-none"
              style={{ left: tooltipPos.x + 14, top: tooltipPos.y - 10 }}
            >
              <div className="bg-black/90 border border-cyan-500/40 rounded-lg px-3 py-2 text-[10px] font-mono shadow-2xl min-w-[140px]">
                <div className="text-cyan-400 font-bold uppercase tracking-widest mb-1">
                  {hoveredEntity.name || hoveredEntity.ent_type}
                </div>
                <div className="text-neutral-400 space-y-0.5">
                  <div>TYPE &nbsp;<span className="text-neutral-200">{hoveredEntity.ent_type}</span></div>
                  {hoveredEntity.faction && (
                    <div>FACTION &nbsp;<span className="text-neutral-200">{hoveredEntity.faction}</span></div>
                  )}
                  <div>
                    X <span className="text-neutral-200">{hoveredEntity.x.toFixed(0)}</span>
                    &nbsp; Z <span className="text-neutral-200">{(hoveredEntity.z || 0).toFixed(0)}</span>
                  </div>
                  {playerEnt && (
                    <div>
                      DIST &nbsp;
                      <span className="text-yellow-400">
                        {Math.sqrt(
                          (hoveredEntity.x - playerEnt.x) ** 2 +
                          ((hoveredEntity.z || 0) - (playerEnt.z || 0)) ** 2
                        ).toFixed(0)} u
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
