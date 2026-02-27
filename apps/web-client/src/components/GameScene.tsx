import React, { useRef, useMemo } from 'react';
import { PerspectiveCamera, Environment, OrbitControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PlayerShip } from './PlayerShip';
import { Starfield } from './Starfield';
import { EntityRenderer } from './EntityRenderer';
import { ParticleSystem } from './ParticleSystem';

interface GameSceneProps {
    ecsEntities: Record<string, any>;
    particles: any[];
    zoom: number;
    newbornIds: Set<number>;
    dyingIds: Set<number>;
    realityOverride?: any;
    playerSpaceship?: string;
}

export const GameScene: React.FC<GameSceneProps> = ({ ecsEntities, particles, zoom, newbornIds, dyingIds, realityOverride, playerSpaceship }) => {
    const cameraRef = useRef<THREE.PerspectiveCamera>(null);

    const player = Object.values(ecsEntities).find((e: any) => e.ent_type === 'player');

    // ── COORDINATE RULE ──────────────────────────────────────────────────────
    // Rust engine provides X, Y, Z.
    // Three.js has Y pointing UP, so we map:
    //     Rust(X, Y, Z) → Three.js(X, Z, Y)
    // ─────────────────────────────────────────────────────────────────────────
    const rx = player ? (player.x as number) : 0;   // Rust X
    const ry = player ? (player.y as number) : 0;   // Rust Y
    const rz = player ? (player.z as number) : 0;   // Rust Z
    const rawPlayerPos = useMemo(() => new THREE.Vector3(rx, rz, ry), [rx, ry, rz]);

    // We maintain a separate Vector3 for the visual, smoothed position
    const smoothedPos = useRef(new THREE.Vector3(rx, rz, ry));
    const controlsRef = useRef<any>(null);

    const playerRot = player ? (player.rotation as number) || 0 : 0;

    useFrame((state, delta) => {
        if (!player) return;

        // 1. SMOOTH MOVEMENT (Interpolation)
        // Lerp the smoothed position toward the raw network position
        smoothedPos.current.lerp(rawPlayerPos, 0.15);

        // 2. ORBIT-FOLLOW HYBRID
        // Constantly update the OrbitControls target to match the smoothed ship position
        if (controlsRef.current) {
            controlsRef.current.target.lerp(smoothedPos.current, 0.1);
            controlsRef.current.update();

            // 3. CAMERA SNAP-BACK (Requirement 4)
            // If user is not dragging mouse (state === -1), smoothly return camera to trailing position
            if (controlsRef.current.state === -1 && cameraRef.current) {
                // Trailing position: Behind and slightly above the ship.
                // Note: React Three Fiber swaps Y and Z for 3D orientation.
                const offset = new THREE.Vector3(-Math.cos(playerRot) * 300, 100, -Math.sin(playerRot) * 300);
                const idealCameraPos = smoothedPos.current.clone().add(offset);
                cameraRef.current.position.lerp(idealCameraPos, 0.05);
            }
        }
    });

    return (
        <>
            {/* 3D Camera with dynamic tracking */}
            <PerspectiveCamera
                ref={cameraRef}
                makeDefault
                fov={60}
                near={1}
                far={200000}
                position={[500, 400, 800]} // Initial offset
            />

            <OrbitControls
                ref={controlsRef}
                enablePan={true}
                enableZoom={true}
                enableRotate={true}
                maxDistance={1200}
                minDistance={200}
                makeDefault
            />

            {/* Heliocentric Lighting — Sun sits at world origin (0, 0, 0) */}
            {/* Heliocentric Lighting — Sun sits at world origin (0, 0, 0) */}
            <ambientLight intensity={0.2} color={realityOverride?.ambient_color || '#ffffff'} />
            <directionalLight position={[100, 50, 50]} intensity={1.5} />
            <pointLight
                position={[0, 0, 0]}
                intensity={80000}
                decay={1.2}
                color={realityOverride?.sun_color || '#fcd34d'}
            />

            <Environment preset="night" />
            <Starfield count={800} />

            <PlayerShip
                position={[smoothedPos.current.x, smoothedPos.current.y, smoothedPos.current.z]}
                rotation={playerRot}
                shipType={player?.model_type || playerSpaceship}
                shipColor={player?.custom_color}
            />

            <EntityRenderer
                entities={ecsEntities}
                newbornIds={newbornIds}
                dyingIds={dyingIds}
                realityOverride={realityOverride}
            />
            <ParticleSystem particles={particles} />
        </>
    );
};
