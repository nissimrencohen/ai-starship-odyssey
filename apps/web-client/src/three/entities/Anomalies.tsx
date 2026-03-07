import React, { useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { MeshDistortMaterial } from '@react-three/drei';

// Particle system simulating matter being sucked into the singularity
const AccretionParticles: React.FC<{ color: string }> = ({ color }) => {
    const pRef = useRef<THREE.Points>(null);
    const count = 1000;

    const positions = useMemo(() => {
        const arr = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 0.5 + Math.random() * 4.0;
            const height = (Math.random() - 0.5) * 0.4 * (dist / 4.0); // Flatter near edge
            arr[i * 3] = Math.cos(angle) * dist;
            arr[i * 3 + 1] = height;
            arr[i * 3 + 2] = Math.sin(angle) * dist;
        }
        return arr;
    }, []);

    useFrame((_, delta) => {
        if (!pRef.current) return;
        const pos = pRef.current.geometry.attributes.position.array as Float32Array;
        for (let i = 0; i < count; i++) {
            let x = pos[i * 3];
            let y = pos[i * 3 + 1];
            let z = pos[i * 3 + 2];

            let dist = Math.sqrt(x * x + z * z);
            let angle = Math.atan2(z, x);

            // Speed increases exponentially as it gets closer
            const speed = 0.2 + (2.0 / (dist + 0.1));

            angle += delta * speed * 2.0; // swirl
            dist -= delta * speed * 0.5; // pull inward

            if (dist < 0.3) { // crossed event horizon
                dist = 3.5 + Math.random() * 1.5; // respawn at outer edge
                angle = Math.random() * Math.PI * 2;
                y = (Math.random() - 0.5) * 0.4 * (dist / 4.0);
            }

            pos[i * 3] = Math.cos(angle) * dist;
            pos[i * 3 + 1] = y * 0.95; // flatten as it gets closer
            pos[i * 3 + 2] = Math.sin(angle) * dist;
        }
        pRef.current.geometry.attributes.position.needsUpdate = true;
    });

    return (
        <points ref={pRef}>
            <bufferGeometry>
                <bufferAttribute
                    attach="attributes-position"
                    count={count}
                    array={positions}
                    itemSize={3}
                />
            </bufferGeometry>
            <pointsMaterial
                size={0.06}
                color={color}
                transparent
                opacity={0.8}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
            />
        </points>
    );
};

// Custom Shader for the Accretion Disk (swirling noise + heat distortion)
const AccretionDiskShader = {
    vertexShader: `
    uniform float uTime;
    varying vec2 vUv;
    varying vec3 vPosition;
    varying float vDist;

    void main() {
      vUv = uv;
      vPosition = position;
      vDist = length(position.xy);
      float wave = sin(vDist * 5.0 - uTime * 2.0) * 0.05;
      vec3 pos = position;
      pos.z += wave;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
  `,
    fragmentShader: `
    uniform float uTime;
    uniform vec3 uColor;
    uniform float uInnerRadius;
    uniform float uOuterRadius;
    varying vec2 vUv;
    varying vec3 vPosition;
    varying float vDist;

    float noise(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }
    float snoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = noise(i);
      float b = noise(i + vec2(1.0, 0.0));
      float c = noise(i + vec2(0.0, 1.0));
      float d = noise(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    void main() {
      if (vDist < uInnerRadius || vDist > uOuterRadius) discard;
      float angle = atan(vPosition.y, vPosition.x);
      float swirl = snoise(vec2(vDist * 2.0, angle + uTime * 0.2));
      float swirl2 = snoise(vec2(vDist * 4.0, angle - uTime * 0.4));
      float intensity = pow(1.5 - (vDist - uInnerRadius) / (uOuterRadius - uInnerRadius), 3.0);
      intensity *= 0.5 + 0.5 * (swirl * swirl2);
      float edgeFade = smoothstep(uOuterRadius, uOuterRadius - 0.5, vDist);
      float innerFade = smoothstep(uInnerRadius, uInnerRadius + 0.1, vDist);
      vec3 finalColor = uColor * intensity * edgeFade * innerFade;
      if (intensity > 0.8) {
          finalColor += vec3(1.0, 0.5, 0.2) * (intensity - 0.8);
      }
      gl_FragColor = vec4(finalColor, (intensity + 0.2) * edgeFade * innerFade);
    }
  `,
};

// Gravitational lensing rim glow — a visible halo around the event horizon
const LensingGlowShader = {
    vertexShader: `
    varying vec3 vNormal;
    varying vec3 vViewDir;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      vec4 worldPos = modelViewMatrix * vec4(position, 1.0);
      vViewDir = normalize(-worldPos.xyz);
      gl_Position = projectionMatrix * worldPos;
    }
  `,
    fragmentShader: `
    uniform vec3 uColor;
    uniform float uIntensity;
    varying vec3 vNormal;
    varying vec3 vViewDir;
    void main() {
      float rim = 1.0 - max(dot(vNormal, vViewDir), 0.0);
      rim = pow(rim, 2.5);
      gl_FragColor = vec4(uColor * rim * uIntensity, rim * 0.9);
    }
  `,
};

export const Singularity: React.FC<{ radius: number; isDestructive?: boolean }> = ({ radius, isDestructive = false }) => {
    const diskRef = useRef<THREE.ShaderMaterial>(null);

    const diskUniforms = useMemo(() => ({
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(isDestructive ? '#ff2200' : '#ff8c00') },
        uInnerRadius: { value: 0.4 },
        uOuterRadius: { value: 2.8 },
    }), [isDestructive]);

    const lensUniforms = useMemo(() => ({
        uColor: { value: new THREE.Color(isDestructive ? '#ff4400' : '#ffaa00') },
        uIntensity: { value: isDestructive ? 2.5 : 1.8 },
    }), [isDestructive]);

    useFrame((state) => {
        const time = state.clock.getElapsedTime();
        if (diskRef.current) diskRef.current.uniforms.uTime.value = time;
    });

    return (
        <group scale={[radius, radius, radius]}>
            {/* 1. The Void — event horizon (dark purple emissive, NOT pure black) */}
            <mesh>
                <sphereGeometry args={[0.38, 64, 64]} />
                <meshStandardMaterial
                    color="#0a0010"
                    emissive="#1a0030"
                    emissiveIntensity={0.6}
                    roughness={1}
                    metalness={0}
                />
            </mesh>

            {/* 2. Gravitational Lensing Rim Glow (rim shader — works on any canvas) */}
            <mesh scale={[1.15, 1.15, 1.15]}>
                <sphereGeometry args={[1, 64, 64]} />
                <shaderMaterial
                    uniforms={lensUniforms}
                    vertexShader={LensingGlowShader.vertexShader}
                    fragmentShader={LensingGlowShader.fragmentShader}
                    transparent
                    side={THREE.BackSide}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                />
            </mesh>
            <mesh scale={[1.15, 1.15, 1.15]}>
                <sphereGeometry args={[1, 64, 64]} />
                <shaderMaterial
                    uniforms={lensUniforms}
                    vertexShader={LensingGlowShader.vertexShader}
                    fragmentShader={LensingGlowShader.fragmentShader}
                    transparent
                    side={THREE.FrontSide}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                />
            </mesh>

            {/* Matter being pulled into the Black Hole */}
            <AccretionParticles color={isDestructive ? '#ff4000' : '#ff8800'} />

            {/* 3. Accretion Disk (custom swirling shader) */}
            <mesh rotation={[Math.PI / 2.1, 0, 0]}>
                <ringGeometry args={[0.4, 3.0, 128]} />
                <shaderMaterial
                    ref={diskRef}
                    uniforms={diskUniforms}
                    vertexShader={AccretionDiskShader.vertexShader}
                    fragmentShader={AccretionDiskShader.fragmentShader}
                    transparent
                    side={THREE.DoubleSide}
                    blending={THREE.AdditiveBlending}
                />
            </mesh>

            {/* 4. Destructive Heat Aura */}
            {isDestructive && (
                <mesh scale={[1.8, 1.8, 1.8]}>
                    <sphereGeometry args={[1, 32, 32]} />
                    <MeshDistortMaterial
                        color="#ff4400"
                        speed={4}
                        distort={0.6}
                        transparent
                        opacity={0.12}
                        blending={THREE.AdditiveBlending}
                        depthWrite={false}
                    />
                </mesh>
            )}

            {/* 5. Far-visible glow beacon — bright light, low decay, wide reach */}
            <pointLight
                color={isDestructive ? '#ff3300' : '#ffaa00'}
                intensity={isDestructive ? 200000 : 80000}
                distance={radius * 120}
                decay={0.4}
            />
            {/* Near-field fill light for close-up drama */}
            <pointLight
                color={isDestructive ? '#ff6600' : '#ffcc44'}
                intensity={isDestructive ? 8000 : 3000}
                distance={radius * 8}
                decay={1.0}
            />
        </group>
    );
};
