import { useMemo, useRef } from 'react';
import { Html, RoundedBox, Sparkles } from '@react-three/drei';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import {
  CollisionEnterPayload,
  CuboidCollider,
  RapierRigidBody,
  RigidBody,
} from '@react-three/rapier';
import * as THREE from 'three';
import { BLOCK_HEIGHT, BLOCK_LENGTH, BLOCK_WIDTH, BlockState } from '../types';
import { getBlockTintColor, getBlockWoodMaps } from '../utils/woodTexture';

interface JengaBlockProps {
  block: BlockState;
  isDynamic: boolean;
  isHovered: boolean;
  isRemoteHovered: boolean;
  isIllegalHover: boolean;
  isActiveCommitted: boolean;
  isBeingDragged: boolean;
  isBurningActive: boolean;
  isTargetingPowerUp: boolean;
  registerBody: (blockId: number, body: RapierRigidBody | null) => void;
  onPointerOverBlock: (blockId: number, event: ThreeEvent<PointerEvent>) => void;
  onPointerOutBlock: (blockId: number) => void;
  onPointerDownBlock: (blockId: number, event: ThreeEvent<PointerEvent>) => void;
  onBlockCollision: (blockId: number, payload: CollisionEnterPayload) => void;
}

export function JengaBlock({
  block,
  isDynamic,
  isHovered,
  isRemoteHovered,
  isIllegalHover,
  isActiveCommitted,
  isBeingDragged,
  isBurningActive,
  isTargetingPowerUp,
  registerBody,
  onPointerOverBlock,
  onPointerOutBlock,
  onPointerDownBlock,
  onBlockCollision,
}: JengaBlockProps) {
  const maps = useMemo(() => getBlockWoodMaps(block.id % 6), [block.id]);
  const baseTint = useMemo(() => getBlockTintColor(block.id), [block.id]);
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);

  const isIceBlock = block.effect === 'ICE';
  const isBurnBlock = block.effect === 'BURN' || isBurningActive;
  const isMystery = Boolean(block.hasMysteryPowerUp);

  let tintColor = baseTint;
  let emissive = '#000000';
  let emissiveIntensity = 0;

  if (isIllegalHover && !isTargetingPowerUp) {
    tintColor = '#fca5a5';
    emissive = '#dc2626';
    emissiveIntensity = 0.45;
  } else if (isTargetingPowerUp && isHovered) {
    tintColor = '#ddd6fe';
    emissive = '#8b5cf6';
    emissiveIntensity = 0.6;
  } else if (isIceBlock) {
    tintColor = '#67e8f9';
    emissive = '#0284c7';
    emissiveIntensity = isHovered || isBeingDragged ? 0.65 : 0.4;
  } else if (isBurnBlock) {
    tintColor = '#fb923c';
    emissive = '#ea580c';
    emissiveIntensity = 0.55;
  } else if (isMystery) {
    tintColor = '#fde047';
    emissive = '#f59e0b';
    emissiveIntensity = isHovered || isBeingDragged ? 0.65 : 0.42;
  } else if (isBeingDragged) {
    tintColor = '#fde68a';
    emissive = '#f59e0b';
    emissiveIntensity = 0.35;
  } else if (isHovered) {
    tintColor = '#fef08a';
    emissive = '#f59e0b';
    emissiveIntensity = 0.28;
  } else if (isActiveCommitted) {
    tintColor = '#fde68a';
    emissive = '#d97706';
    emissiveIntensity = 0.22;
  } else if (isRemoteHovered) {
    tintColor = '#fed7aa';
    emissive = '#fb923c';
    emissiveIntensity = 0.2;
  }

  useFrame(({ clock }) => {
    const mat = materialRef.current;
    if (!mat) return;
    if (isBurningActive) {
      const pulse = 0.5 + 0.5 * Math.sin(clock.elapsedTime * Math.PI * 2);
      mat.color.set('#ff4520');
      mat.emissive.set('#ff0000');
      mat.emissiveIntensity = 0.35 + 0.85 * pulse;
    } else {
      mat.color.set(tintColor);
      mat.emissive.set(emissive);
      mat.emissiveIntensity = emissiveIntensity;
    }
  });

  if (block.isRemoved) {
    return null;
  }

  return (
    <RigidBody
      ref={(body) => registerBody(block.id, body)}
      name={`jenga-block-${block.id}`}
      type={isDynamic ? 'dynamic' : 'kinematicPosition'}
      position={block.position}
      quaternion={block.quaternion}
      colliders={false}
      mass={1}
      friction={isIceBlock ? 0.012 : 0.65}
      restitution={0.05}
      linearDamping={isIceBlock ? 0.03 : 0.45}
      angularDamping={isIceBlock ? 0.06 : 0.65}
      canSleep={!isIceBlock}
      ccd={true}
      onCollisionEnter={(payload) => onBlockCollision(block.id, payload)}
    >
      <CuboidCollider
        args={[BLOCK_WIDTH / 2, BLOCK_HEIGHT / 2, BLOCK_LENGTH / 2]}
        friction={isIceBlock ? 0.012 : 0.65}
        restitution={0.05}
      />

      <RoundedBox
        args={[BLOCK_WIDTH, BLOCK_HEIGHT, BLOCK_LENGTH]}
        radius={0.04}
        smoothness={3}
        castShadow
        receiveShadow
        onPointerOver={(e) => {
          e.stopPropagation();
          onPointerOverBlock(block.id, e);
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          onPointerOutBlock(block.id);
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onPointerDownBlock(block.id, e);
        }}
      >
        <meshStandardMaterial
          ref={materialRef}
          map={maps.map}
          bumpMap={maps.bumpMap}
          bumpScale={0.012}
          roughnessMap={maps.roughnessMap}
          roughness={isIceBlock ? 0.08 : 0.62}
          metalness={isIceBlock ? 0.35 : 0.03}
          color={tintColor}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
        />
      </RoundedBox>

      {isMystery && !isBeingDragged && (
        <>
          <Sparkles
            count={16}
            scale={[1.8, 0.8, 4.8]}
            size={2.8}
            speed={0.6}
            color="#fde047"
          />
          <Html position={[0, 0.36, 0]} center distanceFactor={14} zIndexRange={[10, 0]}>
            <div className="pointer-events-none flex h-6 w-6 items-center justify-center rounded-full border border-amber-300/90 bg-amber-950/90 text-xs font-black text-amber-200 shadow-md">
              ?
            </div>
          </Html>
        </>
      )}

      {isIceBlock && (
        <Sparkles
          count={12}
          scale={[1.8, 0.8, 4.8]}
          size={2.2}
          speed={0.3}
          color="#bae6fd"
        />
      )}

      {isBurnBlock && (
        <Sparkles
          count={14}
          scale={[1.8, 0.9, 4.8]}
          size={2.6}
          speed={0.8}
          color="#f97316"
        />
      )}

      {isIllegalHover && !isTargetingPowerUp && (
        <Html position={[0, 0.75, 0]} center distanceFactor={14} zIndexRange={[20, 0]}>
          <div className="pointer-events-none whitespace-nowrap rounded-lg border border-red-400/60 bg-red-950/95 px-2.5 py-1 text-xs font-semibold text-red-100 shadow-lg backdrop-blur">
            Cannot pull from top layer
          </div>
        </Html>
      )}
    </RigidBody>
  );
}
