import React, { Suspense } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';

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

interface PlanetMeshProps {
    name: string;
    radius: number;
    fallbackColor: string;
    isSun?: boolean;
}

const PlanetMesh: React.FC<PlanetMeshProps> = ({ name, radius, fallbackColor, isSun }) => {
    const textureFile = TEXTURE_MAP[name];
    const texture = textureFile ? useTexture(`${ASSET_BASE_URL}${textureFile}`) : null;

    if (isSun) {
        return (
            <mesh>
                <sphereGeometry args={[radius, 64, 64]} />
                {texture ? (
                    <meshBasicMaterial map={texture} />
                ) : (
                    <meshStandardMaterial
                        emissive="#ff8c00"
                        emissiveIntensity={4}
                        color="#ffd700"
                        roughness={0.0}
                        metalness={1.0}
                        toneMapped={false}
                    />
                )}
            </mesh>
        );
    }

    return (
        <mesh>
            <sphereGeometry args={[radius, 32, 32]} />
            {texture ? (
                <meshStandardMaterial map={texture} roughness={0.7} metalness={0.2} />
            ) : (
                <meshStandardMaterial
                    color={fallbackColor}
                    roughness={0.4}
                    metalness={0.3}
                />
            )}
        </mesh>
    );
};

interface EntityRendererProps {
    entities: Record<string, any>;
    newbornIds: Set<number>;
    dyingIds: Set<number>;
    realityOverride?: any;
}

export const EntityRenderer: React.FC<EntityRendererProps> = ({ entities, newbornIds, dyingIds, realityOverride }) => {
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
                const scale = isNew ? 1.5 : isDying ? 0.1 : 1.0;

                const isSun = ent.ent_type === 'sun';
                const isPlanet = ent.ent_type === 'planet';
                const isStar = ent.ent_type === 'star';
                const isAnomaly = ent.ent_type === 'anomaly';
                const isProjectile = ent.ent_type === 'projectile';
                const isAsteroid = ent.ent_type === 'asteroid';
                const isEnemy = ent.ent_type === 'enemy';
                const isCompanion = ent.ent_type === 'companion';
                const isExplosion = ent.ent_type === 'explosion';

                const isTargeted = id === playerTargetId;

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

                // Coordinate rule: Rust(x, y, z) → Three.js(x, z, y)
                return (
                    <group key={id} position={[ent.x, ent.z || 0, ent.y]} scale={[scale, scale, scale]}>
                        {isSun && (
                            <group>
                                <PlanetMesh
                                    name="Sun"
                                    radius={ent.radius || 300}
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
                                        <meshStandardMaterial color="#fcd34d" transparent opacity={0.6} />
                                    </mesh>
                                )}

                                {/* RENDER MOONS HIERARCHICALLY (Requirement 1 & 2) */}
                                {childrenByParent[ent.id]?.map((moon: any) => (
                                    <group key={moon.id} position={[moon.x, moon.z || 0, moon.y]}>
                                        <PlanetMesh
                                            name={moon.name || "Moon"}
                                            radius={moon.radius || 5}
                                            fallbackColor={moon.custom_color || '#a8a8a8'}
                                        />
                                    </group>
                                ))}
                            </group>
                        )}

                        {isStar && (
                            <mesh rotation={[0, 0, ent.rotation || 0]}>
                                <boxGeometry args={[0.5, 0.1, 0.1]} />
                                <meshBasicMaterial color="#38bdf8" />
                            </mesh>
                        )}

                        {isAsteroid && (
                            <mesh>
                                <dodecahedronGeometry args={[ent.radius || 50, 0]} />
                                <meshStandardMaterial color="#52525b" roughness={0.9} />
                            </mesh>
                        )}

                        {isProjectile && (
                            <mesh>
                                <sphereGeometry args={[4, 16, 16]} />
                                <meshStandardMaterial
                                    color={ent.custom_color || "#ef4444"}
                                    emissive={ent.custom_color || "#ef4444"}
                                    emissiveIntensity={3}
                                />
                            </mesh>
                        )}

                        {isEnemy && (
                            <mesh>
                                {ent.faction === 'federation' ? (
                                    <>
                                        <octahedronGeometry args={[ent.radius || 18, 0]} />
                                        <meshStandardMaterial color="#0ea5e9" emissive="#0ea5e9" emissiveIntensity={2} roughness={0.3} />
                                    </>
                                ) : (
                                    <>
                                        <tetrahedronGeometry args={[ent.radius || 18, 0]} />
                                        <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={1} roughness={0.5} />
                                    </>
                                )}
                            </mesh>
                        )}

                        {isCompanion && (
                            <mesh>
                                {ent.faction === 'federation' ? (
                                    <>
                                        <octahedronGeometry args={[ent.radius || 14, 0]} />
                                        <meshStandardMaterial color="#0ea5e9" emissive="#22d3ee" emissiveIntensity={1.5} roughness={0.3} />
                                    </>
                                ) : (
                                    <>
                                        <boxGeometry args={[ent.radius || 14, ent.radius || 14, ent.radius || 14]} />
                                        <meshStandardMaterial color="#22c55e" roughness={0.5} />
                                    </>
                                )}
                            </mesh>
                        )}

                        {isAnomaly && (
                            <group>
                                <mesh>
                                    <sphereGeometry args={[ent.radius || 50, 32, 32]} />
                                    <meshBasicMaterial color="#000000" />
                                </mesh>
                                <mesh>
                                    <sphereGeometry args={[(ent.radius || 50) * 1.1, 32, 32]} />
                                    <meshBasicMaterial color="#a855f7" wireframe={true} transparent opacity={0.4} />
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
                                />
                            </mesh>
                        )}

                        {/* HUNTER'S EYE BRACKET */}
                        {isTargeted && (
                            <group>
                                <mesh>
                                    <boxGeometry args={[(ent.radius || 25) * 2.5, (ent.radius || 25) * 2.5, (ent.radius || 25) * 2.5]} />
                                    <meshBasicMaterial color="#ef4444" wireframe={true} transparent opacity={0.6} depthTest={false} />
                                </mesh>
                                {/* Add a simple dot in the center just for flair */}
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
