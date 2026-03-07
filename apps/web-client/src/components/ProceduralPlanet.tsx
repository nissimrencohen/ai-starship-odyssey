import React, { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

// GLSL 3D Simplex noise and FBM
const NOISE_GLSL = `
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}

float snoise(vec3 v){ 
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy) );
  vec3 x0 = v - i + dot(i, C.xxx) ;

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );

  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

  i = mod(i, 289.0 ); 
  vec4 p = permute( permute( permute( 
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 )) 
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

  float n_ = 1.0/7.0;
  vec3  ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z *ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );

  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );

  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), 
                                dot(p2,x2), dot(p3,x3) ) );
}

float fbm(vec3 x) {
    float v = 0.0;
    float a = 0.5;
    vec3 shift = vec3(100.0);
    for (int i = 0; i < 4; ++i) {
        v += a * snoise(x);
        x = x * 2.0 + shift;
        a *= 0.5;
    }
    return v;
}
`;

export interface ProceduralPlanetProps {
    radius: number;
    entityId: number;
}

export const ProceduralPlanet: React.FC<ProceduralPlanetProps> = ({ radius, entityId }) => {
    // Determine seed based on entityId to be deterministic
    const seed = useMemo(() => (entityId * 123.456) % 1000.0, [entityId]);

    const materialRef = useRef<THREE.MeshStandardMaterial>(null);

    const onBeforeCompile = useMemo(() => (shader: any) => {
        shader.uniforms.uSeed = { value: seed };

        // Inject uniforms and noise functions into the vertex shader
        shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            `
            #include <common>
            uniform float uSeed;
            varying float vElevation;
            ${NOISE_GLSL}
            `
        );

        // Displace position
        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `
            #include <begin_vertex>
            vec3 pos = position;
            // Adjust frequency based on radius so noise scales decently
            float freq = 2.0 / ${(radius > 0 ? radius : 1).toFixed(1)};
            float n = fbm(pos * freq + uSeed);
            
            // Note: We skip displacement now to preserve perfectly spherical vertex normals,
            // preventing the severe shading artifacts when standard material lights the mesh.
            vElevation = n;
            `
        );

        // Inject varying into the fragment shader
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <common>',
            `
            #include <common>
            varying float vElevation;
            `
        );

        // Apply Biome coloring
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <color_fragment>',
            `
            #include <color_fragment>
            
            vec3 colorDeepWater = vec3(0.01, 0.1, 0.4);
            vec3 colorShallowWater = vec3(0.05, 0.3, 0.6);
            vec3 colorSand = vec3(0.8, 0.7, 0.4);
            vec3 colorGrass = vec3(0.2, 0.5, 0.1);
            vec3 colorRock = vec3(0.4, 0.4, 0.4);
            vec3 colorSnow = vec3(0.9, 0.9, 0.95);
            
            vec3 finalColor = colorDeepWater;
            float e = vElevation;
            
            if (e < -0.1) {
                finalColor = mix(colorDeepWater, colorShallowWater, smoothstep(-0.5, -0.1, e));
            } else if (e < 0.0) {
                finalColor = mix(colorShallowWater, colorSand, smoothstep(-0.1, 0.0, e));
            } else if (e < 0.2) {
                finalColor = mix(colorSand, colorGrass, smoothstep(0.0, 0.2, e));
            } else if (e < 0.5) {
                finalColor = mix(colorGrass, colorRock, smoothstep(0.2, 0.5, e));
            } else {
                finalColor = mix(colorRock, colorSnow, smoothstep(0.5, 0.8, e));
            }
            
            diffuseColor.rgb = finalColor;
            `
        );
    }, [seed, radius]);

    return (
        <mesh>
            <icosahedronGeometry args={[radius, 32]} />
            <meshStandardMaterial
                ref={materialRef}
                roughness={0.8}
                metalness={0.1}
                wireframe={false}
                onBeforeCompile={onBeforeCompile}
            />
        </mesh>
    );
};
