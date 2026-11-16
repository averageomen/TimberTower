import { useMemo, useRef } from 'react';
import { Environment, Lightformer, RoundedBox } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { CylinderCollider, RigidBody } from '@react-three/rapier';
import * as THREE from 'three';
import { getTableWoodMaps } from '../utils/woodTexture';

function FramedPoster({
  position,
  rotation,
  palette,
  variant,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
  palette: [string, string, string, string];
  variant: 0 | 1 | 2;
}) {
  return (
    <group position={position} rotation={rotation}>
      {/* Walnut Frame */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[7.2, 9.2, 0.35]} />
        <meshStandardMaterial color="#2a1a10" roughness={0.55} metalness={0.05} />
      </mesh>
      {/* Cream Matboard */}
      <mesh position={[0, 0, 0.15]} receiveShadow>
        <boxGeometry args={[6.4, 8.4, 0.08]} />
        <meshStandardMaterial color="#efe6d5" roughness={0.92} />
      </mesh>
      {/* Geometric Artwork Backdrop */}
      <mesh position={[0, 0, 0.2]}>
        <planeGeometry args={[5.2, 7.2]} />
        <meshStandardMaterial color={palette[0]} roughness={0.85} />
      </mesh>

      {variant === 0 && (
        <group position={[0, 0, 0.22]}>
          <mesh position={[0, 1.1, 0]}>
            <circleGeometry args={[1.65, 48]} />
            <meshStandardMaterial color={palette[1]} roughness={0.75} />
          </mesh>
          <mesh position={[-0.9, -1.3, 0.01]}>
            <planeGeometry args={[2.1, 3.1]} />
            <meshStandardMaterial color={palette[2]} roughness={0.75} />
          </mesh>
          <mesh position={[1.15, -1.65, 0.02]}>
            <circleGeometry args={[1.05, 48]} />
            <meshStandardMaterial color={palette[3]} roughness={0.75} />
          </mesh>
        </group>
      )}

      {variant === 1 && (
        <group position={[0, 0, 0.22]}>
          <mesh position={[0, 0.6, 0]}>
            <planeGeometry args={[3.6, 4.2]} />
            <meshStandardMaterial color={palette[1]} roughness={0.78} />
          </mesh>
          <mesh position={[0, 1.6, 0.01]}>
            <circleGeometry args={[1.3, 48]} />
            <meshStandardMaterial color={palette[2]} roughness={0.78} />
          </mesh>
          <mesh position={[0, -2.0, 0.02]}>
            <planeGeometry args={[4.2, 1.4]} />
            <meshStandardMaterial color={palette[3]} roughness={0.78} />
          </mesh>
        </group>
      )}

      {variant === 2 && (
        <group position={[0, 0, 0.22]}>
          <mesh position={[-0.7, 1.4, 0]} rotation={[0, 0, Math.PI / 4]}>
            <planeGeometry args={[2.3, 2.3]} />
            <meshStandardMaterial color={palette[1]} roughness={0.78} />
          </mesh>
          <mesh position={[0.75, -0.35, 0.01]}>
            <circleGeometry args={[1.45, 48]} />
            <meshStandardMaterial color={palette[2]} roughness={0.78} />
          </mesh>
          <mesh position={[-0.6, -2.15, 0.02]}>
            <planeGeometry args={[3.1, 1.1]} />
            <meshStandardMaterial color={palette[3]} roughness={0.78} />
          </mesh>
        </group>
      )}
    </group>
  );
}

function CoffeeMugProp({ position }: { position: [number, number, number] }) {
  const steamRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (!steamRef.current) return;
    const t = clock.getElapsedTime();
    steamRef.current.children.forEach((child, idx) => {
      const phase = (t * 0.45 + idx * 0.33) % 1;
      child.position.y = 1.65 + phase * 1.4;
      child.position.x = Math.sin(t * 1.8 + idx * 2.1) * 0.12;
      child.rotation.z = t * 0.6 + idx;
      const scale = 0.6 + phase * 0.9;
      child.scale.set(scale, scale, scale);
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = Math.sin(phase * Math.PI) * 0.16;
    });
  });

  return (
    <group position={position}>
      {/* Cork Coaster */}
      <mesh position={[0, 0.05, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.35, 1.4, 0.1, 32]} />
        <meshStandardMaterial color="#b98b5b" roughness={0.92} />
      </mesh>
      {/* Ceramic Mug Body */}
      <mesh position={[0, 0.78, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.88, 0.8, 1.38, 32]} />
        <meshStandardMaterial color="#f2ece1" roughness={0.28} metalness={0.04} />
      </mesh>
      {/* Dark Roast Coffee Surface */}
      <mesh position={[0, 1.38, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.78, 32]} />
        <meshStandardMaterial color="#2a160c" roughness={0.12} metalness={0.1} />
      </mesh>
      {/* Mug Handle */}
      <mesh position={[0.9, 0.78, 0]} rotation={[0, 0, -Math.PI / 2]} castShadow>
        <torusGeometry args={[0.42, 0.11, 16, 28, Math.PI]} />
        <meshStandardMaterial color="#f2ece1" roughness={0.28} metalness={0.04} />
      </mesh>
      {/* Subtle Rising Steam */}
      <group ref={steamRef}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[0, 1.65 + i * 0.4, 0]}>
            <torusGeometry args={[0.24, 0.045, 8, 20]} />
            <meshBasicMaterial color="#fff8ee" transparent opacity={0.12} depthWrite={false} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function PottedSucculent({ position }: { position: [number, number, number] }) {
  const outerLeaves = useMemo(
    () =>
      Array.from({ length: 8 }, (_, idx) => ({
        angle: (idx / 8) * Math.PI * 2,
        tilt: 0.78,
        scale: 1,
      })),
    []
  );

  const innerLeaves = useMemo(
    () =>
      Array.from({ length: 6 }, (_, idx) => ({
        angle: (idx / 6) * Math.PI * 2 + 0.35,
        tilt: 0.42,
        scale: 0.72,
      })),
    []
  );

  return (
    <group position={position}>
      {/* Stone Coaster */}
      <mesh position={[0, 0.05, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.55, 1.6, 0.1, 32]} />
        <meshStandardMaterial color="#4b4743" roughness={0.85} />
      </mesh>
      {/* Terracotta Pot */}
      <mesh position={[0, 0.82, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.18, 0.88, 1.45, 28]} />
        <meshStandardMaterial color="#b75e3c" roughness={0.82} />
      </mesh>
      {/* Pot Rim */}
      <mesh position={[0, 1.48, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.26, 1.24, 0.22, 28]} />
        <meshStandardMaterial color="#c26845" roughness={0.8} />
      </mesh>
      {/* Soil */}
      <mesh position={[0, 1.46, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.12, 24]} />
        <meshStandardMaterial color="#38281e" roughness={0.96} />
      </mesh>
      {/* Outer Succulent Rosette Leaves */}
      {outerLeaves.map((leaf, idx) => (
        <group key={`outer-${idx}`} position={[0, 1.56, 0]} rotation={[0, leaf.angle, 0]}>
          <mesh position={[0.48, 0.22, 0]} rotation={[0, 0, -leaf.tilt]} castShadow>
            <sphereGeometry args={[0.42, 14, 14]} />
            <meshStandardMaterial color="#5c8a62" roughness={0.62} />
          </mesh>
        </group>
      ))}
      {/* Inner Succulent Leaves */}
      {innerLeaves.map((leaf, idx) => (
        <group key={`inner-${idx}`} position={[0, 1.72, 0]} rotation={[0, leaf.angle, 0]}>
          <mesh
            position={[0.26, 0.18, 0]}
            rotation={[0, 0, -leaf.tilt]}
            scale={[leaf.scale, leaf.scale * 1.2, leaf.scale]}
            castShadow
          >
            <sphereGeometry args={[0.38, 14, 14]} />
            <meshStandardMaterial color="#76a878" roughness={0.58} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function BrassCoasterSet({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.06, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.35, 1.38, 0.12, 32]} />
        <meshStandardMaterial color="#c49a5c" roughness={0.52} metalness={0.35} />
      </mesh>
      <mesh position={[0.12, 0.18, -0.08]} castShadow receiveShadow>
        <cylinderGeometry args={[1.25, 1.25, 0.1, 32]} />
        <meshStandardMaterial color="#a67c46" roughness={0.85} />
      </mesh>
    </group>
  );
}

export function EnvironmentScene() {
  const tableMaps = useMemo(() => getTableWoodMaps(), []);

  return (
    <>
      <color attach="background" args={['#1d1510']} />
      <fog attach="fog" args={['#1d1510', 36, 78]} />

      {/* Studio & Warm Room Reflections without external HDRI fetches */}
      <Environment resolution={256} frames={1}>
        <Lightformer
          form="circle"
          intensity={3.2}
          color="#ffe3b8"
          scale={12}
          position={[0, 16, 0]}
          rotation={[Math.PI / 2, 0, 0]}
        />
        <Lightformer
          form="rect"
          intensity={1.5}
          color="#fff1dc"
          scale={[18, 10, 1]}
          position={[-18, 8, 12]}
          target={[0, 4, 0]}
        />
        <Lightformer
          form="rect"
          intensity={0.95}
          color="#b8cff2"
          scale={[16, 10, 1]}
          position={[18, 9, -12]}
          target={[0, 4, 0]}
        />
      </Environment>

      {/* Cozy Room Lighting */}
      <ambientLight intensity={0.38} color="#ffebd4" />
      <hemisphereLight args={['#ffe8c8', '#332217', 0.45]} />

      {/* Overhead Pendant Directional Key Light */}
      <directionalLight
        position={[8, 21, 9]}
        intensity={1.85}
        color="#fff0d8"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={2}
        shadow-camera-far={48}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
        shadow-bias={-0.0004}
      />

      {/* Warm Pendant Pool SpotLight directly overhead */}
      <pointLight
        position={[0, 16.5, 0]}
        intensity={68}
        distance={36}
        decay={1.65}
        color="#ffd79d"
      />

      {/* Soft Cool Rim Light for Depth */}
      <directionalLight position={[-14, 10, -14]} intensity={0.48} color="#a9c5eb" />

      {/* Authoritative Physics Table Collider */}
      <RigidBody type="fixed" name="table-surface" friction={0.8} restitution={0.05}>
        <CylinderCollider args={[0.45, 15]} position={[0, -0.45, 0]} />
      </RigidBody>

      {/* Catcher Collider far below table to detect off-table falls */}
      <RigidBody type="fixed" name="floor-catcher" friction={0.8} restitution={0.05}>
        <CylinderCollider args={[0.5, 40]} position={[0, -10.5, 0]} />
      </RigidBody>

      {/* Richly Textured Circular Walnut Table */}
      <group>
        <mesh position={[0, -0.45, 0]} receiveShadow castShadow>
          <cylinderGeometry args={[15, 14.8, 0.9, 72]} />
          <meshStandardMaterial
            map={tableMaps.map}
            bumpMap={tableMaps.bumpMap}
            bumpScale={0.025}
            roughnessMap={tableMaps.roughnessMap}
            roughness={0.55}
            metalness={0.06}
          />
        </mesh>

        {/* Beveled Outer Brass & Dark Walnut Rim */}
        <mesh position={[0, -0.45, 0]} rotation={[Math.PI / 2, 0, 0]} receiveShadow castShadow>
          <torusGeometry args={[15.0, 0.48, 24, 72]} />
          <meshStandardMaterial color="#362013" roughness={0.45} metalness={0.14} />
        </mesh>
        <mesh position={[0, -0.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[14.7, 0.06, 12, 72]} />
          <meshStandardMaterial color="#b3884d" roughness={0.35} metalness={0.65} />
        </mesh>

        {/* Table Pedestal Column & Foot */}
        <mesh position={[0, -5.2, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[2.1, 2.7, 8.8, 36]} />
          <meshStandardMaterial color="#2a190f" roughness={0.58} />
        </mesh>
        <mesh position={[0, -9.6, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[6.2, 6.8, 0.8, 42]} />
          <meshStandardMaterial color="#24150c" roughness={0.6} />
        </mesh>
      </group>

      {/* Table Props */}
      <CoffeeMugProp position={[-9.8, 0, 5.4]} />
      <PottedSucculent position={[9.6, 0, -6.2]} />
      <BrassCoasterSet position={[9.4, 0, 6.1]} />

      {/* Center Subtle Woven Table Mat */}
      <mesh position={[0, 0.008, 0]} receiveShadow>
        <cylinderGeometry args={[4.4, 4.45, 0.016, 48]} />
        <meshStandardMaterial color="#2f2017" roughness={0.94} />
      </mesh>
      <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[4.22, 4.34, 48]} />
        <meshStandardMaterial color="#b38a52" roughness={0.6} metalness={0.25} />
      </mesh>

      {/* Cozy Room Floor, Rug & Walls */}
      <group>
        {/* Warm Hardwood Floor */}
        <mesh position={[0, -10.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[90, 90]} />
          <meshStandardMaterial color="#342115" roughness={0.78} />
        </mesh>
        {/* Woven Area Rug */}
        <mesh position={[0, -9.98, 0]} receiveShadow>
          <cylinderGeometry args={[19, 19, 0.08, 64]} />
          <meshStandardMaterial color="#4c382c" roughness={0.96} />
        </mesh>

        {/* Back Wall */}
        <mesh position={[0, 9, -34]} receiveShadow>
          <planeGeometry args={[90, 40]} />
          <meshStandardMaterial color="#3a2c24" roughness={0.92} />
        </mesh>
        {/* Left Wall */}
        <mesh position={[-34, 9, 0]} rotation={[0, Math.PI / 2, 0]} receiveShadow>
          <planeGeometry args={[90, 40]} />
          <meshStandardMaterial color="#322620" roughness={0.92} />
        </mesh>
        {/* Right Wall */}
        <mesh position={[34, 9, 0]} rotation={[0, -Math.PI / 2, 0]} receiveShadow>
          <planeGeometry args={[90, 40]} />
          <meshStandardMaterial color="#322620" roughness={0.92} />
        </mesh>
        {/* Front Wall */}
        <mesh position={[0, 9, 34]} rotation={[0, Math.PI, 0]} receiveShadow>
          <planeGeometry args={[90, 40]} />
          <meshStandardMaterial color="#362821" roughness={0.92} />
        </mesh>

        {/* Baseboards */}
        <mesh position={[0, -9.2, -33.7]}>
          <boxGeometry args={[70, 1.6, 0.4]} />
          <meshStandardMaterial color="#23160f" roughness={0.65} />
        </mesh>
        <mesh position={[-33.7, -9.2, 0]}>
          <boxGeometry args={[0.4, 1.6, 70]} />
          <meshStandardMaterial color="#23160f" roughness={0.65} />
        </mesh>
        <mesh position={[33.7, -9.2, 0]}>
          <boxGeometry args={[0.4, 1.6, 70]} />
          <meshStandardMaterial color="#23160f" roughness={0.65} />
        </mesh>

        {/* Framed Geometric Posters */}
        <FramedPoster
          position={[-10.5, 9.5, -33.6]}
          rotation={[0, 0, 0]}
          palette={['#e8dcc8', '#c85b3b', '#3f6251', '#d8a24a']}
          variant={0}
        />
        <FramedPoster
          position={[0, 9.5, -33.6]}
          rotation={[0, 0, 0]}
          palette={['#23303b', '#d9994a', '#e8d7be', '#b8533b']}
          variant={1}
        />
        <FramedPoster
          position={[10.5, 9.5, -33.6]}
          rotation={[0, 0, 0]}
          palette={['#dcd2c0', '#2b473e', '#d68345', '#8e3b2e']}
          variant={2}
        />
        <FramedPoster
          position={[-33.6, 9.5, -6]}
          rotation={[0, Math.PI / 2, 0]}
          palette={['#e5d8c2', '#445c4b', '#d4823e', '#26313a']}
          variant={0}
        />
        <FramedPoster
          position={[33.6, 9.5, 6]}
          rotation={[0, -Math.PI / 2, 0]}
          palette={['#2a2e35', '#e0a24b', '#87a08a', '#f0e5d1']}
          variant={2}
        />

        {/* Subtle Wooden Side Shelf on Left Wall */}
        <group position={[-32.4, 2.2, 8]}>
          <RoundedBox args={[2.2, 0.35, 11]} radius={0.06} smoothness={2} castShadow receiveShadow>
            <meshStandardMaterial color="#4e301c" roughness={0.6} />
          </RoundedBox>
          <mesh position={[0, 1.2, -2.8]} castShadow>
            <cylinderGeometry args={[0.7, 0.55, 2.1, 20]} />
            <meshStandardMaterial color="#c47a52" roughness={0.75} />
          </mesh>
          <mesh position={[0, 1.0, 2.2]} castShadow>
            <boxGeometry args={[1.2, 1.7, 0.5]} />
            <meshStandardMaterial color="#3c5a4f" roughness={0.8} />
          </mesh>
          <mesh position={[0, 0.9, 2.8]} castShadow>
            <boxGeometry args={[1.2, 1.5, 0.45]} />
            <meshStandardMaterial color="#b45a3c" roughness={0.8} />
          </mesh>
        </group>
      </group>
    </>
  );
}
