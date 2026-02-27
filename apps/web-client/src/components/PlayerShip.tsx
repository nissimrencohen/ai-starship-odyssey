import React, { useRef, Suspense } from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Procedural Fallback Ship Component — scaled to world units (hundreds of units across)
const ShipFallback = ({ type = 'ufo', color }: { type?: string, color?: string }) => {
    // Map tactical chassis names to base visual models
    const mappedType = type === 'goliath' ? 'freighter' : (type === 'stinger' || type === 'interceptor' ? 'fighter' : type);

    // Default colors if not supplied
    const cPrimary = color || (mappedType === 'ufo' ? '#a855f7' : '#22d3ee');
    const cSecondary = color || '#0891b2';

    if (mappedType === 'fighter') {
        return (
            <group>
                <mesh>
                    <coneGeometry args={[12, 60, 4]} />
                    <meshStandardMaterial color={cPrimary} emissive={cSecondary} emissiveIntensity={2} />
                </mesh>
                <mesh position={[22, -16, 0]} rotation={[0, 0, Math.PI / 5]}>
                    <boxGeometry args={[28, 6, 8]} />
                    <meshStandardMaterial color={cSecondary} emissive={cSecondary} emissiveIntensity={0.5} />
                </mesh>
                <mesh position={[-22, -16, 0]} rotation={[0, 0, -Math.PI / 5]}>
                    <boxGeometry args={[28, 6, 8]} />
                    <meshStandardMaterial color={cSecondary} emissive={cSecondary} emissiveIntensity={0.5} />
                </mesh>
                <mesh position={[0, -34, 0]}>
                    <sphereGeometry args={[8, 16, 16]} />
                    <meshBasicMaterial color="#ef4444" />
                </mesh>
            </group>
        );
    } else if (mappedType === 'freighter') {
        return (
            <group rotation={[Math.PI / 2, 0, 0]}>
                <mesh position={[0, -10, 0]}>
                    <boxGeometry args={[20, 50, 20]} />
                    <meshStandardMaterial color={color || '#475569'} roughness={0.8} />
                </mesh>
                <mesh position={[0, 15, 0]}>
                    <boxGeometry args={[10, 20, 10]} />
                    <meshStandardMaterial color="#1e293b" />
                </mesh>
                <mesh position={[0, -35, 0]}>
                    <sphereGeometry args={[8, 16, 16]} />
                    <meshBasicMaterial color="#f59e0b" />
                </mesh>
            </group>
        );
    } else if (mappedType === 'stealth') {
        return (
            <group rotation={[Math.PI / 2, 0, 0]}>
                <mesh position={[0, 0, 0]}>
                    <coneGeometry args={[16, 50, 3]} />
                    <meshStandardMaterial color={color || '#0f172a'} roughness={0.9} emissive={color || '#3b82f6'} emissiveIntensity={0.2} />
                </mesh>
                <mesh position={[0, -20, -5]} rotation={[Math.PI / 6, 0, 0]}>
                    <boxGeometry args={[40, 4, 15]} />
                    <meshStandardMaterial color={color || '#0f172a'} roughness={0.9} />
                </mesh>
                <mesh position={[0, -25, 0]}>
                    <sphereGeometry args={[5, 16, 16]} />
                    <meshBasicMaterial color={color || '#3b82f6'} />
                </mesh>
            </group>
        );
    }

    // Default UFO
    return (
        <group>
            <mesh position={[0, 0, 0]}>
                <sphereGeometry args={[15, 32, 16]} />
                <meshStandardMaterial color={cPrimary} emissive={cPrimary} emissiveIntensity={1} />
            </mesh>
            <mesh position={[0, -2, 0]} scale={[2, 0.3, 2]}>
                <sphereGeometry args={[20, 32, 16]} />
                <meshStandardMaterial color="#cbd5e1" metalness={0.9} roughness={0.1} />
            </mesh>
            <mesh position={[0, -7, 0]}>
                <sphereGeometry args={[6, 16, 16]} />
                <meshBasicMaterial color={cPrimary} />
            </mesh>
        </group>
    );
};

// Error Boundary for GLTF Loading
class GLTFErrorBoundary extends React.Component<{ children: React.ReactNode, fallback: React.ReactNode }, { hasError: boolean }> {
    constructor(props: any) {
        super(props);
        this.state = { hasError: false };
    }
    static getDerivedStateFromError() {
        return { hasError: true };
    }
    render() {
        if (this.state.hasError) return this.props.fallback;
        return this.props.children;
    }
}

// Helper function to globally preload models so they are in cache before the Director requests them
export const preloadShipModel = (url: string) => {
    try {
        useGLTF.preload(url);
    } catch (e) {
        console.warn("Could not preload ship model:", url);
    }
};

const ShipModel = ({ url }: { url: string }) => {
    const { scene } = useGLTF(url);
    return <primitive object={scene} />;
};

interface PlayerShipProps {
    position: [number, number, number];
    rotation: number;
    modelUrl?: string; // Optional URL for explicit glTF injection
    shipType?: string; // The semantic type from the AI (e.g., 'freighter', 'stealth')
    shipColor?: string;
}

export const PlayerShip: React.FC<PlayerShipProps> = ({ position, rotation, modelUrl, shipType, shipColor }) => {
    const groupRef = useRef<THREE.Group>(null);

    // Attempt standard preloads if a known modelUrl format is provided
    React.useEffect(() => {
        if (modelUrl) preloadShipModel(modelUrl);
    }, [modelUrl]);

    useFrame((state, delta) => {
        if (groupRef.current) {
            // Smoothly follow the physics position (already in three.js coords from GameScene)
            groupRef.current.position.lerp(new THREE.Vector3(...position), 0.15);

            // Rotate around Y-axis (up) so the ship faces its heading direction
            // on the XZ floor, with the dome always pointing upward toward the camera.
            const targetRotation = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0),
                -rotation + Math.PI / 2
            );
            groupRef.current.quaternion.slerp(targetRotation, 0.15);
        }
    });

    return (
        <group ref={groupRef}>
            {modelUrl ? (
                <Suspense fallback={<ShipFallback type={shipType} color={shipColor} />}>
                    <GLTFErrorBoundary fallback={<ShipFallback type={shipType} color={shipColor} />}>
                        <ShipModel url={modelUrl} />
                    </GLTFErrorBoundary>
                </Suspense>
            ) : (
                <ShipFallback type={shipType} color={shipColor} />
            )}

            {/* Thruster light */}
            <pointLight position={[0, -36, 0]} color={shipColor || (shipType === 'ufo' || !shipType ? "#22d3ee" : "#ef4444")} intensity={150} distance={400} />

            {/* 3D Aiming Crosshair (Requirement 5) */}
            <group position={[0, 0, 150]}>
                <mesh rotation={[Math.PI / 2, 0, 0]}>
                    <ringGeometry args={[10, 12, 32]} />
                    <meshBasicMaterial color="#ef4444" transparent opacity={0.6} side={THREE.DoubleSide} />
                </mesh>
                <mesh>
                    <sphereGeometry args={[2, 8, 8]} />
                    <meshBasicMaterial color="#ef4444" transparent opacity={0.8} />
                </mesh>
            </group>
        </group>
    );
};
