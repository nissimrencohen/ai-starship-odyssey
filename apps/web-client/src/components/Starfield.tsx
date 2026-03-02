import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface StarfieldProps {
    count?: number;
    position?: [number, number, number];
}

export const Starfield: React.FC<StarfieldProps> = ({ count = 5000, position = [0, 0, 0] }) => {
    const pointsRef = useRef<THREE.Points>(null);

    const { posArray, colorArray } = useMemo(() => {
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        const colorEntries = [
            new THREE.Color('#ffffff'), // White
            new THREE.Color('#93c5fd'), // Pale Blue
            new THREE.Color('#fde68a'), // Soft Yellow
        ];

        for (let i = 0; i < count; i++) {
            // Spherical shell distribution: R between 200k and 500k
            const radius = 200000 + Math.random() * 300000;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(Math.random() * 2 - 1);

            positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
            positions[i * 3 + 2] = radius * Math.cos(phi);

            // Randomly select one of the colors
            const clr = colorEntries[Math.floor(Math.random() * colorEntries.length)];
            colors[i * 3] = clr.r;
            colors[i * 3 + 1] = clr.g;
            colors[i * 3 + 2] = clr.b;
        }
        return { posArray: positions, colorArray: colors };
    }, [count]);

    // Stars should slowly rotatate independently of the skybox position
    useFrame((state) => {
        if (pointsRef.current) {
            pointsRef.current.rotation.y += 0.0001;
            pointsRef.current.rotation.x += 0.00005;
        }
    });

    return (
        <group position={position}>
            <points ref={pointsRef}>
                <bufferGeometry>
                    <bufferAttribute
                        attach="attributes-position"
                        count={posArray.length / 3}
                        array={posArray}
                        itemSize={3}
                    />
                    <bufferAttribute
                        attach="attributes-color"
                        count={colorArray.length / 3}
                        array={colorArray}
                        itemSize={3}
                    />
                </bufferGeometry>
                <pointsMaterial
                    size={1.5}
                    vertexColors
                    transparent
                    opacity={0.8}
                    sizeAttenuation={false}
                />
            </points>
        </group>
    );
};
