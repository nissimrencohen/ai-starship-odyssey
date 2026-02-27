import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface ParticleSystemProps {
    particles: any[];
}

export const ParticleSystem: React.FC<ParticleSystemProps> = ({ particles }) => {
    const pointsRef = useRef<THREE.Points>(null);

    const particlesData = useMemo(() => {
        const positions = new Float32Array(particles.length * 3);
        const colors = new Float32Array(particles.length * 3);

        particles.forEach((p, i) => {
            // Map Rust XY plane → three.js XZ floor (Y is up)
            positions[i * 3] = p.x;
            positions[i * 3 + 1] = p.z || 0;
            positions[i * 3 + 2] = p.y;

            // Dynamic color mapping from the Rust engine
            const color = new THREE.Color(p.color || '#f97316');
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;
        });

        return { positions, colors };
    }, [particles]);

    return (
        <points ref={pointsRef}>
            <bufferGeometry>
                <bufferAttribute
                    attach="attributes-position"
                    count={particlesData.positions.length / 3}
                    array={particlesData.positions}
                    itemSize={3}
                />
                <bufferAttribute
                    attach="attributes-color"
                    count={particlesData.colors.length / 3}
                    array={particlesData.colors}
                    itemSize={3}
                />
            </bufferGeometry>
            <pointsMaterial
                size={2.5}
                vertexColors
                transparent
                opacity={0.8}
                sizeAttenuation
            />
        </points>
    );
};
