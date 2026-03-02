import React, { useRef } from 'react';
import { PerspectiveCamera, Environment } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PlayerShip } from './PlayerShip';
import { Starfield } from './Starfield';
import { EntityRenderer } from './EntityRenderer';
import { ParticleSystem } from './ParticleSystem';

// ── Laser Aim Beam ─────────────────────────────────────────────────────────
// Renders a thin glowing cylinder from the ship nose in the aim direction.
// Stops at the nearest asteroid/enemy intersection.
const _upVec = new THREE.Vector3(0, 1, 0);

const LaserBeam: React.FC<{
    shipPos: THREE.Vector3;
    yawRef: React.MutableRefObject<number>;
    pitchRef: React.MutableRefObject<number>;
    entities: Record<string, any>;
}> = ({ shipPos, yawRef, pitchRef, entities }) => {
    const meshRef = useRef<THREE.Mesh>(null);
    const glowRef = useRef<THREE.Mesh>(null);

    useFrame(() => {
        if (!meshRef.current || !glowRef.current) return;

        const yaw = yawRef.current;
        const pitch = pitchRef.current;

        const dirX = Math.cos(yaw) * Math.cos(pitch);
        const dirY = Math.sin(pitch);
        const dirZ = Math.sin(yaw) * Math.cos(pitch);
        const dir = new THREE.Vector3(dirX, dirY, dirZ);

        // Raycast against asteroids and enemies
        let hitDist = 4000;
        for (const ent of Object.values(entities)) {
            if (ent.ent_type !== 'asteroid' && ent.ent_type !== 'enemy' && ent.ent_type !== 'sun' && ent.ent_type !== 'planet') continue;
            const ep = new THREE.Vector3(ent.x, ent.y, ent.z);
            const toEnt = ep.clone().sub(shipPos);
            const proj = toEnt.dot(dir);
            if (proj < 0 || proj > hitDist) continue;
            const perp = toEnt.clone().sub(dir.clone().multiplyScalar(proj)).length();
            const r = (ent.radius || 50) * (ent.scale || 1);
            if (perp < r) hitDist = proj;
        }

        const halfLen = hitDist / 2;
        const midX = shipPos.x + dirX * halfLen;
        const midY = shipPos.y + dirY * halfLen;
        const midZ = shipPos.z + dirZ * halfLen;

        // Orient cylinder along direction (cylinders default to Y-up)
        const q = new THREE.Quaternion().setFromUnitVectors(_upVec, dir);

        meshRef.current.position.set(midX, midY, midZ);
        meshRef.current.quaternion.copy(q);
        meshRef.current.scale.set(1, hitDist, 1);

        glowRef.current.position.set(midX, midY, midZ);
        glowRef.current.quaternion.copy(q);
        glowRef.current.scale.set(1, hitDist, 1);
    });

    return (
        <group>
            {/* Core beam */}
            <mesh ref={meshRef}>
                <cylinderGeometry args={[0.6, 0.6, 1, 6]} />
                <meshBasicMaterial color="#ff2222" transparent opacity={0.85} toneMapped={false} />
            </mesh>
            {/* Soft outer glow */}
            <mesh ref={glowRef}>
                <cylinderGeometry args={[2.5, 2.5, 1, 6]} />
                <meshBasicMaterial color="#ff0000" transparent opacity={0.08} toneMapped={false} />
            </mesh>
        </group>
    );
};


// ── HitMarker dot at beam end ──────────────────────────────────────────────
const HitDot: React.FC<{
    shipPos: THREE.Vector3;
    yawRef: React.MutableRefObject<number>;
    pitchRef: React.MutableRefObject<number>;
    entities: Record<string, any>;
}> = ({ shipPos, yawRef, pitchRef, entities }) => {
    const ref = useRef<THREE.Mesh>(null);

    useFrame(() => {
        if (!ref.current) return;

        const yaw = yawRef.current;
        const pitch = pitchRef.current;

        const dirX = Math.cos(yaw) * Math.cos(pitch);
        const dirY = Math.sin(pitch);
        const dirZ = Math.sin(yaw) * Math.cos(pitch);
        const dir = new THREE.Vector3(dirX, dirY, dirZ);

        let hitDist = 4000;
        let hit = false;
        for (const ent of Object.values(entities)) {
            if (ent.ent_type !== 'asteroid' && ent.ent_type !== 'enemy' && ent.ent_type !== 'sun' && ent.ent_type !== 'planet') continue;
            const ep = new THREE.Vector3(ent.x, ent.y, ent.z);
            const toEnt = ep.clone().sub(shipPos);
            const proj = toEnt.dot(dir);
            if (proj < 0 || proj > hitDist) continue;
            const perp = toEnt.clone().sub(dir.clone().multiplyScalar(proj)).length();
            const r = (ent.radius || 50) * (ent.scale || 1);
            if (perp < r) { hitDist = proj; hit = true; }
        }

        const ex = shipPos.x + dirX * hitDist;
        const ey = shipPos.y + dirY * hitDist;
        const ez = shipPos.z + dirZ * hitDist;
        ref.current.position.set(ex, ey, ez);
        ref.current.visible = hit;
    });

    return (
        <mesh ref={ref}>
            <sphereGeometry args={[8, 8, 8]} />
            <meshBasicMaterial color="#ff4400" toneMapped={false} />
        </mesh>
    );
};

// ── World Boundary Shell ────────────────────────────────────────────────────
// Fresnel-shaded sphere marking the edge of the playable universe (radius 32 000 u).
// Rendered on BackSide so it glows inward when the player approaches.
const BOUNDARY_VERT = `
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mvPos.xyz);
  gl_Position = projectionMatrix * mvPos;
}
`;
const BOUNDARY_FRAG = `
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  float fresnel = pow(1.0 - abs(dot(vNormal, vViewDir)), 2.5);
  vec3 innerColor = vec3(0.04, 0.0, 0.22);
  vec3 edgeColor  = vec3(0.5, 0.2, 1.0);
  vec3 color = mix(innerColor, edgeColor, fresnel);
  gl_FragColor = vec4(color, fresnel * 0.55);
}
`;

const BoundaryShell: React.FC = () => (
    <mesh>
        <sphereGeometry args={[32000, 48, 48]} />
        <shaderMaterial
            side={THREE.BackSide}
            transparent
            depthWrite={false}
            vertexShader={BOUNDARY_VERT}
            fragmentShader={BOUNDARY_FRAG}
        />
    </mesh>
);

// ── Main Scene ─────────────────────────────────────────────────────────────
interface GameSceneProps {
    ecsEntities: Record<string, any>;
    particles: any[];
    zoom: number;
    newbornIds: Set<number>;
    dyingIds: Set<number>;
    realityOverride?: any;
    playerSpaceship?: string;
    camYawRef: React.MutableRefObject<number>;
    camPitchRef: React.MutableRefObject<number>;
    targetedEntityId?: number | null;
}

export const GameScene: React.FC<GameSceneProps> = ({
    ecsEntities, particles, zoom, newbornIds, dyingIds,
    realityOverride, playerSpaceship, camYawRef, camPitchRef, targetedEntityId
}) => {
    const cameraRef = useRef<THREE.PerspectiveCamera>(null);
    const smoothedPos = useRef(new THREE.Vector3(8500, 500, 0));
    const smoothedCamPos = useRef(new THREE.Vector3(8400, 600, -200));

    const player = Object.values(ecsEntities).find((e: any) => e.ent_type === 'player');
    const rx = player ? (player.x as number) : 8500;
    const ry = player ? (player.y as number) : 500;
    const rz = player ? (player.z as number) : 0;

    // Ship position updated in useFrame (mutated in-place so LaserBeam sees live position)
    const shipPosRef = useRef(new THREE.Vector3(8500, 500, 0));

    useFrame(() => {
        if (!cameraRef.current) return;

        smoothedPos.current.lerp(new THREE.Vector3(rx, ry, rz), 0.4);
        shipPosRef.current.copy(smoothedPos.current);

        const yaw = camYawRef.current;
        const pitch = camPitchRef.current;

        // FIXED CAMERA POSITION PHASE 9.3 (SHIP-RELATIVE CHASE)
        // Camera distance scales with zoom
        const baseDist = 300 + zoom * 100;

        // Relative offset from ship: Rear-view, slightly above
        const relOffset = new THREE.Vector3(0, 80, -baseDist);

        // Calculate ship-relative rotation (must match PlayerShip.tsx)
        const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw + Math.PI / 2);
        const pitchQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch);
        const rotationQ = yawQ.multiply(pitchQ);

        // Apply rotation to the offset
        const worldOffset = relOffset.applyQuaternion(rotationQ);

        // Apply the offset to the smoothed ship position
        const targetCam = smoothedPos.current.clone().add(worldOffset);

        // Smoothly interpolate camera position
        smoothedCamPos.current.lerp(targetCam, 0.15);
        cameraRef.current.position.copy(smoothedCamPos.current);

        // Look slightly above the ship so it's centered in the lower-middle of the screen
        const lookTarget = smoothedPos.current.clone().add(new THREE.Vector3(0, 30, 0).applyQuaternion(rotationQ));
        cameraRef.current.lookAt(lookTarget);
    });

    const shipPos: [number, number, number] = [
        smoothedPos.current.x,
        smoothedPos.current.y,
        smoothedPos.current.z,
    ];

    return (
        <>
            <PerspectiveCamera
                ref={cameraRef}
                makeDefault
                fov={70}
                near={0.1}
                far={1000000}
                position={[8400, 600, -200]}
            />

            <ambientLight intensity={0.4} color={realityOverride?.ambient_color || '#ffffff'} />
            <directionalLight position={[200, 100, 100]} intensity={1.5} />
            <pointLight
                position={[0, 0, 0]}
                intensity={80000}
                decay={1.2}
                color={realityOverride?.sun_color || '#fcd34d'}
            />

            <Environment preset="night" />
            <Starfield count={5000} position={shipPos} />
            <BoundaryShell />

            {player && (
                <>
                    <PlayerShip
                        position={[rx, ry, rz]}
                        rotationRef={camYawRef}
                        camPitchRef={camPitchRef}
                        shipType={player?.model_type || playerSpaceship}
                        shipColor={player?.custom_color}
                        isCloaked={player?.is_cloaked}
                    />
                    <LaserBeam
                        shipPos={shipPosRef.current}
                        yawRef={camYawRef}
                        pitchRef={camPitchRef}
                        entities={ecsEntities}
                    />
                    <HitDot
                        shipPos={shipPosRef.current}
                        yawRef={camYawRef}
                        pitchRef={camPitchRef}
                        entities={ecsEntities}
                    />
                </>
            )}

            <EntityRenderer
                entities={ecsEntities}
                newbornIds={newbornIds}
                dyingIds={dyingIds}
                realityOverride={realityOverride}
                targetedEntityId={targetedEntityId}
            />
            <ParticleSystem particles={particles} />
        </>
    );
};
