import React, { useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';

interface CameraSystemProps {
    spectatorTargetId: number | null;
    ecsEntitiesRef: React.MutableRefObject<Record<string, any>>;
    camYawRef: React.MutableRefObject<number>;
    camPitchRef: React.MutableRefObject<number>;
    zoom: number;
}

export const CameraSystem: React.FC<CameraSystemProps> = ({
    spectatorTargetId,
    ecsEntitiesRef,
    camYawRef,
    camPitchRef,
    zoom,
}) => {
    const { camera } = useThree();
    const smoothedPos = useRef(new THREE.Vector3(8500, 500, 0));
    const smoothedCamPos = useRef(new THREE.Vector3(8400, 600, -200));
    const prevSpectatorId = useRef<number | null>(null);

    useFrame((_, delta) => {
        if (!camera) return;

        // 1. Identify Target
        let focusEnt;
        if (spectatorTargetId !== null) {
            focusEnt = ecsEntitiesRef.current[spectatorTargetId];
        }

        // Fallback to player if no spectator target or target disappeared
        const playerEnt = Object.values(ecsEntitiesRef.current).find((e: any) => e.ent_type === 'player') as any;
        if (!focusEnt) {
            focusEnt = playerEnt;
        }

        if (!focusEnt) return;

        const targetPos = new THREE.Vector3(focusEnt.x, focusEnt.y || 0, focusEnt.z || 0);

        const wasSpectating = prevSpectatorId.current !== null;
        const isSpectatingNow = spectatorTargetId !== null;
        const targetChanged = prevSpectatorId.current !== spectatorTargetId;

        // Snap camera to player when exiting spectator mode
        if (wasSpectating && !isSpectatingNow && playerEnt) {
            const playerPos = new THREE.Vector3(playerEnt.x, playerEnt.y || 0, playerEnt.z || 0);
            smoothedPos.current.copy(playerPos);
            smoothedCamPos.current.copy(playerPos);
        }
        // Snap immediately when jumping to a different spectator target (radar jump)
        // Without this, the slow lerp from old→new position causes the camera to spin wildly.
        else if (isSpectatingNow && targetChanged) {
            smoothedPos.current.copy(targetPos);
            smoothedCamPos.current.copy(targetPos);
        }
        prevSpectatorId.current = spectatorTargetId;

        // 2. Interpolation Alphas (frame-rate-independent lerp)
        const posAlpha = 1 - Math.pow(0.6, delta * 60);
        const camAlpha = 1 - Math.pow(0.85, delta * 60);

        // Smoothly follow the entity's position
        smoothedPos.current.lerp(targetPos, posAlpha);

        // 3. Camera Rotation Logic
        let yaw = camYawRef.current;
        let pitch = camPitchRef.current;

        const isSpectating = spectatorTargetId !== null;

        // Camera rotation uses camYawRef and camPitchRef (initialized in App.tsx)

        // Zoom-controlled distance for both normal and spectator modes.
        // Spectator may use wider zoom range (clamped in App.tsx wheel handler).
        const finalDist = 300 + zoom * 100;

        const relOffset = new THREE.Vector3(0, 80, -finalDist);

        const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw + Math.PI / 2);
        const pitchQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch);
        const rotationQ = yawQ.multiply(pitchQ);

        const worldOffset = relOffset.applyQuaternion(rotationQ);
        const targetCam = smoothedPos.current.clone().add(worldOffset);

        // Smooth camera transition
        smoothedCamPos.current.lerp(targetCam, camAlpha);
        camera.position.copy(smoothedCamPos.current);

        // Look at the target (with a slight offset for composition)
        const lookTarget = smoothedPos.current.clone().add(new THREE.Vector3(0, isSpectating ? 0 : 30, 0).applyQuaternion(rotationQ));
        camera.lookAt(lookTarget);
    });

    return null;
};
