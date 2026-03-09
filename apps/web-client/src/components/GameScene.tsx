import React, { useRef } from 'react';
import { PerspectiveCamera, Environment } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PlayerShip } from './PlayerShip';
import { Starfield } from './Starfield';
import { EntityRenderer, VisualConfig } from './EntityRenderer';
import { ParticleSystem } from './ParticleSystem';
import { CameraSystem } from '../three/CameraSystem';

// ── Laser Aim Beam ─────────────────────────────────────────────────────────
// Renders a thin glowing cylinder from the ship nose in the aim direction.
// Stops at the nearest asteroid/enemy intersection.
const _upVec = new THREE.Vector3(0, 1, 0);

const LaserBeam: React.FC<{
    shipPos: THREE.Vector3;
    laserOriginRef?: React.MutableRefObject<THREE.Group | null>;
    yawRef: React.MutableRefObject<number>;
    pitchRef: React.MutableRefObject<number>;
    entities: Record<string, any>;
    color?: string;
    isFiring?: boolean;
}> = ({ shipPos, laserOriginRef, yawRef, pitchRef, entities, color, isFiring }) => {
    const meshRef = useRef<THREE.Mesh>(null);
    const glowRef = useRef<THREE.Mesh>(null);
    const frameCounterRef = useRef(0);
    const cachedHitDistRef = useRef(4000);
    useFrame((_, delta) => {
        if (!meshRef.current || !glowRef.current) return;

        // Force visibility always ON for targeting laser
        meshRef.current.visible = true;
        glowRef.current.visible = true;

        // Determine actual start pos
        const startPos = new THREE.Vector3();
        if (laserOriginRef && laserOriginRef.current) {
            laserOriginRef.current.getWorldPosition(startPos);
        } else {
            startPos.copy(shipPos);
        }

        const yaw = yawRef.current;
        const pitch = pitchRef.current;

        const dirX = Math.cos(yaw) * Math.cos(pitch);
        const dirY = Math.sin(pitch);
        const dirZ = Math.sin(yaw) * Math.cos(pitch);
        const dir = new THREE.Vector3(dirX, dirY, dirZ);

        // Target detection: throttle to every 4 frames for performance
        frameCounterRef.current++;
        if (frameCounterRef.current % 4 === 0) {
            let hitDist = 4000;
            const ents = Object.values(entities);
            for (let i = 0; i < ents.length; i++) {
                const ent = ents[i];
                if (ent.ent_type !== 'asteroid' && ent.ent_type !== 'enemy' && ent.ent_type !== 'sun' && ent.ent_type !== 'planet' && ent.ent_type !== 'station') continue;

                // Fast distance culling: only check if within 4000u box
                const dx = ent.x - startPos.x;
                const dz = (ent.z || 0) - startPos.z;
                if (Math.abs(dx) > 4000 || Math.abs(dz) > 4000) continue;

                const ep = new THREE.Vector3(ent.x, ent.y, ent.z);
                const toEnt = ep.sub(startPos);
                const proj = toEnt.dot(dir);
                if (proj < 0 || proj > hitDist) continue;
                const perp = toEnt.clone().sub(dir.clone().multiplyScalar(proj)).length();
                const r = (ent.radius || 50) * (ent.scale || 1);
                if (perp < r) hitDist = proj;
            }
            cachedHitDistRef.current = hitDist;
        }

        const hitDist = cachedHitDistRef.current;

        const halfLen = hitDist / 2;
        const midX = startPos.x + dirX * halfLen;
        const midY = startPos.y + dirY * halfLen;
        const midZ = startPos.z + dirZ * halfLen;

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
            {/* Core beam - Thicker and using BasicMaterial so it ignores lighting and is always visible */}
            <mesh ref={meshRef}>
                <cylinderGeometry args={[2.0, 2.0, 1, 8]} />
                <meshBasicMaterial color={color || "#ff2222"} transparent opacity={0.6} depthWrite={false} />
            </mesh>
            {/* Soft outer glow */}
            <mesh ref={glowRef}>
                <cylinderGeometry args={[6.0, 6.0, 1, 8]} />
                <meshBasicMaterial color={color || "#ff0000"} transparent opacity={0.15} depthWrite={false} blending={THREE.AdditiveBlending} />
            </mesh>
        </group>
    );
};


// ── HitMarker dot at beam end ──────────────────────────────────────────────
const HitDot: React.FC<{
    shipPos: THREE.Vector3;
    laserOriginRef?: React.MutableRefObject<THREE.Group | null>;
    yawRef: React.MutableRefObject<number>;
    pitchRef: React.MutableRefObject<number>;
    entities: Record<string, any>;
}> = ({ shipPos, laserOriginRef, yawRef, pitchRef, entities }) => {
    const ref = useRef<THREE.Mesh>(null);

    useFrame(() => {
        if (!ref.current) return;

        // Determine actual start pos
        const startPos = new THREE.Vector3();
        if (laserOriginRef && laserOriginRef.current) {
            laserOriginRef.current.getWorldPosition(startPos);
        } else {
            startPos.copy(shipPos);
        }

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
            const toEnt = ep.clone().sub(startPos);
            const proj = toEnt.dot(dir);
            if (proj < 0 || proj > hitDist) continue;
            const perp = toEnt.clone().sub(dir.clone().multiplyScalar(proj)).length();
            const r = (ent.radius || 50) * (ent.scale || 1);
            if (perp < r) { hitDist = proj; hit = true; }
        }

        const ex = startPos.x + dirX * hitDist;
        const ey = startPos.y + dirY * hitDist;
        const ez = startPos.z + dirZ * hitDist;
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
// Fresnel-shaded sphere marking the edge of the playable universe (radius 64 000 u).
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

// ── World Boundary Shell ─────────────────────────────────────────────────────
// Gateway Core is now a named ECS space_station entity (ModelVariant 5 → gateway.glb)
// rendered by EntityRenderer and visible on the mini-radar. No hardcoded decoration needed.
const BoundaryShell: React.FC = () => (
    <mesh>
        <sphereGeometry args={[64000, 48, 48]} />
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
    ecsEntitiesRef: React.MutableRefObject<Record<string, any>>;
    particles: any[];
    zoom: number;
    newbornIds: Set<number>;
    dyingIds: Set<number>;
    realityOverride?: any;
    playerSpaceship?: string;
    camYawRef: React.MutableRefObject<number>;
    camPitchRef: React.MutableRefObject<number>;
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

export const GameScene: React.FC<GameSceneProps> = ({
    ecsEntities, ecsEntitiesRef, particles, zoom, newbornIds, dyingIds,
    realityOverride, playerSpaceship, camYawRef, camPitchRef, targetedEntityId, visualConfig, spectatorTargetId,
    globalOverride, customTextureUrl
}) => {
    const cameraRef = useRef<THREE.PerspectiveCamera>(null);
    const smoothedPos = useRef(new THREE.Vector3(8500, 500, 0));
    const smoothedCamPos = useRef(new THREE.Vector3(8400, 600, -200));

    // Raw target from server — updated in useFrame from the live ref (not during React render)
    const targetPosRef = useRef(new THREE.Vector3(8500, 500, 0));

    // Ship position updated in useFrame (mutated in-place so LaserBeam sees live position)
    const shipPosRef = useRef(new THREE.Vector3(8500, 500, 0));

    // Refs for groups whose position is driven entirely in useFrame (no React prop jitter)
    const shipGroupRef = useRef<THREE.Group>(null);
    const starfieldGroupRef = useRef<THREE.Group>(null);
    const laserOriginRef = useRef<THREE.Group>(null);

    useFrame((state, delta) => {
        // Update player ship position ref with smoothing
        const truePlayerEnt = Object.values(ecsEntitiesRef.current).find((e: any) => e.ent_type === 'player') as any;
        const posAlpha = 1 - Math.pow(0.6, delta * 60);

        if (truePlayerEnt) {
            const pTarget = new THREE.Vector3(truePlayerEnt.x, truePlayerEnt.y || 0, truePlayerEnt.z || 0);
            shipPosRef.current.lerp(pTarget, posAlpha);
        }

        // Drive ship group position from the player ref
        if (shipGroupRef.current) {
            shipGroupRef.current.position.copy(shipPosRef.current);
        }

        // Starfield follows camera
        if (starfieldGroupRef.current) {
            starfieldGroupRef.current.position.copy(state.camera.position);
        }
    });

    const player = Object.values(ecsEntities).find((e: any) => e.ent_type === 'player') as any;

    return (
        <>
            <CameraSystem
                spectatorTargetId={spectatorTargetId ?? null}
                ecsEntitiesRef={ecsEntitiesRef}
                camYawRef={camYawRef}
                camPitchRef={camPitchRef}
                zoom={zoom}
            />
            <PerspectiveCamera
                makeDefault
                fov={70}
                near={0.1}
                far={1000000}
                position={[8400, 600, -200]}
            />

            <ambientLight
                intensity={globalOverride?.ambient_intensity !== undefined ? globalOverride.ambient_intensity : 0.4}
                color={globalOverride?.ambient_color || realityOverride?.ambient_color || '#ffffff'}
            />
            <directionalLight position={[200, 100, 100]} intensity={globalOverride?.sun_visible === false ? 0 : 1.5} />
            <pointLight
                position={[0, 0, 0]}
                intensity={globalOverride?.sun_visible === false ? 0 : 80000}
                decay={1.2}
                color={realityOverride?.sun_color || '#fcd34d'}
            />

            <Environment preset="night" />
            {/* Starfield: group position driven by useFrame → no React-state jitter */}
            {globalOverride?.sun_visible !== false && (
                <group ref={starfieldGroupRef}>
                    <Starfield count={5000} position={[0, 0, 0]} />
                </group>
            )}
            {globalOverride?.skybox_color && <color attach="background" args={[globalOverride.skybox_color]} />}
            <BoundaryShell />

            {player && (
                <>
                    {/* Ship group position driven by smoothedPos ref in useFrame — never jumps on React re-render */}
                    <group ref={shipGroupRef}>
                        <PlayerShip
                            position={[0, 0, 0]}
                            rotationRef={camYawRef}
                            camPitchRef={camPitchRef}
                            shipType={player?.model_type || playerSpaceship}
                            shipColor={player?.custom_color}
                            isCloaked={player?.is_cloaked}
                            laserOriginRef={laserOriginRef}
                            playerEnt={player}
                        />
                    </group>
                    <LaserBeam
                        shipPos={shipPosRef.current}
                        laserOriginRef={laserOriginRef}
                        yawRef={camYawRef}
                        pitchRef={camPitchRef}
                        entities={ecsEntities}
                        color={player?.custom_color}
                        isFiring={player?.is_firing}
                    />
                    <HitDot
                        shipPos={shipPosRef.current}
                        laserOriginRef={laserOriginRef}
                        yawRef={camYawRef}
                        pitchRef={camPitchRef}
                        entities={ecsEntities}
                    />
                </>
            )}

            <EntityRenderer
                entities={ecsEntities}
                entitiesRef={ecsEntitiesRef}
                newbornIds={newbornIds}
                dyingIds={dyingIds}
                realityOverride={realityOverride}
                targetedEntityId={targetedEntityId}
                spectatorTargetId={spectatorTargetId}
                visualConfig={visualConfig}
                globalOverride={globalOverride}
                customTextureUrl={customTextureUrl}
            />
            <ParticleSystem particles={particles} />
        </>
    );
};
