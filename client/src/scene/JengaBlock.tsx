import { useMemo } from 'react';
import { Html, RoundedBox } from '@react-three/drei';
import { ThreeEvent } from '@react-three/fiber';
import {
  CollisionEnterPayload,
  CuboidCollider,
  RapierRigidBody,
  RigidBody,
} from '@react-three/rapier';
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
  registerBody,
  onPointerOverBlock,
  onPointerOutBlock,
  onPointerDownBlock,
  onBlockCollision,
}: JengaBlockProps) {
  const maps = useMemo(() => getBlockWoodMaps(block.id % 6), [block.id]);
  const baseTint = useMemo(() => getBlockTintColor(block.id), [block.id]);

  let tintColor = baseTint;
  let emissive = '#000000';
  let emissiveIntensity = 0;

  if (isIllegalHover) {
    tintColor = '#fca5a5';
    emissive = '#dc2626';
    emissiveIntensity = 0.45;
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

  return (
    <RigidBody
      ref={(body) => registerBody(block.id, body)}
      name={`jenga-block-${block.id}`}
      type={isDynamic ? 'dynamic' : 'kinematicPosition'}
      position={block.position}
      quaternion={block.quaternion}
      colliders={false}
      mass={1}
      friction={0.65}
      restitution={0.05}
      linearDamping={0.45}
      angularDamping={0.65}
      canSleep={true}
      ccd={true}
      onCollisionEnter={(payload) => onBlockCollision(block.id, payload)}
    >
      <CuboidCollider
        args={[BLOCK_WIDTH / 2, BLOCK_HEIGHT / 2, BLOCK_LENGTH / 2]}
        friction={0.65}
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
          map={maps.map}
          bumpMap={maps.bumpMap}
          bumpScale={0.012}
          roughnessMap={maps.roughnessMap}
          roughness={0.62}
          metalness={0.03}
          color={tintColor}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
        />
      </RoundedBox>

      {isIllegalHover && (
        <Html position={[0, 0.75, 0]} center distanceFactor={14} zIndexRange={[20, 0]}>
          <div className="pointer-events-none whitespace-nowrap rounded-lg border border-red-400/60 bg-red-950/95 px-2.5 py-1 text-xs font-semibold text-red-100 shadow-lg backdrop-blur">
            Cannot pull from top layer
          </div>
        </Html>
      )}
    </RigidBody>
  );
}
