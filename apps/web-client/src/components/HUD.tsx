import React, { useRef, useEffect } from 'react';

interface HUDProps {
  playerHealth: number;      // 0 – 100
  score: number;
  currentLevel: number;
  entities: Record<string, any>;
  showDamageFlash: boolean;
  showSuccessFlash: boolean;
  isGameOver: boolean;
  objective: string;
}

const WORLD_RADIUS = 150000;   // Matches new scattered asteroid range
const RADAR_R = 70;      // radar circle radius in px
const CX = 80;      // canvas centre X
const CY = 80;      // canvas centre Y

export function HUD({ playerHealth, score, currentLevel, entities, showDamageFlash, showSuccessFlash, isGameOver, objective }: HUDProps) {
  const radarRef = useRef<HTMLCanvasElement>(null);

  // Colour of health bar tracks hull integrity
  const healthPct = Math.max(0, playerHealth) / 100;
  const healthColor =
    healthPct > 0.6 ? '#22c55e' :
      healthPct > 0.3 ? '#eab308' :
        '#ef4444';

  // ── Radar repaint on every entity update ──────────────────────────────────
  useEffect(() => {
    const canvas = radarRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(CX, CY, RADAR_R, 0, Math.PI * 2);
    ctx.clip();

    // Background
    ctx.fillStyle = 'rgba(0, 8, 18, 0.88)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Concentric range rings
    [0.25, 0.5, 0.75, 1.0].forEach(r => {
      ctx.beginPath();
      ctx.arc(CX, CY, RADAR_R * r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 255, 200, 0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // Cross-hair lines
    ctx.strokeStyle = 'rgba(0, 255, 200, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(CX - RADAR_R, CY); ctx.lineTo(CX + RADAR_R, CY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(CX, CY - RADAR_R); ctx.lineTo(CX, CY + RADAR_R); ctx.stroke();

    ctx.restore(); // end clip

    // ── Helper: world coords → radar canvas coords ──────────────────────────
    const toRX = (wx: number) => CX + (wx / WORLD_RADIUS) * RADAR_R;
    const toRY = (wy: number) => CY + (wy / WORLD_RADIUS) * RADAR_R;

    const entArray = Object.values(entities) as any[];

    // Planets — blue dots
    entArray
      .filter(e => e.ent_type === 'planet')
      .forEach(e => {
        const rx = toRX(e.x);
        const ry = toRY(e.y);
        const grad = ctx.createRadialGradient(rx, ry, 0, rx, ry, 4);
        grad.addColorStop(0, '#60a5fa');
        grad.addColorStop(1, 'rgba(59,130,246,0)');
        ctx.beginPath();
        ctx.arc(rx, ry, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      });

    // Asteroids + enemies — faction-colored blips
    entArray
      .filter(e => (e.ent_type === 'asteroid' || e.ent_type === 'enemy' || e.ent_type === 'companion') && !e.is_dying)
      .forEach(e => {
        const rx = toRX(e.x);
        const ry = toRY(e.y);
        ctx.beginPath();
        ctx.arc(rx, ry, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = e.faction === 'federation'
          ? 'rgba(14, 165, 233, 0.9)'   // bright blue
          : 'rgba(239, 68, 68, 0.85)';  // red hostile
        ctx.fill();
      });

    // Sun — glowing yellow dot at centre
    const sunGrad = ctx.createRadialGradient(CX, CY, 0, CX, CY, 7);
    sunGrad.addColorStop(0, '#fde68a');
    sunGrad.addColorStop(0.6, '#f59e0b');
    sunGrad.addColorStop(1, 'rgba(251,191,36,0)');
    ctx.beginPath();
    ctx.arc(CX, CY, 6, 0, Math.PI * 2);
    ctx.fillStyle = sunGrad;
    ctx.fill();

    // Player — white triangle pointing in direction of travel
    const playerEnt = entArray.find(e => e.ent_type === 'player');
    if (playerEnt) {
      const rx = Math.max(CX - RADAR_R + 8, Math.min(CX + RADAR_R - 8, toRX(playerEnt.x)));
      const ry = Math.max(CY - RADAR_R + 8, Math.min(CY + RADAR_R - 8, toRY(playerEnt.y)));
      const rot: number = playerEnt.rotation ?? 0;

      ctx.save();
      ctx.translate(rx, ry);
      // rotation=0 → moving right; triangle tip starts pointing up → add π/2
      ctx.rotate(rot + Math.PI / 2);

      ctx.shadowColor = 'rgba(255, 255, 255, 0.6)';
      ctx.shadowBlur = 6;

      ctx.beginPath();
      ctx.moveTo(0, -8);    // tip (forward)
      ctx.lineTo(-5, 5);    // back-left
      ctx.lineTo(5, 5);     // back-right
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 255, 200, 0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.restore();
    }

    // Radar border
    ctx.beginPath();
    ctx.arc(CX, CY, RADAR_R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 255, 200, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [entities]);

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

      {/* ── Health Bar — top-left (past the Director sidebar) ────────── */}
      <div
        className="fixed top-6 z-[150] pointer-events-none"
        style={{ left: '340px' }}
      >
        <div className="text-[8px] uppercase tracking-[0.22em] text-neutral-500 mb-1 font-mono">
          HULL INTEGRITY
        </div>
        <div className="flex items-center gap-2.5">
          {/* Segmented bar */}
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
            {/* Tick marks */}
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

        {/* Low-health warning pulse */}
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
        className="fixed z-[150] pointer-events-none text-right flex flex-col items-end"
        style={{ top: '68px', right: '24px' }}
      >
        <div className="flex gap-6">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/50 mb-0.5 font-bold">
              MISSION OBJECTIVE
            </div>
            <div
              className="text-lg font-black font-mono tracking-wider"
              style={{
                color: '#fbbf24',
                textShadow: '0 0 10px rgba(251,191,36,0.3)',
              }}
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
      </div>

      {/* ── Tactical Radar — bottom-right ────────────────────────────── */}
      <div
        className="fixed z-[150] pointer-events-none"
        style={{ bottom: '36px', right: '32px' }}
      >
        <div className="text-[8px] uppercase tracking-[0.22em] text-neutral-500 mb-1 font-mono text-center">
          TACTICAL RADAR
        </div>
        <canvas
          ref={radarRef}
          width={160}
          height={160}
          style={{ display: 'block' }}
        />
        {/* Legend */}
        <div className="flex items-center justify-center gap-3 mt-1.5">
          <span className="flex items-center gap-1 text-[8px] font-mono text-neutral-600">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 inline-block" />
            SUN
          </span>
          <span className="flex items-center gap-1 text-[8px] font-mono text-neutral-600">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block" />
            PLANET
          </span>
          <span className="flex items-center gap-1 text-[8px] font-mono text-neutral-600">
            <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: '#0ea5e9' }} />
            FED
          </span>
          <span className="flex items-center gap-1 text-[8px] font-mono text-neutral-600">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
            HOSTILE
          </span>
          <span className="flex items-center gap-1 text-[8px] font-mono text-neutral-600">
            <span className="w-1.5 h-1.5 bg-white inline-block" style={{ clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' }} />
            YOU
          </span>
        </div>
      </div>
    </>
  );
}
