import React, { Suspense, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useTexture, Html, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { ProceduralPlanet } from './ProceduralPlanet';
import { Singularity } from '../three/entities/Anomalies';
import { CombatShipMesh, CockpitDashboard, PilotAvatar, TUB_RIM_Y, GLTFErrorBoundary } from './PlayerShip';

// ── Instanced Asteroid Renderer ─────────────────────────────────────────────
const MAX_ASTEROID_INSTANCES = 200;
const _asteroidDummy = new THREE.Object3D();
const _asteroidHidden = new THREE.Matrix4().makeScale(0, 0, 0);

// GLB version: uses the real NASA Bennu (1999 RQ36) asteroid model as instance geometry.
// Falls back to procedural InstancedAsteroids if the GLB fails to load.
const ASTEROID_GLB_URL = '/assets/models/asteroids/asteroid.glb';
useGLTF.preload(ASTEROID_GLB_URL);

// Helper function to stretch ("spaghettify") entities as they approach a black hole
function applySpaghettification(live: any, dummy: THREE.Object3D, entitiesRef: any, isAsteroid: boolean) {
    let isSucked = false;
    let bhDist = Infinity;
    let dx = 0, dz = 0;
    let bhRadius = 500;

    for (const key in entitiesRef) {
        const bh = entitiesRef[key];
        if (bh.anomaly_type === 'black_hole') {
            const tempDx = live.x - bh.x;
            const tempDz = (live.z || 0) - (bh.z || 0);
            const dist = Math.sqrt(tempDx * tempDx + tempDz * tempDz);
            bhRadius = bh.radius || 500;
            if (dist < bhRadius * 8) { // Event horizon visual pull zone
                isSucked = true;
                bhDist = dist;
                dx = tempDx;
                dz = tempDz;
                break;
            }
        }
    }

    const baseScale = isAsteroid ? ((live.radius || 50) / 50) : (live.scale || 1.0);

    if (isSucked) {
        const stretch = Math.max(1, Math.min(10, (bhRadius * 3) / Math.max(bhDist, 50)));
        if (stretch > 1.1) {
            const angle = Math.atan2(dx, dz);
            dummy.rotation.set(0, angle, 0);
            // Stretch along Z axis (pointing at black hole), squash X/Y
            dummy.scale.set(
                baseScale / Math.sqrt(stretch),
                baseScale / Math.sqrt(stretch),
                baseScale * stretch * 1.5
            );

            // If they are deep inside the event horizon, shrink them to nothing
            if (bhDist < bhRadius * 0.4) {
                dummy.scale.setScalar(0.001);
            }
        } else {
            dummy.scale.setScalar(baseScale);
            dummy.rotation.set(0, live.rotation || 0, 0);
        }
    } else {
        dummy.scale.setScalar(baseScale);
        dummy.rotation.set(0, live.rotation || 0, 0);
    }
}

const InstancedAsteroidsGlbInner = React.memo(
    ({ entitiesRef }: { entitiesRef: React.MutableRefObject<any[]> }) => {
        const { scene } = useGLTF(ASTEROID_GLB_URL);
        const ref = useRef<THREE.InstancedMesh>(null);

        const geometry = useMemo<THREE.BufferGeometry>(() => {
            let found: THREE.BufferGeometry | null = null;
            scene.traverse((child: any) => {
                if (!found && child.isMesh) found = (child as THREE.Mesh).geometry;
            });
            // Clone so we don't mutate the cached GLTF scene
            const geo = found ? (found as THREE.BufferGeometry).clone() : new THREE.DodecahedronGeometry(50, 0);
            // Normalize to radius=50 so _asteroidDummy.scale = (a.radius/50) works correctly.
            // NASA GLBs are often in cm/mm — bounding radius can be tens of thousands of units.
            geo.computeBoundingSphere();
            const r = geo.boundingSphere?.radius ?? 50;
            if (r > 0 && Math.abs(r - 50) > 0.5) {
                geo.applyMatrix4(new THREE.Matrix4().makeScale(50 / r, 50 / r, 50 / r));
            }
            // Recompute normals after transform so lit side correctly faces the sun (point light at origin).
            geo.computeVertexNormals();
            return geo;
        }, [scene]);

        useFrame(() => {
            const mesh = ref.current;
            if (!mesh) return;
            const asteroids = entitiesRef.current;
            const count = Math.min(asteroids.length, MAX_ASTEROID_INSTANCES);
            for (let i = 0; i < count; i++) {
                const a = asteroids[i];
                _asteroidDummy.position.set(a.x, a.y || 0, a.z || 0);
                // Apply spaghettification effect when near singularities
                applySpaghettification(a, _asteroidDummy, entitiesRef.current, true);
                _asteroidDummy.updateMatrix();
                mesh.setMatrixAt(i, _asteroidDummy.matrix);
            }
            for (let i = count; i < MAX_ASTEROID_INSTANCES; i++) {
                mesh.setMatrixAt(i, _asteroidHidden);
            }
            mesh.count = count;
            mesh.instanceMatrix.needsUpdate = true;
        });

        return (
            <instancedMesh ref={ref} args={[undefined, undefined, MAX_ASTEROID_INSTANCES]} frustumCulled={false}>
                <primitive object={geometry} attach="geometry" />
                <meshStandardMaterial color="#8b7355" roughness={0.95} metalness={0.05} />
            </instancedMesh>
        );
    }
);

const InstancedAsteroids = React.memo(
    ({ entitiesRef }: { entitiesRef: React.MutableRefObject<any[]> }) => {
        const dodRef = useRef<THREE.InstancedMesh>(null); // variant 0 (default)
        const icoRef = useRef<THREE.InstancedMesh>(null); // variant 1
        const octRef = useRef<THREE.InstancedMesh>(null); // variant 2

        useFrame(() => {
            const asteroids = entitiesRef.current;
            const refs = [dodRef, icoRef, octRef];
            const buckets: any[][] = [[], [], []];

            for (const a of asteroids) {
                const v = a.model_variant === 1 ? 1 : a.model_variant === 2 ? 2 : 0;
                if (buckets[v].length < MAX_ASTEROID_INSTANCES) buckets[v].push(a);
            }

            for (let v = 0; v < 3; v++) {
                const mesh = refs[v].current;
                if (!mesh) continue;
                const bucket = buckets[v];
                const count = bucket.length;
                for (let i = 0; i < count; i++) {
                    const a = bucket[i];
                    _asteroidDummy.position.set(a.x, a.y || 0, a.z || 0);
                    // Apply spaghettification effect
                    applySpaghettification(a, _asteroidDummy, entitiesRef.current, true);
                    _asteroidDummy.updateMatrix();
                    mesh.setMatrixAt(i, _asteroidDummy.matrix);
                }
                // Hide unused slots
                for (let i = count; i < MAX_ASTEROID_INSTANCES; i++) {
                    mesh.setMatrixAt(i, _asteroidHidden);
                }
                mesh.count = count;
                mesh.instanceMatrix.needsUpdate = true;
            }
        });

        // Base geometry at radius=50; per-instance scale handles size variation
        return (
            <>
                <instancedMesh ref={dodRef} args={[undefined, undefined, MAX_ASTEROID_INSTANCES]} frustumCulled={false}>
                    <dodecahedronGeometry args={[50, 0]} />
                    <meshStandardMaterial color="#52525b" roughness={0.9} />
                </instancedMesh>
                <instancedMesh ref={icoRef} args={[undefined, undefined, MAX_ASTEROID_INSTANCES]} frustumCulled={false}>
                    <icosahedronGeometry args={[50, 0]} />
                    <meshStandardMaterial color="#52525b" roughness={0.9} />
                </instancedMesh>
                <instancedMesh ref={octRef} args={[undefined, undefined, MAX_ASTEROID_INSTANCES]} frustumCulled={false}>
                    <octahedronGeometry args={[50, 0]} />
                    <meshStandardMaterial color="#52525b" roughness={0.9} />
                </instancedMesh>
            </>
        );
    }
);

const ASSET_BASE_URL = '/assets/';
const MODEL_BASE = ASSET_BASE_URL + 'models/';

// Client-side distance culling — cull dynamic entities beyond this radius from player
const CULL_DISTANCE_SQ = 15000 * 15000;

const TEXTURE_MAP: Record<string, string> = {
    // Planets
    "Sun": "Textures/2k_sun.jpg",
    "Mercury": "Textures/2k_mercury.jpg",
    "Venus": "Textures/2k_venus_surface.jpg",
    "Earth": "Textures/2k_earth_daymap.jpg",
    "Mars": "Textures/2k_mars.jpg",
    "Jupiter": "Textures/2k_jupiter.jpg",
    "Saturn": "Textures/2k_saturn.jpg",
    "Uranus": "Textures/2k_uranus.jpg",
    "Neptune": "Textures/2k_neptune.jpg",
    // Moons — best available match
    "Luna": "Textures/2k_moon.jpg",
    "Phobos": "Textures/2k_moon.jpg",
    "Deimos": "Textures/2k_moon.jpg",
    "Io": "Textures/2k_venus_surface.jpg",
    "Europa": "Textures/2k_moon.jpg",
    "Titan": "Textures/2k_venus_atmosphere.jpg",
};

// removed: getVisualPos (logarithmic scaling removed for 1:1 sync)

interface PlanetMeshProps {
    name: string;
    radius: number;
    fallbackColor: string;
    isSun?: boolean;
}

// Plain (no-texture) fallback — always safe to render
const PlanetMeshPlain: React.FC<{ radius: number; isSun: boolean; fallbackColor?: string }> = ({ radius, isSun, fallbackColor }) => {
    if (isSun) {
        return (
            <mesh>
                <sphereGeometry args={[radius, 64, 64]} />
                <meshStandardMaterial emissive="#ff8c00" emissiveIntensity={4} color="#ffd700" roughness={0.0} metalness={1.0} toneMapped={false} wireframe={false} />
            </mesh>
        );
    }
    return (
        <mesh>
            <sphereGeometry args={[radius, 32, 32]} />
            <meshStandardMaterial color={fallbackColor || "gray"} roughness={0.4} metalness={0.3} wireframe={false} />
        </mesh>
    );
};

// Inner textured component — calls useTexture (may throw/suspend)
const PlanetMeshTextured: React.FC<{ textureUrl: string; radius: number; isSun: boolean }> = ({ textureUrl, radius, isSun }) => {
    const texture = useTexture(textureUrl);
    if (isSun) {
        return (
            <mesh>
                <sphereGeometry args={[radius, 64, 64]} />
                {/* Standard material with emissive map makes the sun actually feel like it's glowing */}
                <meshStandardMaterial
                    map={texture}
                    emissiveMap={texture}
                    emissive={new THREE.Color(0xffffff)}
                    emissiveIntensity={1.2}
                    toneMapped={true}
                    wireframe={false}
                />
            </mesh>
        );
    }
    return (
        <mesh>
            <sphereGeometry args={[radius, 32, 32]} />
            <meshStandardMaterial map={texture} roughness={0.7} metalness={0.2} wireframe={false} />
        </mesh>
    );
};

// Error boundary: catches texture-load failures and renders the plain fallback
class TextureErrorBoundary extends React.Component<
    { children: React.ReactNode; fallback: React.ReactNode },
    { hasError: boolean }
> {
    constructor(props: any) { super(props); this.state = { hasError: false }; }
    static getDerivedStateFromError() { return { hasError: true }; }
    render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

// Public component: tries textured, gracefully falls back to plain on any error
const PlanetMesh: React.FC<PlanetMeshProps> = ({ name, radius, fallbackColor, isSun }) => {
    const textureFile = TEXTURE_MAP[name];
    const plain = <PlanetMeshPlain radius={radius} isSun={!!isSun} fallbackColor={fallbackColor} />;
    if (!textureFile) return plain;
    return (
        <TextureErrorBoundary fallback={plain}>
            <Suspense fallback={plain}>
                <PlanetMeshTextured textureUrl={`${ASSET_BASE_URL}${textureFile}`} radius={radius} isSun={!!isSun} />
            </Suspense>
        </TextureErrorBoundary>
    );
};

// ── GLB Model Loader ────────────────────────────────────────────────────────
// Generic component: loads a .glb file, clones the scene, applies uniform scale.
// Wrapped in Suspense + ErrorBoundary so any missing/corrupt file gracefully
// falls back to the provided `fallback` node (default: nothing).

// Global cache of URLs that have already failed — avoids retrying broken models
// every render cycle, which was causing massive error spam and freezing.
const _failedGlbUrls = new Set<string>();

class GlbErrorBoundary extends React.Component<
    { children: React.ReactNode; fallback: React.ReactNode; url?: string },
    { hasError: boolean }
> {
    constructor(props: any) { super(props); this.state = { hasError: false }; }
    static getDerivedStateFromError() { return { hasError: true }; }
    componentDidCatch() {
        // Cache the failed URL so we never retry it
        if (this.props.url) _failedGlbUrls.add(this.props.url);
    }
    render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

// scale = desired world-space radius. Component auto-normalises the GLB so any
// model (regardless of export unit) renders at exactly that size.
// rotation = Euler [x,y,z] in radians to correct model orientation.
const GlbModelInner: React.FC<{ url: string; scale: number; rotation?: [number, number, number] }> = ({ url, scale, rotation = [0, 0, 0] }) => {
    const { scene } = useGLTF(url);
    const clone = useMemo(() => scene.clone(true), [scene]);
    const normalRadius = useMemo(() => {
        const box = new THREE.Box3().setFromObject(clone);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        return sphere.radius || 1;
    }, [clone]);
    const s = scale / normalRadius;
    return (
        <group rotation={rotation}>
            <primitive object={clone} scale={[s, s, s]} />
        </group>
    );
};

const GlbModel: React.FC<{
    url: string; scale?: number;
    rotation?: [number, number, number];
    fallback?: React.ReactNode;
}> = ({ url, scale = 1, rotation, fallback = null }) => {
    // If this URL already failed, skip the load entirely — render fallback
    if (_failedGlbUrls.has(url)) return <>{fallback}</>;
    return (
        <GlbErrorBoundary fallback={fallback} url={url}>
            <Suspense fallback={fallback}>
                <GlbModelInner url={url} scale={scale} rotation={rotation} />
            </Suspense>
        </GlbErrorBoundary>
    );
};

// Preload all models so they are cached before first use
// Note: MODEL_BASE points to the Vite-served /assets/models/ folder populated by xcopy.

// Per-GLB orientation corrections applied inside Ry(-R + PI/2) outer group.
// Same convention as SHIP_TYPE_CORRECTIONS in PlayerShip.tsx.
// Outer group uses Ry(-R + PI/2) so Rust rotation R (vx=cos(R), vz=sin(R)) maps correctly.
const GLB_ROTATIONS: Record<string, [number, number, number]> = {
    [MODEL_BASE + 'ships/fighter.glb']: [Math.PI / 2, Math.PI, 0],
    [MODEL_BASE + 'ships/shuttle.glb']: [Math.PI / 2, Math.PI, 0],
    [MODEL_BASE + 'ships/suzaku.glb']: [Math.PI / 2, Math.PI, 0],
    [MODEL_BASE + 'ships/Space Shuttle (B).glb']: [Math.PI / 2, Math.PI, 0],
    [MODEL_BASE + 'ships/rick_and_morty_space_ship.glb']: [0, 0, 0],
};

// Map Rust model_type strings to actual GLB URLs for neutral ships
const NEUTRAL_SHIP_URLS: Record<string, string> = {
    shuttle: MODEL_BASE + 'ships/shuttle.glb',
    fighter: MODEL_BASE + 'ships/fighter.glb',
    suzaku: MODEL_BASE + 'ships/suzaku.glb',
    space_shuttle_b: MODEL_BASE + 'ships/Space Shuttle (B).glb',
    rick_cruiser: MODEL_BASE + 'ships/rick_and_morty_space_ship.glb',
};
// Preload all neutral ship GLBs so spectator-focus shows the model instantly (no fallback flash)
Object.values(NEUTRAL_SHIP_URLS).forEach(url => useGLTF.preload(url));

// ── Visual Config — AI-controlled overrides ─────────────────────────────────
// Sent by the AI Director via world_state.visual_config and forwarded here.
// Default: all planets use textures. AI can switch to 'glb' or 'glb_alt' per planet.
export interface VisualConfig {
    // Per-planet: 'glb' | 'glb_alt' | 'texture'. Omit to use default (texture).
    planet_mode?: Record<string, 'glb' | 'glb_alt' | 'texture'>;
    // Per-planet scale multiplier (1.0 = default game size).
    planet_scale_overrides?: Record<string, number>;
    // Per-planet custom AI-generated texture URLs
    custom_textures?: Record<string, string>;
    // Override enemy ship GLB: 'fighter' | 'shuttle'. Null = per-variant default.
    enemy_ship_model?: string;
}

// ── Planet GLB models (primary) — all planets enabled ───────────────────────
const PLANET_MODELS: Record<string, string> = {
    'Sun': MODEL_BASE + 'planets/sun.glb',
    'Mercury': MODEL_BASE + 'planets/mercury.glb',
    'Venus': MODEL_BASE + 'planets/venus.glb',
    'Earth': MODEL_BASE + 'planets/earth.glb',
    'Mars': MODEL_BASE + 'planets/mars.glb',
    'Jupiter': MODEL_BASE + 'planets/jupiter.glb',     // realistic_jupiter (3.4 MB)
    'Saturn': MODEL_BASE + 'planets/saturn.glb',      // 1.7 MB
    'Uranus': MODEL_BASE + 'planets/uranus.glb',
    'Neptune': MODEL_BASE + 'planets/neptune.glb',
    'Titan': MODEL_BASE + 'planets/titan.glb',
    'Cromulon': '/assets/models/big_head_cromulons_from_rick_and_morty.glb',
};
// Alternative variants (Jupiter/Saturn have two models; AI can pick via 'glb_alt')
const PLANET_MODELS_ALT: Record<string, string> = {
    'Jupiter': MODEL_BASE + 'planets/jupiter_alt.glb', // original 2.4 MB variant
    'Saturn': MODEL_BASE + 'planets/saturn_alt.glb',  // high-detail 13 MB variant
};

// Planet models are loaded as needed by GlbModelInner. 
// Preloading has been disabled to prevent console errors from legacy assets.
const STATION_MODELS = [
    MODEL_BASE + 'stations/observatory.glb',          // variant 0
    MODEL_BASE + 'stations/tdrs.glb',                 // variant 1
    MODEL_BASE + 'stations/aim.glb',                  // variant 2
    MODEL_BASE + 'stations/lander.glb',               // variant 3
    MODEL_BASE + 'stations/gateway.glb',              // variant 4
    MODEL_BASE + 'stations/stellar_sail.glb',         // variant 5
    MODEL_BASE + 'stations/Mars Atmosphere and Volatile EvolutioN (MAVEN) (B).glb', // variant 6
];
const COMPANION_MODELS = [
    MODEL_BASE + 'companions/astronaut.glb',
    MODEL_BASE + 'companions/robonaut.glb',
];
// Preload station & companion GLBs to eliminate fallback flash during spectator focus
STATION_MODELS.forEach(url => useGLTF.preload(url));
COMPANION_MODELS.forEach(url => useGLTF.preload(url));

// ── Alien Enemy Procedural Geometry ─────────────────────────────────────────

const AlienSwarmer: React.FC<{ radius: number }> = ({ radius }) => {
    return (
        <group>
            {/* Core Spiky Body */}
            <mesh>
                <coneGeometry args={[radius * 0.4, radius * 1.5, 3]} />
                <meshStandardMaterial color="#2e1065" metalness={0.9} roughness={0.1} emissive="#7c3aed" emissiveIntensity={0.5} />
            </mesh>
            {/* Side Spikes */}
            {[-1, 1].map((s) => (
                <mesh key={s} position={[s * radius * 0.5, 0, 0]} rotation={[0, 0, s * Math.PI / 4]}>
                    <coneGeometry args={[radius * 0.2, radius, 3]} />
                    <meshStandardMaterial color="#1e1b4b" metalness={1} roughness={0.1} />
                </mesh>
            ))}
            {/* Pulsing Eye/Engine */}
            <mesh position={[0, 0, radius * 0.3]}>
                <sphereGeometry args={[radius * 0.2, 8, 8]} />
                <meshBasicMaterial color="#ef4444" />
            </mesh>
        </group>
    );
};

const AlienRavager: React.FC<{ radius: number }> = ({ radius }) => {
    return (
        <group>
            {/* Main bio-hull */}
            <mesh>
                <torusKnotGeometry args={[radius * 0.6, radius * 0.2, 64, 8]} />
                <meshStandardMaterial color="#064e3b" metalness={0.8} roughness={0.2} emissive="#10b981" emissiveIntensity={2} />
            </mesh>
            {/* Pulsing Bio-Core */}
            <mesh>
                <sphereGeometry args={[radius * 0.4, 16, 16]} />
                <meshBasicMaterial color="#34d399" />
            </mesh>
            {/* Tentacle-like probes */}
            {[0, 1, 2, 3].map((i) => (
                <mesh key={i} rotation={[0, 0, (i * Math.PI) / 2]} position={[radius * 0.8, 0, 0]}>
                    <boxGeometry args={[radius * 0.5, radius * 0.1, radius * 0.1]} />
                    <meshStandardMaterial color="#022c22" />
                </mesh>
            ))}
        </group>
    );
};

const AlienMothership: React.FC<{ radius: number }> = ({ radius }) => {
    return (
        <group>
            {/* Massive Monolithic Core */}
            <mesh>
                <octahedronGeometry args={[radius * 1.2, 0]} />
                <meshStandardMaterial color="#09090b" metalness={1} roughness={0.05} emissive="#a855f7" emissiveIntensity={0.2} />
            </mesh>
            {/* Rotating Outer Rings */}
            <group rotation={[Math.PI / 4, 0, 0]}>
                <mesh>
                    <torusGeometry args={[radius * 1.8, radius * 0.05, 16, 100]} />
                    <meshStandardMaterial color="#3b0764" emissive="#a855f7" emissiveIntensity={5} />
                </mesh>
            </group>
            <group rotation={[-Math.PI / 4, Math.PI / 4, 0]}>
                <mesh>
                    <torusGeometry args={[radius * 2.2, radius * 0.03, 16, 100]} />
                    <meshStandardMaterial color="#1e1b4b" emissive="#38bdf8" emissiveIntensity={2} />
                </mesh>
            </group>
            {/* Spires/Antennas */}
            {[0, 1, 2, 3, 4, 5].map((i) => (
                <mesh key={i} position={[Math.cos(i * Math.PI / 3) * radius, Math.sin(i * Math.PI / 3) * radius, radius * 0.5]}>
                    <cylinderGeometry args={[radius * 0.05, radius * 0.1, radius * 2]} />
                    <meshStandardMaterial color="#18181b" />
                </mesh>
            ))}
            {/* Giant Central Light — removed pointLight for performance */}
            <mesh position={[0, 0, radius * 0.8]}>
                <sphereGeometry args={[radius * 0.3, 32, 32]} />
                <meshBasicMaterial color="#a855f7" />
            </mesh>
        </group>
    );
};
// ── AnimatedExplosion ────────────────────────────────────────────────────────
// Self-contained explosion that animates via local useFrame timer, so it works
// even when the parent entities state is throttled and spawn_age is stale.
const AnimatedExplosion: React.FC = () => {
    const meshRef = useRef<THREE.Mesh>(null);
    const matRef = useRef<THREE.MeshStandardMaterial>(null);
    const startTime = useRef(performance.now());
    useFrame(() => {
        const age = (performance.now() - startTime.current) / 1000;
        const t = Math.min(age / 0.5, 1);
        if (meshRef.current) meshRef.current.scale.setScalar(t * 400);
        if (matRef.current) {
            matRef.current.opacity = 1 - t;
            matRef.current.emissiveIntensity = 10 * (1 - t);
        }
    });
    return (
        <mesh ref={meshRef}>
            <sphereGeometry args={[1, 32, 32]} />
            <meshStandardMaterial ref={matRef} color="#f59e0b" emissive="#f59e0b" emissiveIntensity={10} transparent opacity={1} wireframe={false} />
        </mesh>
    );
};

// ── EnemyHealthBar ───────────────────────────────────────────────────────────
// Reads health directly from the live ref in useFrame and patches the DOM bar
// width imperatively — no React re-render needed for health updates.
const EnemyHealthBar: React.FC<{
    entityId: number;
    entitiesRef: React.MutableRefObject<Record<string, any>>;
    radius: number;
}> = ({ entityId, entitiesRef, radius }) => {
    const barRef = useRef<HTMLDivElement>(null);
    useFrame(() => {
        if (!barRef.current) return;
        const ent = entitiesRef.current[entityId];
        if (!ent || !ent.health_max) return;
        const hpRatio = Math.max(0, Math.min(1, (ent.health_current ?? 0) / ent.health_max));
        barRef.current.style.width = `${hpRatio * 100}%`;
        barRef.current.style.background = hpRatio > 0.6 ? '#22c55e' : hpRatio > 0.3 ? '#eab308' : '#ef4444';
    });
    return (
        <Html position={[0, radius * 3.2, 0]} center distanceFactor={80} zIndexRange={[10, 20]}>
            <div style={{ width: '52px', height: '5px', background: '#0a0a1e', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '2px', overflow: 'hidden' }}>
                <div ref={barRef} style={{ height: '100%', width: '100%', background: '#22c55e' }} />
            </div>
        </Html>
    );
};

interface EntityRendererProps {
    entities: Record<string, any>;
    entitiesRef: React.MutableRefObject<Record<string, any>>;
    newbornIds: Set<number>;
    dyingIds: Set<number>;
    realityOverride?: any;
    targetedEntityId?: number | null;
    visualConfig?: VisualConfig;
    spectatorTargetId?: number | null;
    globalOverride?: {
        sun_visible?: boolean;
        ambient_color?: string;
        ambient_intensity?: number;
        skybox_color?: string;
    };
    customTextureUrl?: string | null;
}

export const EntityRenderer: React.FC<EntityRendererProps> = ({
    entities, entitiesRef, newbornIds, dyingIds, realityOverride,
    targetedEntityId, visualConfig, spectatorTargetId, globalOverride,
    customTextureUrl
}) => {
    // Asteroid ref — updated every Three.js frame from live entitiesRef (bypasses React state throttling)
    const asteroidsRef = useRef<any[]>([]);

    // Per-entity group refs (registered via ref callbacks) so a single useFrame can drive positions
    const entityGroupsRef = useRef<Map<number, THREE.Group>>(new Map());
    // Stable ref-callback cache keyed by entity ID to avoid creating new functions each render
    const refCallbacksRef = useRef<Map<number, (el: THREE.Group | null) => void>>(new Map());

    const getGroupRefCallback = (entityId: number) => {
        if (!refCallbacksRef.current.has(entityId)) {
            refCallbacksRef.current.set(entityId, (el: THREE.Group | null) => {
                if (el) entityGroupsRef.current.set(entityId, el);
                else entityGroupsRef.current.delete(entityId);
            });
        }
        return refCallbacksRef.current.get(entityId)!;
    };

    useFrame(() => {
        // Update asteroid list from live ref every frame
        asteroidsRef.current = Object.values(entitiesRef.current).filter((e: any) => e.ent_type === 'asteroid');

        // Update positions of all dynamic entities directly via Three.js, bypassing React reconciliation
        for (const [entityId, group] of entityGroupsRef.current) {
            const live = entitiesRef.current[entityId];
            if (!live) continue;
            const t = live.ent_type;
            // Sun, planet, moon, star are static — skip
            if (t === 'sun' || t === 'planet' || t === 'moon' || t === 'star') continue;

            group.position.set(live.x, live.y || 0, live.z || 0);

            // Only apply spaghettification to things that aren't the player
            // (The player has their own cinematic death camera sequence).
            if (t !== 'player' && t !== 'anomaly') {
                applySpaghettification(live, group, entitiesRef.current, false);
            }
        }
    });

    // 1. Organize Hierarchy — exclude asteroids (rendered via instancedMesh) and player
    const parents = Object.values(entities).filter(e => !e.parent_id && e.ent_type !== 'player' && e.ent_type !== 'asteroid');
    const childrenByParent = Object.values(entities).reduce((acc: any, ent: any) => {
        if (ent.parent_id) {
            if (!acc[ent.parent_id]) acc[ent.parent_id] = [];
            acc[ent.parent_id].push(ent);
        }
        return acc;
    }, {} as Record<number, any[]>);

    // 2. Identify Player Target Lock
    const playerEnt = Object.values(entities).find((e: any) => e.ent_type === 'player');
    const playerTargetId = playerEnt?.target_lock_id;

    return (
        <Suspense fallback={null}>
            {parents.map((ent: any) => {
                const id = ent.id;
                const isNew = newbornIds.has(ent.id);
                const isDying = dyingIds.has(ent.id);
                const lifeScale = isNew ? 1.5 : isDying ? 0.1 : 1.0;

                const isSun = ent.ent_type === 'sun';
                const isPlanet = ent.ent_type === 'planet';
                const isStar = ent.ent_type === 'star';
                const isAnomaly = ent.ent_type === 'anomaly';
                const isStation = ent.ent_type === 'space_station';
                const isAlien = ent.ent_type === 'alien_ship';
                const isProjectile = ent.ent_type === 'projectile';
                const isAsteroid = ent.ent_type === 'asteroid';
                const isEnemy = ent.ent_type === 'enemy' || ent.ent_type === 'hostile';
                const isNeutral = ent.ent_type === 'neutral';
                const isCompanion = ent.ent_type === 'companion';
                const isExplosion = ent.ent_type === 'explosion';

                const isTargeted = id === playerTargetId || id === targetedEntityId;

                // Client-side distance culling: skip dynamic entities far from the camera focus
                // Permanent landmarks (sun, planet, star, anomaly) are always rendered
                const isPermanent = isSun || isPlanet || isStar || isAnomaly || isStation;

                let focusEnt = playerEnt;
                if (spectatorTargetId !== null && spectatorTargetId !== undefined) {
                    focusEnt = entities[spectatorTargetId] || playerEnt;
                }

                if (!isPermanent && focusEnt) {
                    const dx = ent.x - focusEnt.x;
                    const dy = (ent.y || 0) - (focusEnt.y || 0);
                    const dz = (ent.z || 0) - (focusEnt.z || 0);
                    if (dx * dx + dy * dy + dz * dz > CULL_DISTANCE_SQ) return null;
                }

                // Planet Color Palette
                const getPlanetColor = (name: string) => {
                    switch (name) {
                        case 'Mercury': return '#8c8c8c'; // Grey bedrock
                        case 'Venus': return '#e3bb76';   // Sulfur clouds
                        case 'Earth': return '#2271b3';   // Deep blue
                        case 'Mars': return '#a34828';    // Rusty red
                        case 'Jupiter': return '#d39c7e'; // Banded gas
                        case 'Saturn': return '#c5ab6e';  // Pale gold
                        case 'Uranus': return '#b8e3e4';  // Cyan ice
                        case 'Neptune': return '#3d5ef9'; // Dark blue gas
                        case 'Cromulon': return '#d19b45'; // Gold head
                        default: return '#71717a';
                    }
                };

                // Planet radii ×3 (Phase 9+ rescale)
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
                        case 'Cromulon': return 800;
                        default: return 150;
                    }
                };

                const visualPos = (isSun ? [0, 0, 0] : [ent.x, ent.y, ent.z || 0]) as [number, number, number];
                const finalRadius = isSun ? 1000 : getPlanetRadius(ent.name);

                const finalScale = (ent.scale || 1.0) * lifeScale;

                // Coordinate rule: Rust(x, y, z) → Three.js(x, y, z)
                // All entities use a plain <group>; the single useFrame above drives
                // position updates for dynamic entities via entityGroupsRef (no inline
                // component creation, no React reconciliation jitter).
                return (
                    <group
                        key={id}
                        ref={getGroupRefCallback(id)}
                        position={visualPos}
                        scale={[finalScale, finalScale, finalScale]}
                    >
                        {isSun && globalOverride?.sun_visible !== false && (() => {
                            const sunMode = visualConfig?.planet_mode?.['Sun'] || visualConfig?.planet_mode?.['sun'];
                            const sunScale = finalRadius * (visualConfig?.planet_scale_overrides?.['Sun'] ?? visualConfig?.planet_scale_overrides?.['sun'] ?? 1);

                            // Support custom textures for the Sun
                            const specificCustomUrl =
                                visualConfig?.custom_textures?.['Sun'] ||
                                visualConfig?.custom_textures?.['sun'] ||
                                customTextureUrl;

                            let sunFallback;

                            if (specificCustomUrl) {
                                const finalTextureUrl = specificCustomUrl.includes('/assets/')
                                    ? specificCustomUrl.substring(specificCustomUrl.indexOf('/assets/'))
                                    : specificCustomUrl;

                                sunFallback = (
                                    <TextureErrorBoundary fallback={<PlanetMesh name="Sun" radius={sunScale} fallbackColor="#ffd700" isSun />}>
                                        <Suspense fallback={<PlanetMeshPlain radius={sunScale} isSun={true} fallbackColor="#ffd700" />}>
                                            <PlanetMeshTextured textureUrl={finalTextureUrl} radius={sunScale} isSun={true} />
                                        </Suspense>
                                    </TextureErrorBoundary>
                                );
                            } else {
                                sunFallback = <PlanetMesh name="Sun" radius={sunScale} fallbackColor="#ffd700" isSun />;
                            }

                            const sunGlbUrl = sunMode === 'glb_alt' ? (PLANET_MODELS_ALT['Sun'] || PLANET_MODELS['Sun']) : PLANET_MODELS['Sun'];
                            const showGlb = (sunMode === 'glb' || sunMode === 'glb_alt') && sunGlbUrl;
                            return (
                                <group>
                                    {showGlb
                                        ? <GlbModel url={sunGlbUrl} scale={sunScale} fallback={sunFallback} />
                                        : sunFallback}
                                    <pointLight color={realityOverride?.sun_color || '#fcd34d'} intensity={1000} distance={300000} decay={0.1} />
                                </group>
                            );
                        })()}

                        {isPlanet && (() => {
                            const pMode = visualConfig?.planet_mode?.[ent.name];
                            const pBaseR = getPlanetRadius(ent.name);
                            const pScale = pBaseR * (visualConfig?.planet_scale_overrides?.[ent.name] ?? 1);

                            const hasTexture = !!TEXTURE_MAP[ent.name];

                            // Case-insensitive lookup for custom textures
                            const planetName = ent.name || "";
                            const capitalizedName = planetName.charAt(0).toUpperCase() + planetName.slice(1).toLowerCase();
                            const specificCustomUrl =
                                visualConfig?.custom_textures?.[planetName] ||
                                visualConfig?.custom_textures?.[capitalizedName] ||
                                (planetName === 'Earth' || planetName === 'Sun' || planetName === 'sun' ? customTextureUrl : null);

                            const isPlanetActuallySun = planetName === 'Sun' || planetName === 'sun';

                            // If an AI custom texture was generated, wrap it in a fallback
                            let pFallback;
                            if (specificCustomUrl) {
                                // Ensure the URL is absolute to the backend if it's a relative path
                                const finalTextureUrl = specificCustomUrl.includes('/assets/')
                                    ? specificCustomUrl.substring(specificCustomUrl.indexOf('/assets/'))
                                    : specificCustomUrl;

                                pFallback = (
                                    <TextureErrorBoundary fallback={hasTexture ? <PlanetMesh name={ent.name} radius={pScale} fallbackColor={getPlanetColor(ent.name)} isSun={isPlanetActuallySun} /> : <ProceduralPlanet radius={pScale} entityId={ent.id} />}>
                                        <Suspense fallback={<ProceduralPlanet radius={pScale} entityId={ent.id} />}>
                                            <PlanetMeshTextured textureUrl={finalTextureUrl} radius={pScale} isSun={isPlanetActuallySun} />
                                        </Suspense>
                                    </TextureErrorBoundary>
                                );
                            } else {
                                pFallback = hasTexture
                                    ? <PlanetMesh name={ent.name} radius={pScale} fallbackColor={getPlanetColor(ent.name)} />
                                    : <ProceduralPlanet radius={pScale} entityId={ent.id} />;
                            }

                            const pGlbUrl = pMode === 'glb_alt'
                                ? (PLANET_MODELS_ALT[ent.name] || PLANET_MODELS[ent.name])
                                : PLANET_MODELS[ent.name];
                            // Cromulon is EXCLUSIVELY a GLB model
                            const showPlanetGlb = (ent.name === 'Cromulon') || ((pMode === 'glb' || pMode === 'glb_alt') && pGlbUrl);
                            return (
                                <group>
                                    {showPlanetGlb
                                        ? <GlbModel url={pGlbUrl} scale={pScale} fallback={pFallback} />
                                        : pFallback}
                                    {ent.name === 'Saturn' && (
                                        <mesh rotation={[Math.PI / 2.5, 0, 0]}>
                                            <torusGeometry args={[getPlanetRadius(ent.name) * 1.8, 5, 2, 100]} />
                                            <meshStandardMaterial color="#fcd34d" transparent opacity={0.6} wireframe={false} />
                                        </mesh>
                                    )}

                                    {/* RENDER MOONS */}
                                    {childrenByParent[ent.id]?.map((moon: any) => {
                                        const mVisualPos = [moon.x - ent.x, (moon.y || 0) - (ent.y || 0), (moon.z || 0) - (ent.z || 0)] as [number, number, number];
                                        const moonMode = visualConfig?.planet_mode?.[moon.name];
                                        const moonR = (moon.radius || 30) * (visualConfig?.planet_scale_overrides?.[moon.name] ?? 1);

                                        const hasMoonTexture = !!TEXTURE_MAP[moon.name];

                                        // Support custom textures for Moons
                                        const moonNameRaw = moon.name || "";
                                        const moonNameCap = moonNameRaw.charAt(0).toUpperCase() + moonNameRaw.slice(1).toLowerCase();
                                        const moonCustomUrl =
                                            visualConfig?.custom_textures?.[moonNameRaw] ||
                                            visualConfig?.custom_textures?.[moonNameCap] ||
                                            (moonNameRaw === 'Luna' || moonNameRaw === 'Moon' ? customTextureUrl : null);

                                        let moonFallback;
                                        if (moonCustomUrl) {
                                            const finalMoonUrl = moonCustomUrl.includes('/assets/')
                                                ? moonCustomUrl.substring(moonCustomUrl.indexOf('/assets/'))
                                                : moonCustomUrl;

                                            moonFallback = (
                                                <TextureErrorBoundary fallback={hasMoonTexture ? <PlanetMesh name={moon.name} radius={moonR} fallbackColor={moon.custom_color || '#a8a8a8'} /> : <ProceduralPlanet radius={moonR} entityId={moon.id} />}>
                                                    <Suspense fallback={<ProceduralPlanet radius={moonR} entityId={moon.id} />}>
                                                        <PlanetMeshTextured textureUrl={finalMoonUrl} radius={moonR} isSun={false} />
                                                    </Suspense>
                                                </TextureErrorBoundary>
                                            );
                                        } else {
                                            moonFallback = hasMoonTexture
                                                ? <PlanetMesh name={moon.name || "Moon"} radius={moonR} fallbackColor={moon.custom_color || '#a8a8a8'} />
                                                : <ProceduralPlanet radius={moonR} entityId={moon.id} />;
                                        }

                                        const moonGlbUrl = (moonMode === 'glb' || moonMode === 'glb_alt') ? PLANET_MODELS[moon.name] : undefined;
                                        return (
                                            <group key={moon.id} position={mVisualPos}>
                                                {moonGlbUrl
                                                    ? <GlbModel url={moonGlbUrl} scale={moonR} fallback={moonFallback} />
                                                    : moonFallback}
                                            </group>
                                        );
                                    })}
                                </group>
                            );
                        })()}

                        {isStar && (
                            <mesh rotation={[0, 0, ent.rotation || 0]}>
                                <boxGeometry args={[0.5, 0.1, 0.1]} />
                                <meshBasicMaterial color="#38bdf8" wireframe={false} />
                            </mesh>
                        )}

                        {isAsteroid && (
                            <mesh>
                                {ent.model_variant === 1 ? (
                                    <icosahedronGeometry args={[ent.radius || 50, 0]} />
                                ) : ent.model_variant === 2 ? (
                                    <octahedronGeometry args={[ent.radius || 50, 0]} />
                                ) : (
                                    <dodecahedronGeometry args={[ent.radius || 50, 0]} />
                                )}
                                <meshStandardMaterial color="#52525b" roughness={0.9} wireframe={false} />
                            </mesh>
                        )}

                        {isProjectile && (
                            <mesh>
                                <sphereGeometry args={[ent.projectile_size || 8, 8, 8]} />
                                <meshBasicMaterial
                                    color={ent.custom_color || "#ef4444"}
                                    toneMapped={false}
                                />
                            </mesh>
                        )}

                        {isEnemy && (() => {
                            const r = ent.radius || 18;
                            // Tactical Control: AI can override color and ship type (e.g. 'ufo', 'fighter', 'stealth')
                            // Requirement: Default to RED and UFO mesh.
                            const lightColor = ent.custom_color || "#ef4444";
                            const shipType = ent.model_type || "ufo";

                            return (
                                <group rotation={[0, -(ent.rotation || 0) + Math.PI / 2, 0]} scale={[r / 40, r / 40, r / 40]}>
                                    <CombatShipMesh type={shipType} color={lightColor} />

                                    {/* Enemy Cockpit: Only for UFO or enemy types */}
                                    {(shipType === 'ufo' || shipType === 'enemy') && (
                                        <group position={[0, TUB_RIM_Y - 25, 0]} scale={[2.6, 2.6, 2.6]}>
                                            <group position={[0, 0, 0.5]}>
                                                <CockpitDashboard color={lightColor} isFiring={ent.is_firing} />
                                            </group>
                                            <group position={[0, 0, -1.8]}>
                                                <Suspense fallback={null}>
                                                    <GLTFErrorBoundary fallback={<></>}>
                                                        <PilotAvatar url="/assets/models/chibi.glb" scale={20} />
                                                    </GLTFErrorBoundary>
                                                </Suspense>
                                            </group>
                                        </group>
                                    )}

                                    {/* Removed pointLight to fix performance lag - light count was too high */}
                                </group>
                            );
                        })()}

                        {isNeutral && (() => {
                            const r = ent.radius || 18;
                            // Map model_type to actual GLB URL — each model_type maps to a unique ship
                            const shipUrl = (ent.model_type && NEUTRAL_SHIP_URLS[ent.model_type])
                                ? NEUTRAL_SHIP_URLS[ent.model_type]
                                : MODEL_BASE + 'ships/shuttle.glb';

                            const fallback = (
                                <group>
                                    <AlienSwarmer radius={r} />
                                </group>
                            );
                            return (
                                <group rotation={[0, -(ent.rotation || 0) + Math.PI / 2, 0]}>
                                    <GlbModel url={shipUrl} scale={r} rotation={GLB_ROTATIONS[shipUrl] ?? [0, 0, 0]} fallback={fallback} />
                                </group>
                            );
                        })()}

                        {isCompanion && (() => {
                            const isFed = ent.faction === 'federation';
                            const companionUrl = isFed
                                ? COMPANION_MODELS[0]  // astronaut
                                : COMPANION_MODELS[1]; // robonaut
                            const r = ent.radius || 14;
                            // Astronaut/Robonaut: scale=r*5 so they're visible (r≈14 → 70 units)
                            const companionScale = r * 5;
                            const companionFallback = (
                                <mesh>
                                    {isFed ? (
                                        <>
                                            <octahedronGeometry args={[r, 0]} />
                                            <meshStandardMaterial color="#0ea5e9" emissive="#22d3ee" emissiveIntensity={1.5} roughness={0.3} wireframe={false} />
                                        </>
                                    ) : (
                                        <>
                                            <boxGeometry args={[r, r, r]} />
                                            <meshStandardMaterial color="#22c55e" roughness={0.5} wireframe={false} />
                                        </>
                                    )}
                                </mesh>
                            );
                            return <GlbModel url={companionUrl} scale={companionScale} fallback={companionFallback} />;
                        })()}

                        {isStation && (() => {
                            // Cycle through real NASA station models by model_variant
                            const stationUrl = STATION_MODELS[(ent.model_variant || 0) % STATION_MODELS.length];
                            // Station rendered at 30% of collision radius (satellite models are small vs gameplay radius)
                            const stationScale = Math.max((ent.radius || 400) * 0.25, 60);
                            const stationFallback = (
                                <group>
                                    <mesh rotation={[Math.PI / 2, 0, 0]}>
                                        <torusGeometry args={[ent.radius || 400, 40, 16, 100]} />
                                        <meshStandardMaterial color="#cbd5e1" metalness={0.8} roughness={0.2} wireframe={false} />
                                    </mesh>
                                    <mesh>
                                        <sphereGeometry args={[(ent.radius || 400) * 0.3, 32, 32]} />
                                        <meshStandardMaterial color="#94a3b8" emissive="#38bdf8" emissiveIntensity={2} wireframe={false} />
                                    </mesh>
                                </group>
                            );
                            return (
                                <group>
                                    <GlbModel url={stationUrl} scale={stationScale} fallback={stationFallback} />
                                </group>
                            );
                        })()}

                        {isAlien && (() => {
                            const r = ent.radius || 60;
                            return (
                                <group rotation={[0, -(ent.rotation || 0) + Math.PI / 2, 0]}>
                                    <GlbModel
                                        url={MODEL_BASE + 'ships/shuttle.glb'}
                                        scale={r}
                                        rotation={GLB_ROTATIONS[MODEL_BASE + 'ships/shuttle.glb']}
                                        fallback={<AlienRavager radius={r} />}
                                    />
                                </group>
                            );
                        })()}

                        {isAnomaly && (() => {
                            // Cap visual radius so geometry stays manageable regardless of physics radius.
                            // Physics radius (used by Rust for event horizon) can be huge; visual stays ≤500.
                            const physRadius = ent.radius || 50;
                            const r = Math.min(physRadius, 500);
                            return (
                                <Singularity
                                    radius={r}
                                    isDestructive={ent.is_destructive || ent.destructive_potential > 0.8 || ent.anomaly_type === 'black_hole'}
                                />
                            );
                        })()}


                        {/* Explosion — self-animating via local timer, no stale spawn_age */}
                        {isExplosion && <AnimatedExplosion />}

                        {/* Enemy Health Bar — reads health from live ref in useFrame, no re-render needed */}
                        {(isEnemy || isAlien) && ent.health_max != null && ent.health_max > 0 && (
                            <EnemyHealthBar entityId={id} entitiesRef={entitiesRef} radius={ent.radius || 25} />
                        )}

                        {/* HUNTER'S EYE BRACKET */}
                        {isTargeted && (
                            <group>
                                {/* Fix 4: Sleek 3D Targeting Bracket */}
                                <mesh rotation={[Math.PI / 2, 0, 0]}>
                                    <ringGeometry args={[(ent.radius || 25) * 1.5, (ent.radius || 25) * 1.6, 32]} />
                                    <meshBasicMaterial color="#ef4444" transparent opacity={0.6} side={THREE.DoubleSide} depthTest={false} />
                                </mesh>
                                {/* Corner Accents for premium feel */}
                                {[0, 1, 2, 3].map((i) => (
                                    <group key={i} rotation={[0, 0, (i * Math.PI) / 2]}>
                                        <mesh position={[(ent.radius || 25) * 1.55, 0, 0]}>
                                            <boxGeometry args={[(ent.radius || 25) * 0.2, (ent.radius || 25) * 0.05, (ent.radius || 25) * 0.05]} />
                                            <meshBasicMaterial color="#ef4444" depthTest={false} />
                                        </mesh>
                                    </group>
                                ))}
                                <mesh>
                                    <sphereGeometry args={[2, 8, 8]} />
                                    <meshBasicMaterial color="#ef4444" depthTest={false} />
                                </mesh>
                            </group>
                        )}
                    </group>
                );
            })}
            {/* Instanced asteroids: real Bennu GLB geometry, falls back to procedural */}
            <GlbErrorBoundary fallback={<InstancedAsteroids entitiesRef={asteroidsRef} />}>
                <Suspense fallback={<InstancedAsteroids entitiesRef={asteroidsRef} />}>
                    <InstancedAsteroidsGlbInner entitiesRef={asteroidsRef} />
                </Suspense>
            </GlbErrorBoundary>
        </Suspense>
    );
};
