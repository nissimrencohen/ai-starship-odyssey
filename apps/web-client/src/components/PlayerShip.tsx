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
                    <meshStandardMaterial color={cPrimary} emissive={cSecondary} emissiveIntensity={2} wireframe={false} />
                </mesh>
                <mesh position={[22, -16, 0]} rotation={[0, 0, Math.PI / 5]}>
                    <boxGeometry args={[28, 6, 8]} />
                    <meshStandardMaterial color={cSecondary} emissive={cSecondary} emissiveIntensity={0.5} wireframe={false} />
                </mesh>
                <mesh position={[-22, -16, 0]} rotation={[0, 0, -Math.PI / 5]}>
                    <boxGeometry args={[28, 6, 8]} />
                    <meshStandardMaterial color={cSecondary} emissive={cSecondary} emissiveIntensity={0.5} wireframe={false} />
                </mesh>
                <mesh position={[0, -34, 0]}>
                    <sphereGeometry args={[8, 16, 16]} />
                    <meshBasicMaterial color="#ef4444" wireframe={false} />
                </mesh>
            </group>
        );
    } else if (mappedType === 'freighter') {
        return (
            <group rotation={[Math.PI / 2, 0, 0]}>
                <mesh position={[0, -10, 0]}>
                    <boxGeometry args={[20, 50, 20]} />
                    <meshStandardMaterial color={color || '#475569'} roughness={0.8} wireframe={false} />
                </mesh>
                <mesh position={[0, 15, 0]}>
                    <boxGeometry args={[10, 20, 10]} />
                    <meshStandardMaterial color="#1e293b" wireframe={false} />
                </mesh>
                <mesh position={[0, -35, 0]}>
                    <sphereGeometry args={[8, 16, 16]} />
                    <meshBasicMaterial color="#f59e0b" wireframe={false} />
                </mesh>
            </group>
        );
    } else if (mappedType === 'stealth') {
        return (
            <group rotation={[Math.PI / 2, 0, 0]}>
                <mesh position={[0, 0, 0]}>
                    <coneGeometry args={[16, 50, 3]} />
                    <meshStandardMaterial color={color || '#0f172a'} roughness={0.9} emissive={color || '#3b82f6'} emissiveIntensity={0.2} wireframe={false} />
                </mesh>
                <mesh position={[0, -20, -5]} rotation={[Math.PI / 6, 0, 0]}>
                    <boxGeometry args={[40, 4, 15]} />
                    <meshStandardMaterial color={color || '#0f172a'} roughness={0.9} wireframe={false} />
                </mesh>
                <mesh position={[0, -25, 0]}>
                    <sphereGeometry args={[5, 16, 16]} />
                    <meshBasicMaterial color={color || '#3b82f6'} wireframe={false} />
                </mesh>
            </group>
        );
    }

    // Default UFO
    return (
        <group>
            <mesh position={[0, 0, 0]}>
                <sphereGeometry args={[15, 32, 16]} />
                <meshStandardMaterial color={cPrimary} emissive={cPrimary} emissiveIntensity={1} wireframe={false} />
            </mesh>
            <mesh position={[0, -2, 0]} scale={[2, 0.3, 2]}>
                <sphereGeometry args={[20, 32, 16]} />
                <meshStandardMaterial color="#cbd5e1" metalness={0.9} roughness={0.1} wireframe={false} />
            </mesh>
            <mesh position={[0, -7, 0]}>
                <sphereGeometry args={[6, 16, 16]} />
                <meshBasicMaterial color={cPrimary} wireframe={false} />
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

// Map ship type names → GLTF asset URLs served by the Python Director
const SHIP_MODEL_URLS: Record<string, string> = {
    fighter:     'http://127.0.0.1:8000/assets/models/fighter.gltf',
    stinger:     'http://127.0.0.1:8000/assets/models/fighter.gltf',
    interceptor: 'http://127.0.0.1:8000/assets/models/fighter.gltf',
    freighter:   'http://127.0.0.1:8000/assets/models/freighter.gltf',
    goliath:     'http://127.0.0.1:8000/assets/models/freighter.gltf',
    stealth:     'http://127.0.0.1:8000/assets/models/stealth.gltf',
    ufo:         'http://127.0.0.1:8000/assets/models/ufo.gltf',
};

const ShipModel = ({ url }: { url: string }) => {
    const { scene } = useGLTF(url);
    return <primitive object={scene} />;
};

interface PlayerShipProps {
    position: [number, number, number];
    rotationRef: React.MutableRefObject<number>;
    camPitchRef: React.MutableRefObject<number>;
    modelUrl?: string;
    shipType?: string;
    shipColor?: string;
    isCloaked?: boolean;
}

export const PlayerShip: React.FC<PlayerShipProps> = ({ position, rotationRef, camPitchRef, modelUrl, shipType, shipColor, isCloaked }) => {
    const groupRef = useRef<THREE.Group>(null);

    // Resolve model URL: explicit prop first, then type mapping, then no model
    const resolvedModelUrl = modelUrl || (shipType ? SHIP_MODEL_URLS[shipType] : undefined);

    React.useEffect(() => {
        if (resolvedModelUrl) preloadShipModel(resolvedModelUrl);
    }, [resolvedModelUrl]);

    useFrame(() => {
        if (groupRef.current) {
            groupRef.current.position.lerp(new THREE.Vector3(...position), 0.4); // Increased from 0.15

            // Read latest values from refs every frame for real-time response
            const rotation = rotationRef.current;
            const camPitch = camPitchRef.current;

            // Yaw: ship faces its heading direction (camera yaw)
            const yawQ = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0),
                -rotation + Math.PI / 2
            );
            // Pitch: tilt nose up/down based on camera pitch
            // Inverted camPitch to fix the "look up -> nose down" visual bug
            const pitchQ = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0),
                -camPitch
            );
            const targetQ = yawQ.multiply(pitchQ);
            groupRef.current.quaternion.slerp(targetQ, 0.4); // Increased from 0.15
        }
    });

    return (
        <group ref={groupRef} visible={!isCloaked}>
            {resolvedModelUrl ? (
                <Suspense fallback={<ShipFallback type={shipType} color={shipColor} />}>
                    <GLTFErrorBoundary fallback={<ShipFallback type={shipType} color={shipColor} />}>
                        <ShipModel url={resolvedModelUrl} />
                    </GLTFErrorBoundary>
                </Suspense>
            ) : (
                <ShipFallback type={shipType} color={shipColor} />
            )}

            {/* Thruster light */}
            <pointLight position={[0, -36, 0]} color={shipColor || (shipType === 'ufo' || !shipType ? "#22d3ee" : "#ef4444")} intensity={150} distance={400} />

        </group>
    );
};
