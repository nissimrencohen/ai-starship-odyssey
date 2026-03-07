import React, { useRef } from 'react';
import * as THREE from 'three';

interface SpaceGridProps {
    color?: string;
}

export const SpaceGrid: React.FC<SpaceGridProps> = ({ color = '#8b5cf6' }) => {
    const meshRef = useRef<THREE.Group>(null);

    // Create a large grid of lines
    const size = 2000;
    const divisions = 20;

    return (
        <group ref={meshRef} rotation={[-Math.PI / 2, 0, 0]}>
            <gridHelper
                args={[size, divisions, color, color]}
                position={[0, -5, 0]}
            />
            {/* Glow Plane */}
            <mesh position={[0, -5.1, 0]}>
                <planeGeometry args={[size, size]} />
                <meshStandardMaterial
                    color={color}
                    transparent
                    opacity={0.05}
                    metalness={0.9}
                    roughness={0.1}
                />
            </mesh>
        </group>
    );
};
