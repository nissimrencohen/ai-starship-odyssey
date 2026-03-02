import React, { Suspense } from 'react';
import * as THREE from 'three';
import { useTexture, Html } from '@react-three/drei';

const ASSET_BASE_URL = 'http://127.0.0.1:8000/assets/';

const TEXTURE_MAP: Record<string, string> = {
    "Earth": "2k_earth_daymap.jpg",
    "Mars": "2k_mars.jpg",
    "Jupiter": "2k_jupiter.jpg",
    "Venus": "2k_venus_surface.jpg",
    "Mercury": "2k_mercury.jpg",
    "Saturn": "2k_saturn.jpg",
    "Uranus": "2k_uranus.jpg",
    "Neptune": "2k_neptune.jpg",
    "Sun": "2k_sun.jpg",
    "Moon": "2k_moon.jpg",
    "Phobos": "2k_moon.jpg",
    "Deimos": "2k_moon.jpg",
};

// removed: getVisualPos (logarithmic scaling removed for 1:1 sync)

interface PlanetMeshProps {
    name: string;
    radius: number;
    fallbackColor: string;
    isSun?: boolean;
}

// Plain (no-texture) fallback — always safe to render
const PlanetMeshPlain: React.FC<{ radius: number; fallbackColor: string; isSun: boolean }> = ({ radius, fallbackColor, isSun }) => {
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
            <meshStandardMaterial color={fallbackColor} roughness={0.4} metalness={0.3} wireframe={false} />
        </mesh>
    );
};

// Inner textured component — calls useTexture (may throw/suspend)
const PlanetMeshTextured: React.FC<{ textureUrl: string; radius: number; fallbackColor: string; isSun: boolean }> = ({ textureUrl, radius, fallbackColor, isSun }) => {
    const texture = useTexture(textureUrl);
    if (isSun) {
        return (
            <mesh>
                <sphereGeometry args={[radius, 64, 64]} />
                <meshBasicMaterial map={texture} wireframe={false} />
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
    const plain = <PlanetMeshPlain radius={radius} fallbackColor={fallbackColor} isSun={!!isSun} />;
    if (!textureFile) return plain;
    return (
        <TextureErrorBoundary fallback={plain}>
            <Suspense fallback={plain}>
                <PlanetMeshTextured textureUrl={`${ASSET_BASE_URL}${textureFile}`} radius={radius} fallbackColor={fallbackColor} isSun={!!isSun} />
            </Suspense>
        </TextureErrorBoundary>
    );
};

const AlienSwarmer: React.FC<{ radius: number; isTargeted: boolean }> = ({ radius, isTargeted }) => {
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
            <pointLight position={[0, 0, radius * 0.5]} color="#ef4444" intensity={100} distance={radius * 5} />
        </group>
    );
};

const AlienRavager: React.FC<{ radius: number; isTargeted: boolean }> = ({ radius, isTargeted }) => {
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
            <pointLight color="#10b981" intensity={300} distance={radius * 8} />
        </group>
    );
};

const AlienMothership: React.FC<{ radius: number; isTargeted: boolean }> = ({ radius, isTargeted }) => {
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
            {/* Giant Central Light */}
            <pointLight color="#a855f7" intensity={1000} distance={radius * 20} />
            <mesh position={[0, 0, radius * 0.8]}>
                <sphereGeometry args={[radius * 0.3, 32, 32]} />
                <meshBasicMaterial color="#a855f7" />
            </mesh>
        </group>
    );
};
interface EntityRendererProps {
    entities: Record<string, any>;
    newbornIds: Set<number>;
    dyingIds: Set<number>;
    realityOverride?: any;
    targetedEntityId?: number | null;
}

export const EntityRenderer: React.FC<EntityRendererProps> = ({ entities, newbornIds, dyingIds, realityOverride, targetedEntityId }) => {
    // 1. Organize Hierarchy
    const parents = Object.values(entities).filter(e => !e.parent_id && e.ent_type !== 'player');
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
                const isEnemy = ent.ent_type === 'enemy';
                const isCompanion = ent.ent_type === 'companion';
                const isExplosion = ent.ent_type === 'explosion';

                const isTargeted = id === playerTargetId || id === targetedEntityId;

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
                        default: return '#71717a';
                    }
                };

                // Planet radii matched to planet_configs sizes in Rust (Phase 6.3 Rescale)
                const getPlanetRadius = (name: string) => {
                    switch (name) {
                        case 'Mercury': return 40;
                        case 'Venus': return 85;
                        case 'Earth': return 100;
                        case 'Mars': return 60;
                        case 'Jupiter': return 250;
                        case 'Saturn': return 210;
                        case 'Uranus': return 140;
                        case 'Neptune': return 130;
                        default: return 50;
                    }
                };

                const visualPos = (isSun ? [0, 0, 0] : [ent.x, ent.y, ent.z || 0]) as [number, number, number];
                const finalRadius = isSun ? 1000 : getPlanetRadius(ent.name);


                const finalScale = (ent.scale || 1.0) * lifeScale;

                // Coordinate rule: Rust(x, y, z) → Three.js(x, y, z)
                return (
                    <group key={id} position={visualPos} scale={[finalScale, finalScale, finalScale]}>
                        {isSun && (
                            <group>
                                <PlanetMesh
                                    name="Sun"
                                    radius={finalRadius}
                                    fallbackColor="#ffd700"
                                    isSun
                                />
                                {/* Sun self-illuminates everything within range */}
                                <pointLight color={realityOverride?.sun_color || '#fcd34d'} intensity={1000} distance={300000} decay={0.1} />
                            </group>
                        )}

                        {isPlanet && (
                            <group>
                                <PlanetMesh
                                    name={ent.name}
                                    radius={getPlanetRadius(ent.name)}
                                    fallbackColor={getPlanetColor(ent.name)}
                                />
                                {ent.name === 'Saturn' && (
                                    <mesh rotation={[Math.PI / 2.5, 0, 0]}>
                                        <torusGeometry args={[getPlanetRadius(ent.name) * 1.8, 5, 2, 100]} />
                                        <meshStandardMaterial color="#fcd34d" transparent opacity={0.6} wireframe={false} />
                                    </mesh>
                                )}

                                {/* RENDER MOONS HIERARCHICALLY (Requirement 1 & 2) */}
                                {childrenByParent[ent.id]?.map((moon: any) => {
                                    const mVisualPos = [moon.x, moon.y, moon.z || 0] as [number, number, number];
                                    return (
                                        <group key={moon.id} position={mVisualPos}>
                                            <PlanetMesh
                                                name={moon.name || "Moon"}
                                                radius={moon.radius || 5}
                                                fallbackColor={moon.custom_color || '#a8a8a8'}
                                            />
                                        </group>
                                    );
                                })}
                            </group>
                        )}

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
                            <group>
                                <mesh>
                                    <sphereGeometry args={[ent.projectile_size || 8, 12, 12]} />
                                    <meshBasicMaterial
                                        color={ent.custom_color || "#ef4444"}
                                        toneMapped={false}
                                    />
                                </mesh>
                                <pointLight
                                    color={ent.custom_color || "#ef4444"}
                                    intensity={200}
                                    distance={400}
                                />
                            </group>
                        )}

                        {isEnemy && (
                            <group rotation={[0, ent.rotation || 0, 0]}>
                                {ent.model_variant === 2 ? (
                                    <AlienMothership radius={ent.radius || 100} isTargeted={isTargeted} />
                                ) : ent.model_variant === 1 ? (
                                    <AlienRavager radius={ent.radius || 40} isTargeted={isTargeted} />
                                ) : (
                                    <AlienSwarmer radius={ent.radius || 18} isTargeted={isTargeted} />
                                )}
                            </group>
                        )}

                        {isCompanion && (
                            <mesh>
                                {ent.faction === 'federation' ? (
                                    <>
                                        <octahedronGeometry args={[ent.radius || 14, 0]} />
                                        <meshStandardMaterial color="#0ea5e9" emissive="#22d3ee" emissiveIntensity={1.5} roughness={0.3} wireframe={false} />
                                    </>
                                ) : (
                                    <>
                                        <boxGeometry args={[ent.radius || 14, ent.radius || 14, ent.radius || 14]} />
                                        <meshStandardMaterial color="#22c55e" roughness={0.5} wireframe={false} />
                                    </>
                                )}
                            </mesh>
                        )}

                        {isStation && (
                            <group>
                                <mesh rotation={[Math.PI / 2, 0, 0]}>
                                    <torusGeometry args={[ent.radius || 400, 40, 16, 100]} />
                                    <meshStandardMaterial color="#cbd5e1" metalness={0.8} roughness={0.2} wireframe={false} />
                                </mesh>
                                <mesh>
                                    <sphereGeometry args={[(ent.radius || 400) * 0.3, 32, 32]} />
                                    <meshStandardMaterial color="#94a3b8" emissive="#38bdf8" emissiveIntensity={2} wireframe={false} />
                                </mesh>
                                <pointLight color="#38bdf8" intensity={500} distance={2000} />
                            </group>
                        )}

                        {isAlien && (
                            <group rotation={[0, ent.rotation || 0, 0]}>
                                <AlienRavager radius={ent.radius || 60} isTargeted={isTargeted} />
                            </group>
                        )}

                        {isAnomaly && (
                            <group>
                                <mesh>
                                    <sphereGeometry args={[ent.radius || 50, 32, 32]} />
                                    <meshBasicMaterial color="#000000" wireframe={false} />
                                </mesh>
                                <mesh>
                                    <sphereGeometry args={[(ent.radius || 50) * 1.1, 32, 32]} />
                                    <meshBasicMaterial color="#a855f7" wireframe={false} transparent opacity={0.4} />
                                </mesh>
                            </group>
                        )}

                        {isExplosion && (
                            <mesh>
                                <sphereGeometry args={[(ent.spawn_age || 0) * 400, 32, 32]} />
                                <meshStandardMaterial
                                    color="#f59e0b"
                                    emissive="#f59e0b"
                                    emissiveIntensity={10 * (1 - (ent.spawn_age || 0) / 0.5)}
                                    transparent
                                    opacity={1 - (ent.spawn_age || 0) / 0.5}
                                    wireframe={false}
                                />
                            </mesh>
                        )}

                        {/* Enemy Health Bar (shown within 2 000 u of player) */}
                        {(isEnemy || isAlien) && ent.health_max != null && ent.health_max > 0 && (() => {
                            const pDist = playerEnt
                                ? Math.sqrt((ent.x - playerEnt.x) ** 2 + ((ent.z || 0) - (playerEnt.z || 0)) ** 2)
                                : Infinity;
                            if (pDist > 2000) return null;
                            const hpRatio = Math.max(0, Math.min(1, (ent.health_current ?? 0) / ent.health_max));
                            const barColor = hpRatio > 0.6 ? '#22c55e' : hpRatio > 0.3 ? '#eab308' : '#ef4444';
                            const entR = ent.radius || 25;
                            return (
                                <Html position={[0, entR * 3.2, 0]} center distanceFactor={80} zIndexRange={[10, 20]}>
                                    <div style={{ width: '52px', height: '5px', background: '#0a0a1e', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '2px', overflow: 'hidden' }}>
                                        <div style={{ height: '100%', width: `${hpRatio * 100}%`, background: barColor, transition: 'width 0.15s linear' }} />
                                    </div>
                                </Html>
                            );
                        })()}

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
        </Suspense>
    );
};
