import React, { useRef, Suspense } from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

useGLTF.preload('http://127.0.0.1:8000/assets/chibi.glb');

const ChibiAvatar = () => {
    const { scene } = useGLTF('http://127.0.0.1:8000/assets/chibi.glb');
    const clone = React.useMemo(() => scene.clone(true), [scene]);

    // Normalize scale and shift origin so feet are EXACTLY at Y=0
    const { normalizedScale, offsetY } = React.useMemo(() => {
        const box = new THREE.Box3().setFromObject(clone);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = 20 / maxDim; // Pilot is 20 units tall
        return { normalizedScale: scale, offsetY: -box.min.y };
    }, [clone]);

    // Avatar faces FORWARD
    return (
        <group scale={[normalizedScale, normalizedScale, normalizedScale]}>
            <primitive object={clone} position={[0, offsetY, 0]} />
        </group>
    );
};

// ═══════════════════════════════════════════════════════════════════════════
// Global geometry constants — thick hull with recessed cockpit
// ═══════════════════════════════════════════════════════════════════════════
const HULL_R = 95;         // hull outer radius (hug tightly to the dome to reduce pancake effect)
const HULL_Y = 0;          // hull center Y
const TUB_RIM_Y = 18;      // top of hull where tub opens
const TUB_R = 85;          // HUGE cockpit tub inner radius
const TUB_DEPTH = 34;      // tub floor at Y=-16 (stays safely inside the thick hull)
const DOME_R = 85;         // HUGE dome radius = tub radius for seamless join
const DOME_Y = TUB_RIM_Y;  // Hemisphere rests exactly on rim

// ═══════════════════════════════════════════════════════════════════════════
// Cockpit Dashboard — volumetric low-poly cockpit with physical bezels
// Scaled up and mounted on a physical metallic pedestal
// ═══════════════════════════════════════════════════════════════════════════
const CockpitDashboard = ({ color, isFiring }: { color?: string; isFiring?: boolean }) => {
    const cPrimary = color || '#22d3ee';
    const cSecondary = color || '#a855f7';
    const cTertiary = color || '#34d399';

    const flashRef1 = useRef<THREE.PointLight>(null);
    const flashRef2 = useRef<THREE.PointLight>(null);
    const flashRef3 = useRef<THREE.PointLight>(null);
    const flashRef4 = useRef<THREE.PointLight>(null);
    const strobeTimer = useRef(0);

    useFrame((state, delta) => {
        const base = 12;

        if (isFiring) strobeTimer.current = 0.15;
        if (strobeTimer.current > 0) strobeTimer.current -= delta;

        // Strobe effect: when firing, jitter intensity rapidly between 0.5x and 4x
        const isStrobing = strobeTimer.current > 0;
        const strobe = isStrobing ? (Math.sin(state.clock.elapsedTime * 60) > 0 ? 4.5 : 0.5) : 1;
        const target = base * strobe;

        if (flashRef1.current) flashRef1.current.intensity = THREE.MathUtils.lerp(flashRef1.current.intensity, target * 1.0, delta * 30);
        if (flashRef2.current) flashRef2.current.intensity = THREE.MathUtils.lerp(flashRef2.current.intensity, target * 0.7, delta * 30);
        if (flashRef3.current) flashRef3.current.intensity = THREE.MathUtils.lerp(flashRef3.current.intensity, target * 0.7, delta * 30);
        if (flashRef4.current) flashRef4.current.intensity = THREE.MathUtils.lerp(flashRef4.current.intensity, target * 0.5, delta * 30);
    });

    return (
        <group rotation={[0, Math.PI, 0]}>
            {/* ── HEAVY PEDESTAL STAND ── anchors dashboard to the floor */}
            <mesh position={[0, 2.5, -2]}>
                <cylinderGeometry args={[2.5, 3.5, 5, 12]} />
                <meshStandardMaterial color="#2d2d4e" metalness={0.8} roughness={0.2} />
            </mesh>
            {/* Pedestal base bolted to the floor */}
            <mesh position={[0, 0.5, -2]}>
                <cylinderGeometry args={[5.5, 6.5, 1, 16]} />
                <meshStandardMaterial color="#1f2937" metalness={0.9} roughness={0.1} />
            </mesh>

            {/* ── DYNAMIC AI FLOOR RING ── highly emissive rings illuminating the tub floor */}
            <mesh position={[0, 0.2, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <torusGeometry args={[12, 0.4, 16, 64]} />
                <meshStandardMaterial color={cPrimary} emissive={cPrimary} emissiveIntensity={4} />
            </mesh>
            <mesh position={[0, 0.1, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <torusGeometry args={[14, 0.15, 16, 64]} />
                <meshStandardMaterial color={cSecondary} emissive={cSecondary} emissiveIntensity={2} />
            </mesh>

            {/* Elevated console assembly */}
            <group position={[0, 4.5, 1.5]}>
                {/* ── CONSOLE BODY ── thick physical structure */}
                <mesh position={[0, 0, -5]} rotation={[0.35, 0, 0]}>
                    <boxGeometry args={[22, 4, 3]} />
                    <meshStandardMaterial color="#1a1a2e" metalness={0.85} roughness={0.15} />
                </mesh>
                {/* Left wing console — angled 45° */}
                <mesh position={[-11, 0, -3.5]} rotation={[0.35, -0.7, 0]}>
                    <boxGeometry args={[8, 4, 2]} />
                    <meshStandardMaterial color="#1a1a2e" metalness={0.85} roughness={0.15} />
                </mesh>
                {/* Right wing console — angled 45° */}
                <mesh position={[11, 0, -3.5]} rotation={[0.35, 0.7, 0]}>
                    <boxGeometry args={[8, 4, 2]} />
                    <meshStandardMaterial color="#1a1a2e" metalness={0.85} roughness={0.15} />
                </mesh>
                {/* Upper console shelf */}
                <mesh position={[0, 3.5, -6.5]} rotation={[0.7, 0, 0]}>
                    <boxGeometry args={[24, 2.5, 1.5]} />
                    <meshStandardMaterial color="#16213e" metalness={0.75} roughness={0.25} />
                </mesh>
                {/* Lower console lip */}
                <mesh position={[0, -2, -3.5]}>
                    <boxGeometry args={[23, 1.2, 4]} />
                    <meshStandardMaterial color="#0f0f23" metalness={0.9} roughness={0.1} />
                </mesh>

                {/* ── CENTRAL RADAR MONITOR ── massive with box bezel */}
                <group position={[0, 1.5, -4.8]} rotation={[0.35, 0, 0]}>
                    <mesh><boxGeometry args={[10, 5, 0.9]} /><meshStandardMaterial color="#2d2d4e" metalness={0.8} roughness={0.2} /></mesh>
                    <mesh position={[0, 0, -0.46]}><planeGeometry args={[9, 4]} /><meshBasicMaterial color="#0a1628" side={THREE.DoubleSide} /></mesh>
                    <mesh position={[0, 0, -0.47]}><ringGeometry args={[0.4, 1.8, 24]} /><meshBasicMaterial color={cPrimary} transparent opacity={0.6} side={THREE.DoubleSide} /></mesh>
                    <mesh position={[0, 0, -0.48]}><ringGeometry args={[0.2, 1.0, 24]} /><meshBasicMaterial color={cPrimary} transparent opacity={0.8} side={THREE.DoubleSide} /></mesh>
                    <mesh position={[0, 0, -0.49]}><planeGeometry args={[4.0, 0.05]} /><meshBasicMaterial color={cPrimary} transparent opacity={0.5} side={THREE.DoubleSide} /></mesh>
                    <mesh position={[0, 0, -0.49]} rotation={[0, 0, Math.PI / 2]}><planeGeometry args={[4.0, 0.05]} /><meshBasicMaterial color={cPrimary} transparent opacity={0.5} side={THREE.DoubleSide} /></mesh>
                    <mesh position={[1.0, 0.5, -0.50]}><circleGeometry args={[0.2, 8]} /><meshBasicMaterial color={cTertiary} side={THREE.DoubleSide} /></mesh>
                </group>

                {/* ── UPPER HUD GAUGES ── with bezels */}
                {/* SPEED (left) */}
                <group position={[-6.5, 4.5, -6.5]} rotation={[0.7, 0, 0]}>
                    <mesh><boxGeometry args={[5, 2.5, 0.6]} /><meshStandardMaterial color="#2d2d4e" metalness={0.8} roughness={0.2} /></mesh>
                    <mesh position={[0, 0, -0.31]}><planeGeometry args={[4.5, 2]} /><meshBasicMaterial color={cPrimary} transparent opacity={0.8} side={THREE.DoubleSide} /></mesh>
                </group>
                {/* HEAD (center) */}
                <group position={[0, 5, -7.5]} rotation={[0.7, 0, 0]}>
                    <mesh><boxGeometry args={[6, 2.2, 0.6]} /><meshStandardMaterial color="#2d2d4e" metalness={0.8} roughness={0.2} /></mesh>
                    <mesh position={[0, 0, -0.31]}><planeGeometry args={[5.5, 1.7]} /><meshBasicMaterial color={cSecondary} transparent opacity={0.8} side={THREE.DoubleSide} /></mesh>
                </group>
                {/* POWER (right) */}
                <group position={[6.5, 4.5, -6.5]} rotation={[0.7, 0, 0]}>
                    <mesh><boxGeometry args={[5, 2.5, 0.6]} /><meshStandardMaterial color="#2d2d4e" metalness={0.8} roughness={0.2} /></mesh>
                    <mesh position={[0, 0, -0.31]}><planeGeometry args={[4.5, 2]} /><meshBasicMaterial color={cTertiary} transparent opacity={0.8} side={THREE.DoubleSide} /></mesh>
                </group>

                {/* ── SIDE MONITORS ── aggressively angled 45° */}
                <group position={[-11, 1.5, -3.2]} rotation={[0.35, -0.7, 0]}>
                    <mesh><boxGeometry args={[7, 4, 0.6]} /><meshStandardMaterial color="#2d2d4e" metalness={0.8} roughness={0.2} /></mesh>
                    <mesh position={[0, 0, -0.31]}><planeGeometry args={[6.2, 3.2]} /><meshBasicMaterial color={cSecondary} transparent opacity={0.5} side={THREE.DoubleSide} /></mesh>
                </group>
                <group position={[11, 1.5, -3.2]} rotation={[0.35, 0.7, 0]}>
                    <mesh><boxGeometry args={[7, 4, 0.6]} /><meshStandardMaterial color="#2d2d4e" metalness={0.8} roughness={0.2} /></mesh>
                    <mesh position={[0, 0, -0.31]}><planeGeometry args={[6.2, 3.2]} /><meshBasicMaterial color={cTertiary} transparent opacity={0.5} side={THREE.DoubleSide} /></mesh>
                </group>

                {/* ── JOYSTICKS ── chunky */}
                {[-6, 6].map((x, i) => (
                    <group key={`joy${i}`} position={[x, -2, -1.8]}>
                        <mesh position={[0, -0.4, 0]}><cylinderGeometry args={[0.9, 1.2, 1.0, 12]} /><meshStandardMaterial color="#2d2d4e" metalness={0.9} roughness={0.1} /></mesh>
                        <mesh rotation={[0, 0, i === 0 ? 0.2 : -0.2]}><cylinderGeometry args={[0.35, 0.45, 3.5, 8]} /><meshStandardMaterial color="#475569" metalness={0.85} roughness={0.15} /></mesh>
                        <mesh position={[0, 2.0, 0]}><boxGeometry args={[0.8, 1.2, 0.8]} /><meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} /></mesh>
                        <mesh position={[0, 2.5, 0]}><sphereGeometry args={[0.4, 6, 6]} /><meshStandardMaterial color={color || "#ef4444"} emissive={color || "#ef4444"} emissiveIntensity={1} /></mesh>
                    </group>
                ))}

                {/* ── COCKPIT LIGHTING ── neon ambient tied to AI color */}
                <pointLight ref={flashRef1} position={[0, 4, -4]} color={cPrimary} intensity={12} distance={40} />
                <pointLight ref={flashRef2} position={[-8, 1, -2]} color={cSecondary} intensity={8} distance={30} />
                <pointLight ref={flashRef3} position={[8, 1, -2]} color={cTertiary} intensity={8} distance={30} />
                <pointLight ref={flashRef4} position={[0, -2, 3]} color={cPrimary} intensity={6} distance={20} />
            </group>

            {/* ── PILOT SEAT ── behind console on floor */}
            <group position={[0, 0, 2]}>
                <mesh position={[0, 1, 0]}><boxGeometry args={[4, 2, 4]} /><meshStandardMaterial color="#374151" metalness={0.5} roughness={0.5} /></mesh>
                <mesh position={[0, 5, 2]}><boxGeometry args={[3.5, 6, 1]} /><meshStandardMaterial color="#1f2937" metalness={0.4} roughness={0.6} /></mesh>
                <mesh position={[0, 8.5, 2]}><boxGeometry args={[2.5, 2, 1]} /><meshStandardMaterial color="#111827" metalness={0.3} roughness={0.7} /></mesh>
                <mesh position={[-2.2, 3, 0]}><boxGeometry args={[0.5, 0.5, 3.5]} /><meshStandardMaterial color="#4b5563" metalness={0.6} roughness={0.4} /></mesh>
                <mesh position={[2.2, 3, 0]}><boxGeometry args={[0.5, 0.5, 3.5]} /><meshStandardMaterial color="#4b5563" metalness={0.6} roughness={0.4} /></mesh>
            </group>
        </group>
    );
};

// Procedural Fallback Ship Component — scaled to world units (hundreds of units across)
const ShipFallback = ({ type = 'ufo', color, laserOriginRef }: { type?: string, color?: string, laserOriginRef?: React.MutableRefObject<any> }) => {
    // Map tactical chassis names to base visual models
    const mappedType = type === 'goliath' ? 'freighter' : (type === 'stinger' || type === 'interceptor' ? 'fighter' : type);

    // Default colors if not supplied
    const cPrimary = color || (mappedType === 'ufo' ? '#a855f7' : '#22d3ee');
    const cSecondary = color || '#0891b2';

    if (mappedType === 'fighter') {
        return (
            <group ref={laserOriginRef}>
                <mesh>
                    <coneGeometry args={[12, 60, 4]} />
                    <meshStandardMaterial color={cPrimary} emissive={cSecondary} emissiveIntensity={2} wireframe={false} />
                </mesh>
                <mesh position={[22, -16, 0]} rotation={[0, 0, Math.PI / 5]}>
                    <boxGeometry args={[28, 6, 8]} />
                    <meshStandardMaterial color={cSecondary} emissive={cSecondary} emissiveIntensity={0.5} wireframe={false} />
                </mesh>
                <mesh position={[-22, -16, 0]} rotation={[0, 0, -Math.PI / 5]}>
                    <boxGeometry args={[28, 6, 8]} />
                    <meshStandardMaterial color={cSecondary} emissive={cSecondary} emissiveIntensity={0.5} wireframe={false} />
                </mesh>
                <mesh position={[0, -34, 0]}>
                    <sphereGeometry args={[8, 16, 16]} />
                    <meshBasicMaterial color="#ef4444" wireframe={false} />
                </mesh>
            </group>
        );
    } else if (mappedType === 'freighter') {
        return (
            <group rotation={[Math.PI / 2, 0, 0]} ref={laserOriginRef}>
                <mesh position={[0, -10, 0]}>
                    <boxGeometry args={[20, 50, 20]} />
                    <meshStandardMaterial color={color || '#475569'} roughness={0.8} wireframe={false} />
                </mesh>
                <mesh position={[0, 15, 0]}>
                    <boxGeometry args={[10, 20, 10]} />
                    <meshStandardMaterial color="#1e293b" wireframe={false} />
                </mesh>
                <mesh position={[0, -35, 0]}>
                    <sphereGeometry args={[8, 16, 16]} />
                    <meshBasicMaterial color="#f59e0b" wireframe={false} />
                </mesh>
            </group>
        );
    } else if (mappedType === 'stealth') {
        return (
            <group rotation={[Math.PI / 2, 0, 0]} ref={laserOriginRef}>
                <mesh position={[0, 0, 0]}>
                    <coneGeometry args={[16, 50, 3]} />
                    <meshStandardMaterial color={color || '#0f172a'} roughness={0.9} emissive={color || '#3b82f6'} emissiveIntensity={0.2} wireframe={false} />
                </mesh>
                <mesh position={[0, -20, -5]} rotation={[Math.PI / 6, 0, 0]}>
                    <boxGeometry args={[40, 4, 15]} />
                    <meshStandardMaterial color={color || '#0f172a'} roughness={0.9} wireframe={false} />
                </mesh>
                <mesh position={[0, -25, 0]}>
                    <sphereGeometry args={[5, 16, 16]} />
                    <meshBasicMaterial color={color || '#3b82f6'} wireframe={false} />
                </mesh>
            </group>
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Default UFO — thick faceted hull + recessed cockpit tub + front cannon
    // ═══════════════════════════════════════════════════════════════════════
    const DEFAULT_UFO_COLORS = new Set(['cyan', '#22d3ee', '#a855f7', undefined, null, '']);
    const isPainted = !!color && !DEFAULT_UFO_COLORS.has(color.toLowerCase());

    return (
        <group>
            {/* ═══ THICK HULL ═══ constructed with hollow cylinders & rings to allow a hollow core */}

            {/* Top Deck Ring (connects top of tub to top of outer upper wall) */}
            <mesh position={[0, TUB_RIM_Y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[TUB_R + 2, HULL_R - 2, 12]} />
                <meshStandardMaterial color="#cfd8dc" metalness={0.92} roughness={0.08} side={THREE.DoubleSide} />
            </mesh>

            {/* Tub Outer Rim Ring */}
            <mesh position={[0, TUB_RIM_Y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[TUB_R, TUB_R + 2, 12]} />
                <meshStandardMaterial color="#455a64" metalness={0.85} roughness={0.15} side={THREE.DoubleSide} />
            </mesh>

            {/* Upper outer slanted wall */}
            <mesh position={[0, TUB_RIM_Y - 3, 0]}>
                {/* args=[radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded] */}
                <cylinderGeometry args={[HULL_R - 2, HULL_R, 6, 12, 1, true]} />
                <meshStandardMaterial color="#cfd8dc" metalness={0.92} roughness={0.08} side={THREE.DoubleSide} />
            </mesh>

            {/* Main body slab outer wall */}
            <mesh position={[0, TUB_RIM_Y - 3 - 5.5, 0]}>
                <cylinderGeometry args={[HULL_R, HULL_R, 5, 12, 1, true]} />
                <meshStandardMaterial color="#b0bec5" metalness={0.95} roughness={0.05} side={THREE.DoubleSide} />
            </mesh>

            {/* Lower outer slanted wall */}
            <mesh position={[0, TUB_RIM_Y - 3 - 5.5 - 5.5, 0]}>
                <cylinderGeometry args={[HULL_R, HULL_R - 5, 6, 12, 1, true]} />
                <meshStandardMaterial color="#90a4ae" metalness={0.9} roughness={0.1} side={THREE.DoubleSide} />
            </mesh>

            {/* Under-panel outer slanted wall */}
            <mesh position={[0, HULL_Y - 9, 0]}>
                <cylinderGeometry args={[HULL_R - 8, HULL_R - 15, 3, 12, 1, true]} />
                <meshStandardMaterial color="#37474f" metalness={0.85} roughness={0.15} side={THREE.DoubleSide} />
            </mesh>

            {/* Under-panel horizontal step ring */}
            <mesh position={[0, HULL_Y - 7.5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[HULL_R - 8, HULL_R - 5, 12]} />
                <meshStandardMaterial color="#90a4ae" metalness={0.9} roughness={0.1} side={THREE.DoubleSide} />
            </mesh>

            {/* Under-glow vent rings (AI color bound) */}
            <mesh position={[0, HULL_Y - 10.5, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <torusGeometry args={[HULL_R - 12, 1.5, 6, 12]} />
                <meshBasicMaterial color={color || "#ef4444"} />
            </mesh>
            <mesh position={[0, HULL_Y - 8, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <torusGeometry args={[HULL_R - 5, 0.8, 6, 12]} />
                <meshBasicMaterial color={color || "#ef4444"} />
            </mesh>

            {/* Bottom Engine Base (connects inner cavity floor to under-panel wall) */}
            <mesh position={[0, HULL_Y - 10.5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[0, HULL_R - 15, 12]} />
                <meshStandardMaterial color="#37474f" metalness={0.85} roughness={0.15} side={THREE.DoubleSide} />
            </mesh>

            {/* Bottom engine core */}
            <mesh position={[0, HULL_Y - 12, 0]}>
                <sphereGeometry args={[8, 12, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
                <meshBasicMaterial color={color || cPrimary} />
            </mesh>
            {/* Rim accent ring */}
            <mesh position={[0, TUB_RIM_Y - 6.5, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <torusGeometry args={[HULL_R + 1, 1, 6, 24]} />
                <meshStandardMaterial color="#78909c" metalness={0.9} roughness={0.1} />
            </mesh>

            {/* ═══ RECESSED COCKPIT TUB ═══ deep hollow bowl */}
            {/* Tub outer wall inner side (metallic saucer interior rim) */}
            <mesh position={[0, TUB_RIM_Y - 2.5, 0]}>
                <cylinderGeometry args={[TUB_R + 2, TUB_R + 2, 5, 24, 1, true]} />
                <meshStandardMaterial color="#455a64" metalness={0.85} roughness={0.15} side={THREE.DoubleSide} />
            </mesh>
            {/* Opaque tub floor and deep shaft REMOVED to create full glass sphere cockpit! */}

            {/* ═══ SIDE SUPPORT BRACKETS ═══ heavy mounts fixing the interior rig to the hull rings */}
            <mesh position={[-DOME_R + 10, TUB_RIM_Y - 2, 0]}>
                <boxGeometry args={[40, 6, 12]} />
                <meshStandardMaterial color="#37474f" metalness={0.9} roughness={0.2} />
            </mesh>
            <mesh position={[DOME_R - 10, TUB_RIM_Y - 2, 0]}>
                <boxGeometry args={[40, 6, 12]} />
                <meshStandardMaterial color="#37474f" metalness={0.9} roughness={0.2} />
            </mesh>

            {/* ═══ INTERIOR VOLUMETRIC GLOW ═══ AI color saturates the glass sphere */}
            <pointLight position={[0, DOME_Y, 0]} color={color || cPrimary} intensity={6} distance={DOME_R * 1.5} />

            {/* ═══ FRONT LASER CANNON ═══ massive weapon at absolute front edge (+Z locally) */}
            <group position={[0, HULL_Y - 3, HULL_R + 4]} rotation={[0, Math.PI, 0]}>
                {/* Heavy box housing */}
                <mesh>
                    <boxGeometry args={[10, 7, 12]} />
                    <meshStandardMaterial color="#546e7a" metalness={0.9} roughness={0.1} />
                </mesh>
                {/* Top armor plate */}
                <mesh position={[0, 4, 0]}>
                    <boxGeometry args={[8, 1.5, 10]} />
                    <meshStandardMaterial color="#78909c" metalness={0.85} roughness={0.15} />
                </mesh>
                {/* Barrel — protruding cylinder */}
                <mesh position={[0, -1, -10]} rotation={[Math.PI / 2, 0, 0]}>
                    <cylinderGeometry args={[2.5, 3, 14, 8]} />
                    <meshStandardMaterial color="#37474f" metalness={0.95} roughness={0.05} />
                </mesh>
                {/* Barrel tip ring — emissive glow (AI bound) */}
                <mesh ref={laserOriginRef} position={[0, -1, -17]} rotation={[Math.PI / 2, 0, 0]}>
                    <torusGeometry args={[3, 0.5, 6, 12]} />
                    <meshBasicMaterial color={cPrimary} />
                </mesh>
                {/* Barrel inner glow */}
                <mesh position={[0, -1, -17]}>
                    <sphereGeometry args={[1.5, 8, 8]} />
                    <meshBasicMaterial color={cPrimary} />
                </mesh>
                {/* Cannon tip light */}
                <pointLight position={[0, -1, -18]} color={cPrimary} intensity={15} distance={50} />
                {/* Side brackets */}
                <mesh position={[-6, -1, -3]}>
                    <boxGeometry args={[2, 3, 6]} />
                    <meshStandardMaterial color="#455a64" metalness={0.85} roughness={0.15} />
                </mesh>
                <mesh position={[6, -1, -3]}>
                    <boxGeometry args={[2, 3, 6]} />
                    <meshStandardMaterial color="#455a64" metalness={0.85} roughness={0.15} />
                </mesh>
            </group>

            {/* ═══ EXTERNAL HULL LIGHTING ═══ (AI color bound) */}
            {[0, Math.PI / 3, Math.PI * 2 / 3, Math.PI, Math.PI * 4 / 3, Math.PI * 5 / 3].map((angle, i) => (
                <pointLight
                    key={`hl${i}`}
                    position={[Math.cos(angle) * (HULL_R - 5), HULL_Y - 8, Math.sin(angle) * (HULL_R - 5)]}
                    color={color || (i % 2 === 0 ? '#ef4444' : '#22d3ee')}
                    intensity={4}
                    distance={35}
                />
            ))}

            {/* ═══ MASSIVE GLASS DOME ═══ true hemisphere resting perfectly on tub rim */}
            <mesh position={[0, DOME_Y, 0]} renderOrder={10}>
                {/* Hemisphere: thetaLength = PI/2 */}
                <sphereGeometry args={[DOME_R, 48, 32, 0, Math.PI * 2, 0, Math.PI / 2]} />
                <meshPhysicalMaterial
                    color={'#e0f2fe'}
                    emissive={'#bae6fd'}
                    emissiveIntensity={0.2}
                    transparent={true}
                    opacity={0.15}
                    depthWrite={false}
                    depthTest={true}
                    side={THREE.DoubleSide}
                    roughness={0.05}
                    clearcoat={1.0}
                    clearcoatRoughness={0.1}
                />
            </mesh>
            {/* ═══ BOTTOM GLASS DOME ═══ completing the 360 visual sphere */}
            <mesh position={[0, DOME_Y, 0]} renderOrder={10} rotation={[Math.PI, 0, 0]}>
                <sphereGeometry args={[DOME_R, 48, 32, 0, Math.PI * 2, 0, Math.PI / 2]} />
                <meshPhysicalMaterial
                    color={'#e0f2fe'}
                    emissive={'#bae6fd'}
                    emissiveIntensity={0.2}
                    transparent={true}
                    opacity={0.15}
                    depthWrite={false}
                    depthTest={true}
                    side={THREE.DoubleSide}
                    roughness={0.05}
                    clearcoat={1.0}
                    clearcoatRoughness={0.1}
                />
            </mesh>
        </group>
    );
};

// Error Boundary for GLTF Loading
class GLTFErrorBoundary extends React.Component<{ children: React.ReactNode, fallback: React.ReactNode }, { hasError: boolean }> {
    constructor(props: any) {
        super(props);
        this.state = { hasError: false };
    }
    static getDerivedStateFromError() {
        return { hasError: true };
    }
    render() {
        if (this.state.hasError) return this.props.fallback;
        return this.props.children;
    }
}

// Helper function to globally preload models so they are in cache before the Director requests them
export const preloadShipModel = (url: string) => {
    try {
        useGLTF.preload(url);
    } catch (e) {
        console.warn("Could not preload ship model:", url);
    }
};

// Per ship-type model orientation corrections.
// Applied to the inner model group (static, not in useFrame).
// Parent group handles world yaw/pitch — these are pure visual fixes.
// Per-model visual corrections applied INSIDE the outer heading quaternion.
// Outer quaternion: Ry(-yaw + PI/2) so inner +Z maps to world +X (game forward).
// shuttle.glb nose is at model -Z → Ry(PI) flips -Z to +Z → outer maps +Z to world +X ✓
const SHIP_TYPE_CORRECTIONS: Record<string, [number, number, number]> = {
    ufo: [0, 0, 0],
    shuttle: [Math.PI / 2, Math.PI, 0],
    freighter: [Math.PI / 2, Math.PI, 0],
    fighter: [Math.PI / 2, Math.PI, 0],
    stinger: [Math.PI / 2, Math.PI, 0],
    interceptor: [Math.PI / 2, Math.PI, 0],
    goliath: [Math.PI / 2, Math.PI, 0],
};

// NASA GLB models served by the Python Director from C:\Project\data\models\ships\
const SHIP_MODEL_URLS: Record<string, string> = {
    shuttle: 'http://127.0.0.1:8000/assets/models/ships/shuttle.glb',  // Space Shuttle (A) 1.2MB
    fighter: 'http://127.0.0.1:8000/assets/models/ships/fighter.glb',  // Space Shuttle (D) 2.4MB
    stinger: 'http://127.0.0.1:8000/assets/models/ships/fighter.glb',
    interceptor: 'http://127.0.0.1:8000/assets/models/ships/fighter.glb',
    freighter: 'http://127.0.0.1:8000/assets/models/ships/shuttle.glb',
    goliath: 'http://127.0.0.1:8000/assets/models/ships/shuttle.glb',
};

// Per-model orientation corrections.
// Goal: after this rotation the model's nose points along +Z so the parent
// quaternion (which maps inner +Z → world forward) works correctly.
// Both NASA shuttle GLBs have their nose along +Z already → no correction needed.
const SHIP_MODEL_ROTATIONS: Record<string, [number, number, number]> = {
    'http://127.0.0.1:8000/assets/models/ships/shuttle.glb': [0, 0, 0],
    'http://127.0.0.1:8000/assets/models/ships/fighter.glb': [0, 0, 0],
};

const ShipModel = ({ url }: { url: string }) => {
    const { scene } = useGLTF(url);
    const clone = React.useMemo(() => scene.clone(true), [scene]);
    // Auto-normalize to radius=30 (matches ShipFallback proportions)
    const scale = React.useMemo(() => {
        const box = new THREE.Box3().setFromObject(clone);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const r = sphere.radius || 1;
        return 30 / r;
    }, [clone]);
    const rot = SHIP_MODEL_ROTATIONS[url] ?? [0, -Math.PI / 2, 0];
    return (
        <group rotation={rot}>
            <primitive object={clone} scale={[scale, scale, scale]} />
        </group>
    );
};

interface PlayerShipProps {
    position: [number, number, number];
    rotationRef: React.MutableRefObject<number>;
    camPitchRef: React.MutableRefObject<number>;
    modelUrl?: string;
    shipType?: string;
    shipColor?: string;
    isCloaked?: boolean;
    laserOriginRef?: React.MutableRefObject<THREE.Group | null>;
    playerEnt?: any;
}

export const PlayerShip: React.FC<PlayerShipProps> = ({ position, rotationRef, camPitchRef, modelUrl, shipType, shipColor, isCloaked, laserOriginRef, playerEnt }) => {
    const groupRef = useRef<THREE.Group>(null);
    const interiorGroupRef = useRef<THREE.Group>(null);

    // Resolve model URL: explicit prop first, then type mapping, then no model
    const resolvedModelUrl = modelUrl || (shipType ? SHIP_MODEL_URLS[shipType] : undefined);

    React.useEffect(() => {
        if (resolvedModelUrl) preloadShipModel(resolvedModelUrl);
    }, [resolvedModelUrl]);

    const smoothedInteriorRot = useRef(0);
    const smoothedBank = useRef(0);
    const smoothedPitch = useRef(0);
    const prevYaw = useRef(rotationRef.current);
    const prevForwardSpeed = useRef(0);
    const prevPos = useRef(new THREE.Vector3());

    useFrame((_, delta) => {
        if (groupRef.current) {
            groupRef.current.position.lerp(new THREE.Vector3(...position), 0.4); // Increased from 0.15

            // Read latest values from refs every frame for real-time response
            const rotation = rotationRef.current;
            const camPitch = camPitchRef.current;

            // Yaw: engines face camera. Camera offset rotates by -yaw+π/2,
            // so flipping by another π makes nose point away: -rotation - π/2
            const yawQ = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0),
                -rotation + Math.PI / 2
            );
            // Pitch: tilt nose up/down based on camera pitch
            // Inverted camPitch to fix the "look up -> nose down" visual bug
            const pitchQ = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0),
                -camPitch
            );
            const targetQ = yawQ.multiply(pitchQ);
            groupRef.current.quaternion.slerp(targetQ, 0.4); // Increased from 0.15

            // ── G-FORCE GIMBAL & REVERSE LOGIC FOR INTERIOR ──
            if (interiorGroupRef.current) {
                // Manually compute smoothed velocity to ensure we capture actual movement, overriding faulty network vx/vz
                const currentGroupPos = groupRef.current.position;
                const vx = (currentGroupPos.x - prevPos.current.x) / Math.max(delta, 0.001);
                const vy = (currentGroupPos.y - prevPos.current.y) / Math.max(delta, 0.001);
                const vz = (currentGroupPos.z - prevPos.current.z) / Math.max(delta, 0.001);
                prevPos.current.copy(currentGroupPos);

                const vel = new THREE.Vector3(vx, vy, vz);

                const dirX = Math.cos(rotation) * Math.cos(camPitch);
                const dirY = Math.sin(camPitch);
                const dirZ = Math.sin(rotation) * Math.cos(camPitch);
                const fwd = new THREE.Vector3(dirX, dirY, dirZ);

                // scalar forward speed
                const forwardSpeed = vel.dot(fwd);

                // REVERSE GEAR: Look behind if driving backward substantially
                const isReversing = forwardSpeed < -15;
                const targetInteriorRot = isReversing ? Math.PI : 0;
                smoothedInteriorRot.current = THREE.MathUtils.lerp(smoothedInteriorRot.current, targetInteriorRot, delta * 6);

                // BANKING: Z-axis tilt based on yaw turn delta
                let yawDelta = rotation - prevYaw.current;
                if (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
                if (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
                prevYaw.current = rotation;

                // CRITICAL FIX: Clamp the targetBank to prevent the gimbal from spinning fully upside down on fast mouse snaps
                const targetBank = THREE.MathUtils.clamp(yawDelta * 8, -0.6, 0.6); // Tilt into the turn safely
                smoothedBank.current = THREE.MathUtils.lerp(smoothedBank.current, targetBank, delta * 8);

                // PITCHING: X-axis tilt based on acceleration
                const accel = forwardSpeed - prevForwardSpeed.current;
                prevForwardSpeed.current = forwardSpeed;
                const targetPitch = THREE.MathUtils.clamp(-accel * 0.05, -0.25, 0.25);
                smoothedPitch.current = THREE.MathUtils.lerp(smoothedPitch.current, targetPitch, delta * 8);

                // Apply the physical tilt without any hardcoded X-axis base offsets!
                // MUST USE 'YXZ' so rotating 180 degrees via Y doesn't scramble pitch/roll local axes!
                interiorGroupRef.current.rotation.set(
                    smoothedPitch.current,
                    smoothedInteriorRot.current,
                    smoothedBank.current,
                    "YXZ"
                );
            }
        }
    });

    const correction = SHIP_TYPE_CORRECTIONS[shipType || 'ufo'] ?? [0, 0, 0];

    const isUfoType = !shipType || shipType === 'ufo';
    // Always show pilot in UFO; dome transparency is handled separately in ShipFallback
    const showPilot = isUfoType;

    return (
        <group ref={groupRef} visible={!isCloaked} scale={[0.45, 0.45, 0.45]}>
            {/* Inner correction group: static per-model visual fix, parent handles world heading */}
            <group rotation={correction}>
                {resolvedModelUrl ? (
                    <Suspense fallback={<ShipFallback type={shipType} color={shipColor} laserOriginRef={laserOriginRef} />}>
                        <GLTFErrorBoundary fallback={<ShipFallback type={shipType} color={shipColor} laserOriginRef={laserOriginRef} />}>
                            <ShipModel url={resolvedModelUrl} />
                        </GLTFErrorBoundary>
                    </Suspense>
                ) : (
                    <ShipFallback type={shipType} color={shipColor} laserOriginRef={laserOriginRef} />
                )}

                {/* Cockpit contents */}
                {showPilot && (
                    <group ref={interiorGroupRef} position={[0, TUB_RIM_Y - 25, 0]} scale={[2.6, 2.6, 2.6]} rotation={[0, 0, 0]}>
                        {/* Enlarged Dashboard with Pedestal mounted cleanly between side brackets */}
                        <group position={[0, 0, 0.5]}>
                            <CockpitDashboard color={shipColor || (isUfoType ? '#22d3ee' : undefined)} isFiring={playerEnt?.is_firing} />
                        </group>

                        {/* Chibi pilot standing proudly in front of the console seat (Pulled tighter to dashboard) */}
                        <group position={[0, 0, -1.8]}>
                            <Suspense fallback={null}>
                                <GLTFErrorBoundary fallback={<></>}>
                                    <ChibiAvatar />
                                </GLTFErrorBoundary>
                            </Suspense>
                        </group>
                    </group>
                )}
            </group>

            {/* Thruster light — positioned below thick hull */}
            <pointLight position={[0, -18, 0]} color={shipColor || (isUfoType ? "#22d3ee" : "#ef4444")} intensity={300} distance={600} />

        </group>
    );
};
