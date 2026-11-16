import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Html, OrbitControls, RoundedBox } from '@react-three/drei';
import { ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { CollisionEnterPayload, Physics, RapierRigidBody } from '@react-three/rapier';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { soundEngine } from '../audio/soundEngine';
import {
  BLOCK_HEIGHT,
  BLOCK_LENGTH,
  BLOCK_WIDTH,
  BlockState,
  CompactBlockTuple,
  getValidTopPlacements,
  isBlockSelectable,
  PlacementSlot,
  Quat,
  RoomStatus,
  Vec3,
} from '../types';
import { JengaBlock } from './JengaBlock';
import { EnvironmentScene } from './EnvironmentScene';

interface JengaTowerProps {
  blocks: BlockState[];
  status: RoomStatus;
  isMyTurn: boolean;
  blocksMovedCount: number;
  activeBlockId: number | null;
  remoteHoveredBlockId: number | null;
  remoteGrabbedBlockId: number | null;
  remotePhysicsFrames: React.MutableRefObject<Map<number, { pos: THREE.Vector3; quat: THREE.Quaternion }>>;
  matchResetVersion: number;
  cameraResetTrigger: number;
  onHoverBlock: (blockId: number | null) => void;
  onGrabBlock: (blockId: number, committed: boolean) => void;
  onPlaceBlock: (
    blockId: number,
    finalTransform: { position: Vec3; quaternion: Quat },
    targetLayer: number,
    targetSlot: number
  ) => void;
  onPhysicsSync: (compactBlocks: CompactBlockTuple[]) => void;
  onCollapse: () => void;
}

type DragPhase = 'IDLE' | 'PULLING' | 'PLACING';

interface DragSession {
  blockId: number;
  phase: DragPhase;
  startBlockPos: THREE.Vector3;
  startHitPoint: THREE.Vector3;
  pullAxis: THREE.Vector3;
  dragPlane: THREE.Plane;
  committed: boolean;
  targetPlacement: PlacementSlot | null;
  alignedWithSlot: boolean;
  stagePoint: THREE.Vector3 | null;
  freePlacePos: Vec3 | null;
  yawSteps: number;
  isOnSide: boolean;
  hasCustomRotation: boolean;
  targetQuat: THREE.Quaternion;
}

const _rotMatrix = new THREE.Matrix4();

function getWorldHalfExtents(quat: THREE.Quaternion): {
  hx: number;
  hy: number;
  hz: number;
} {
  _rotMatrix.makeRotationFromQuaternion(quat);
  const e = _rotMatrix.elements;
  const hw = BLOCK_WIDTH / 2;
  const hh = BLOCK_HEIGHT / 2;
  const hl = BLOCK_LENGTH / 2;
  return {
    hx: Math.abs(e[0]) * hw + Math.abs(e[4]) * hh + Math.abs(e[8]) * hl,
    hy: Math.abs(e[1]) * hw + Math.abs(e[5]) * hh + Math.abs(e[9]) * hl,
    hz: Math.abs(e[2]) * hw + Math.abs(e[6]) * hh + Math.abs(e[10]) * hl,
  };
}

function buildPlacementQuaternion(
  yawSteps: number,
  isOnSide: boolean
): THREE.Quaternion {
  const euler = new THREE.Euler(
    0,
    yawSteps * (Math.PI / 2),
    isOnSide ? Math.PI / 2 : 0,
    'YXZ'
  );
  return new THREE.Quaternion().setFromEuler(euler);
}

interface TopBlockBox {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
}

function resolveNonOverlappingPlacement(
  desiredX: number,
  desiredZ: number,
  placedQuat: THREE.Quaternion,
  baseSlotY: number,
  nearbyBlocks: TopBlockBox[],
  allowNudge: boolean
): { x: number; y: number; z: number } {
  const { hx, hy, hz } = getWorldHalfExtents(placedQuat);
  let x = desiredX;
  let z = desiredZ;
  const gap = 0.02;

  // Separate horizontally from blocks sitting on the same top layer so blocks never overlap
  if (allowNudge) {
    const sameLayerBlocks = nearbyBlocks.filter(
      (b) => Math.abs(b.y - baseSlotY) < BLOCK_HEIGHT * 0.9
    );

    for (let pass = 0; pass < 2; pass++) {
      for (const other of sameLayerBlocks) {
        const reqX = hx + other.hx + gap;
        const reqZ = hz + other.hz + gap;
        const dx = x - other.x;
        const dz = z - other.z;
        const ox = reqX - Math.abs(dx);
        const oz = reqZ - Math.abs(dz);

        if (ox > 0 && oz > 0) {
          if (ox <= oz && ox < reqX * 0.72) {
            const signX = dx >= 0 ? 1 : -1;
            const candidateX = other.x + signX * reqX;
            if (Math.abs(candidateX) <= 2.35) {
              x = candidateX;
            }
          } else if (oz < ox && oz < reqZ * 0.72) {
            const signZ = dz >= 0 ? 1 : -1;
            const candidateZ = other.z + signZ * reqZ;
            if (Math.abs(candidateZ) <= 2.35) {
              z = candidateZ;
            }
          }
        }
      }
    }
  }

  // Compute exact support surface Y beneath (x, z) so overlapping placement stacks on top instead of clipping
  let supportSurfaceY = Math.max(0, baseSlotY - BLOCK_HEIGHT / 2);
  for (const other of nearbyBlocks) {
    const ox = hx + other.hx - Math.abs(x - other.x);
    const oz = hz + other.hz - Math.abs(z - other.z);
    if (ox > 0.06 && oz > 0.06) {
      const topY = other.y + other.hy;
      if (topY > supportSurfaceY) {
        supportSurfaceY = topY;
      }
    }
  }

  return {
    x,
    y: supportSurfaceY + hy + 0.04,
    z,
  };
}

function GhostPlacementGuides({
  slots,
  activeSlot,
  isAligned,
}: {
  slots: PlacementSlot[];
  activeSlot: PlacementSlot | null;
  isAligned: boolean;
}) {
  return (
    <group>
      {slots.map((slot) => {
        const isCurrent =
          activeSlot?.layer === slot.layer && activeSlot?.slot === slot.slot;
        const color = isCurrent && isAligned ? '#34d399' : '#fbbf24';
        const opacity = isCurrent ? (isAligned ? 0.55 : 0.34) : 0.16;

        return (
          <group
            key={`${slot.layer}-${slot.slot}`}
            position={slot.position}
            quaternion={slot.quaternion}
          >
            <RoundedBox args={[BLOCK_WIDTH, BLOCK_HEIGHT, BLOCK_LENGTH]} radius={0.04} smoothness={2}>
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={isCurrent && isAligned ? 0.65 : 0.25}
                transparent
                opacity={opacity}
                depthWrite={false}
              />
            </RoundedBox>
            {isCurrent && (
              <Html position={[0, 0.65, 0]} center distanceFactor={14} zIndexRange={[15, 0]}>
                <div
                  className={`pointer-events-none whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold shadow-md backdrop-blur ${
                    isAligned
                      ? 'border border-emerald-400/70 bg-emerald-950/90 text-emerald-100'
                      : 'border border-amber-400/60 bg-stone-900/90 text-amber-200'
                  }`}
                >
                  {isAligned ? 'Release to Place' : 'Drag Here to Stack'}
                </div>
              </Html>
            )}
          </group>
        );
      })}
    </group>
  );
}

function TowerPhysicsContent({
  blocks,
  status,
  isMyTurn,
  blocksMovedCount,
  activeBlockId,
  remoteHoveredBlockId,
  remoteGrabbedBlockId,
  remotePhysicsFrames,
  matchResetVersion,
  cameraResetTrigger,
  onHoverBlock,
  onGrabBlock,
  onPlaceBlock,
  onPhysicsSync,
  onCollapse,
}: JengaTowerProps) {
  const { camera, pointer, gl } = useThree();
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const bodyRefs = useRef<Map<number, RapierRigidBody>>(new Map());

  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const [hoveredBlockId, setHoveredBlockId] = useState<number | null>(null);
  const [dragBlockId, setDragBlockId] = useState<number | null>(null);
  const [dragPhase, setDragPhase] = useState<DragPhase>('IDLE');
  const [stashedBlockId, setStashedBlockId] = useState<number | null>(null);
  const [activeTargetSlot, setActiveTargetSlot] = useState<PlacementSlot | null>(null);
  const [isAlignedWithSlot, setIsAlignedWithSlot] = useState(false);

  const dragSessionRef = useRef<DragSession | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const collapseReportedRef = useRef(false);
  const spawnProtectionUntilRef = useRef(performance.now() + 900);
  const lastSyncSentAtRef = useRef(0);
  const prevDynamicRef = useRef(false);
  const placementDropTimeoutRef = useRef<number | null>(null);
  const stashedOrientationRef = useRef<{
    blockId: number;
    yawSteps: number;
    isOnSide: boolean;
    hasCustomRotation: boolean;
  } | null>(null);

  const tempVecA = useMemo(() => new THREE.Vector3(), []);
  const tempVecB = useMemo(() => new THREE.Vector3(), []);
  const tempQuatA = useMemo(() => new THREE.Quaternion(), []);
  const tempQuatB = useMemo(() => new THREE.Quaternion(), []);
  const defaultTarget = useMemo<[number, number, number]>(() => [0, 4.5, 0], []);

  const isLocalSimulator = isMyTurn && (status === 'PLAYING' || status === 'SETTLING');

  const validTopSlots = useMemo(
    () =>
      getValidTopPlacements(
        blocks,
        dragBlockId ?? stashedBlockId ?? activeBlockId
      ),
    [blocks, dragBlockId, stashedBlockId, activeBlockId]
  );

  useEffect(() => {
    collapseReportedRef.current = false;
    spawnProtectionUntilRef.current = performance.now() + 1000;
    dragSessionRef.current = null;
    stashedOrientationRef.current = null;
    setDragBlockId(null);
    setDragPhase('IDLE');
    setStashedBlockId(null);
    setActiveTargetSlot(null);
    setIsAlignedWithSlot(false);
    setOrbitEnabled(true);
    soundEngine.stopSlide();

    if (placementDropTimeoutRef.current !== null) {
      window.clearTimeout(placementDropTimeoutRef.current);
      placementDropTimeoutRef.current = null;
    }
  }, [matchResetVersion]);

  useEffect(() => {
    if (cameraResetTrigger === 0 || !controlsRef.current) return;
    camera.position.set(11.5, 10.5, 11.5);
    controlsRef.current.target.set(0, 4.5, 0);
    controlsRef.current.update();
  }, [camera, cameraResetTrigger]);

  // Sync rigid bodies when switching turn ownership into local dynamic simulation
  useEffect(() => {
    if (isLocalSimulator && !prevDynamicRef.current) {
      for (const block of blocks) {
        const body = bodyRefs.current.get(block.id);
        if (!body) continue;
        const remote = remotePhysicsFrames.current.get(block.id);
        const pos = remote
          ? { x: remote.pos.x, y: remote.pos.y, z: remote.pos.z }
          : { x: block.position[0], y: block.position[1], z: block.position[2] };
        const quat = remote
          ? { x: remote.quat.x, y: remote.quat.y, z: remote.quat.z, w: remote.quat.w }
          : {
              x: block.quaternion[0],
              y: block.quaternion[1],
              z: block.quaternion[2],
              w: block.quaternion[3],
            };
        body.setTranslation(pos, true);
        body.setRotation(quat, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      spawnProtectionUntilRef.current = performance.now() + 450;
    }
    prevDynamicRef.current = isLocalSimulator;
  }, [isLocalSimulator, blocks, remotePhysicsFrames]);

  const registerBody = useCallback((blockId: number, body: RapierRigidBody | null) => {
    if (body) {
      bodyRefs.current.set(blockId, body);
    } else {
      bodyRefs.current.delete(blockId);
    }
  }, []);

  const canInteractBlock = useCallback(
    (blockId: number) => {
      if (!isMyTurn || status !== 'PLAYING') return false;
      if (activeBlockId !== null && activeBlockId !== blockId) return false;
      return isBlockSelectable(blocks, blockId);
    },
    [isMyTurn, status, activeBlockId, blocks]
  );

  const triggerCollapseOnce = useCallback(() => {
    if (collapseReportedRef.current) return;
    if (status !== 'PLAYING' && status !== 'SETTLING') return;
    collapseReportedRef.current = true;
    soundEngine.playCollapse();
    onCollapse();
  }, [status, onCollapse]);

  const finishRelease = useCallback(() => {
    const session = dragSessionRef.current;
    if (!session) return;

    const body = bodyRefs.current.get(session.blockId);
    dragSessionRef.current = null;
    setOrbitEnabled(true);
    soundEngine.stopSlide();
    gl.domElement.style.cursor = 'auto';

    if (session.phase === 'PLACING' && session.targetPlacement && session.alignedWithSlot && body) {
      const slot = session.targetPlacement;
      const finalQuat = session.targetQuat.clone();
      const dropPos: Vec3 = session.freePlacePos ?? [
        slot.position[0],
        slot.position[1] + getWorldHalfExtents(finalQuat).hy - BLOCK_HEIGHT / 2 + 0.05,
        slot.position[2],
      ];
      body.setTranslation({ x: dropPos[0], y: dropPos[1], z: dropPos[2] }, true);
      body.setRotation(
        {
          x: finalQuat.x,
          y: finalQuat.y,
          z: finalQuat.z,
          w: finalQuat.w,
        },
        true
      );
      body.wakeUp();

      soundEngine.playPlace();
      stashedOrientationRef.current = null;
      setDragBlockId(null);
      setDragPhase('IDLE');
      setStashedBlockId(null);
      setActiveTargetSlot(null);
      setIsAlignedWithSlot(false);

      const resolvedLayer = Math.max(
        slot.layer,
        Math.round((dropPos[1] - BLOCK_HEIGHT / 2) / BLOCK_HEIGHT)
      );

      // Brief settle tick before emitting block:placed with current physical transform
      placementDropTimeoutRef.current = window.setTimeout(() => {
        const settledBody = bodyRefs.current.get(session.blockId);
        const t = settledBody?.translation();
        const r = settledBody?.rotation();
        onPlaceBlock(
          session.blockId,
          {
            position: t ? [t.x, t.y, t.z] : dropPos,
            quaternion: r
              ? [r.x, r.y, r.z, r.w]
              : [finalQuat.x, finalQuat.y, finalQuat.z, finalQuat.w],
          },
          resolvedLayer,
          slot.slot
        );
      }, 180);
      return;
    }

    if (session.phase === 'PLACING') {
      // Released outside the top slot: park safely outside & above the tower so user can orbit & finish stacking
      stashedOrientationRef.current = {
        blockId: session.blockId,
        yawSteps: session.yawSteps,
        isOnSide: session.isOnSide,
        hasCustomRotation: session.hasCustomRotation,
      };
      if (body && session.stagePoint) {
        const topY = (validTopSlots[0]?.position[1] ?? 9.25) + 0.85;
        const cur = body.translation();
        const radial = Math.hypot(cur.x, cur.z);
        const safeX = radial < 5.2 ? session.stagePoint.x : cur.x;
        const safeZ = radial < 5.2 ? session.stagePoint.z : cur.z;
        const safeY = Math.max(cur.y, topY);
        body.setNextKinematicTranslation({ x: safeX, y: safeY, z: safeZ });
      }
      setStashedBlockId(session.blockId);
      setDragBlockId(null);
      setDragPhase('IDLE');
      setIsAlignedWithSlot(false);
      return;
    }

    // Released during PULLING phase
    if (body) {
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    setDragBlockId(null);
    setDragPhase('IDLE');
  }, [gl.domElement, onPlaceBlock]);

  useEffect(() => {
    const onWindowPointerUp = (e: PointerEvent) => {
      if (e.button === 0 && dragSessionRef.current) {
        finishRelease();
      }
    };

    const rotateActiveSession = (mode: 'YAW' | 'SIDE') => {
      const session = dragSessionRef.current;
      if (!session || session.phase !== 'PLACING') return;
      if (mode === 'YAW') {
        session.yawSteps = (session.yawSteps + 1) % 4;
      } else {
        session.isOnSide = !session.isOnSide;
      }
      session.hasCustomRotation = true;
      session.targetQuat.copy(
        buildPlacementQuaternion(session.yawSteps, session.isOnSide)
      );
      soundEngine.playHover(true);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'r' || e.key === 'R') {
        rotateActiveSession('YAW');
      } else if (e.key === 'f' || e.key === 'F') {
        rotateActiveSession('SIDE');
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      if (dragSessionRef.current?.phase === 'PLACING') {
        e.preventDefault();
        rotateActiveSession('YAW');
      }
    };

    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
    window.addEventListener('keydown', onKeyDown);
    gl.domElement.addEventListener('contextmenu', onContextMenu);
    return () => {
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      gl.domElement.removeEventListener('contextmenu', onContextMenu);
    };
  }, [finishRelease, gl.domElement]);

  const handlePointerOver = useCallback(
    (blockId: number, _e: ThreeEvent<PointerEvent>) => {
      if (dragSessionRef.current) return;
      if (!isMyTurn || status !== 'PLAYING') return;

      setHoveredBlockId(blockId);
      const legal = canInteractBlock(blockId) || stashedBlockId === blockId;
      gl.domElement.style.cursor = legal ? 'grab' : 'not-allowed';
      soundEngine.playHover(legal);
      onHoverBlock(legal ? blockId : null);
    },
    [isMyTurn, status, canInteractBlock, stashedBlockId, gl.domElement, onHoverBlock]
  );

  const handlePointerOut = useCallback(
    (blockId: number) => {
      if (dragSessionRef.current) return;
      setHoveredBlockId((prev) => (prev === blockId ? null : prev));
      gl.domElement.style.cursor = 'auto';
      onHoverBlock(null);
    },
    [gl.domElement, onHoverBlock]
  );

  const handlePointerDown = useCallback(
    (blockId: number, e: ThreeEvent<PointerEvent>) => {
      if (e.button !== 0) return;
      if (!isMyTurn || status !== 'PLAYING') return;

      const isResumingStashed = stashedBlockId === blockId;
      if (!isResumingStashed && !canInteractBlock(blockId)) {
        soundEngine.playHover(false);
        return;
      }

      const body = bodyRefs.current.get(blockId);
      if (!body) return;

      soundEngine.unlock();
      soundEngine.playSelect();
      setOrbitEnabled(false);
      gl.domElement.style.cursor = 'grabbing';

      const t = body.translation();
      const r = body.rotation();
      const blockPos = new THREE.Vector3(t.x, t.y, t.z);
      const blockQuat = new THREE.Quaternion(r.x, r.y, r.z, r.w);

      // Longitudinal axis in world space (block length runs along local Z)
      const pullAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(blockQuat).normalize();
      const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -e.point.y);

      const initialPhase: DragPhase = isResumingStashed ? 'PLACING' : 'PULLING';
      const initialSlot = validTopSlots[0] ?? null;
      const savedOrient =
        isResumingStashed && stashedOrientationRef.current?.blockId === blockId
          ? stashedOrientationRef.current
          : null;
      const defaultYaw = initialSlot ? initialSlot.layer % 2 : 0;
      const yawSteps = savedOrient ? savedOrient.yawSteps : defaultYaw;
      const isOnSide = savedOrient ? savedOrient.isOnSide : false;
      const hasCustomRotation = savedOrient ? savedOrient.hasCustomRotation : false;

      const stageRadial = Math.hypot(blockPos.x, blockPos.z);
      const initialStagePoint = isResumingStashed
        ? new THREE.Vector3(
            stageRadial >= 5.2 ? blockPos.x : pullAxis.x * 6.2,
            blockPos.y,
            stageRadial >= 5.2 ? blockPos.z : pullAxis.z * 6.2
          )
        : null;

      dragSessionRef.current = {
        blockId,
        phase: initialPhase,
        startBlockPos: blockPos.clone(),
        startHitPoint: e.point.clone(),
        pullAxis,
        dragPlane,
        committed: activeBlockId === blockId || isResumingStashed,
        targetPlacement: initialSlot,
        alignedWithSlot: false,
        stagePoint: initialStagePoint,
        freePlacePos: null,
        yawSteps,
        isOnSide,
        hasCustomRotation,
        targetQuat: buildPlacementQuaternion(yawSteps, isOnSide),
      };

      setDragBlockId(blockId);
      setDragPhase(initialPhase);
      setActiveTargetSlot(initialSlot);
      onGrabBlock(blockId, activeBlockId === blockId || isResumingStashed);
    },
    [
      isMyTurn,
      status,
      stashedBlockId,
      canInteractBlock,
      gl.domElement,
      validTopSlots,
      activeBlockId,
      onGrabBlock,
    ]
  );

  const handleBlockCollision = useCallback(
    (blockId: number, payload: CollisionEnterPayload) => {
      const otherName = payload.other.rigidBodyObject?.name ?? '';

      // Play subtle wood clack based on velocity magnitude
      const targetBody = payload.target.rigidBody;
      if (targetBody && performance.now() > spawnProtectionUntilRef.current) {
        const v = targetBody.linvel();
        const speed = Math.hypot(v.x, v.y, v.z);
        if (speed > 0.45) {
          soundEngine.playImpact(Math.min(1, speed / 7.5));
        }
      }

      if (!isLocalSimulator) return;
      if (performance.now() < spawnProtectionUntilRef.current) return;
      if (
        dragSessionRef.current?.blockId === blockId ||
        dragBlockId === blockId ||
        stashedBlockId === blockId
      ) {
        return;
      }

      const block = blocks.find((b) => b.id === blockId);
      if (!block) return;

      const hitFloor = otherName === 'floor-catcher';
      const hitTable = otherName === 'table-surface';

      if (hitFloor || (hitTable && block.layer > 0)) {
        triggerCollapseOnce();
      }
    },
    [isLocalSimulator, dragBlockId, stashedBlockId, blocks, triggerCollapseOnce]
  );

  useFrame((state, delta) => {
    // 1. Handle active player drag & kinematic/dynamic spring projection
    const session = dragSessionRef.current;
    if (session && isLocalSimulator) {
      const body = bodyRefs.current.get(session.blockId);
      if (body) {
        body.wakeUp();
        raycasterRef.current.setFromCamera(pointer, camera);

        if (session.phase === 'PULLING') {
          const hitPoint = tempVecA;
          const intersected = raycasterRef.current.ray.intersectPlane(
            session.dragPlane,
            hitPoint
          );

          if (intersected) {
            const deltaPointer = tempVecB.copy(hitPoint).sub(session.startHitPoint);
            const axisOffset = deltaPointer.dot(session.pullAxis);
            const targetPos = session.startBlockPos
              .clone()
              .addScaledVector(session.pullAxis, axisOffset);

            const cur = body.translation();
            const curVec = new THREE.Vector3(cur.x, cur.y, cur.z);
            const posErr = targetPos.sub(curVec);

            // Spring-damped velocity along the block's longitudinal axis so neighbors react with real friction
            const axisVel = THREE.MathUtils.clamp(posErr.dot(session.pullAxis) * 14, -9.5, 9.5);
            const lateralErr = posErr
              .clone()
              .addScaledVector(session.pullAxis, -posErr.dot(session.pullAxis));

            const vx = session.pullAxis.x * axisVel + lateralErr.x * 6.5;
            const vz = session.pullAxis.z * axisVel + lateralErr.z * 6.5;
            const curVel = body.linvel();
            const vy = THREE.MathUtils.clamp(
              (session.startBlockPos.y - cur.y) * 9 + curVel.y * 0.25,
              -3.5,
              3.5
            );

            body.setLinvel({ x: vx, y: vy, z: vz }, true);
            const ang = body.angvel();
            body.setAngvel({ x: ang.x * 0.35, y: ang.y * 0.35, z: ang.z * 0.35 }, true);

            soundEngine.updateSlide(Math.abs(axisVel));

            // Commit single-block lock once slid >= 0.35 units from slot
            const pulledDist = curVec.distanceTo(session.startBlockPos);
            if (!session.committed && pulledDist >= 0.35) {
              session.committed = true;
              onGrabBlock(session.blockId, true);
            }

            // Transition to PLACING only once the entire 4.5-unit brick is pulled completely clear of the tower
            const axisDist = cur.x * session.pullAxis.x + cur.z * session.pullAxis.z;
            if (Math.abs(axisDist) > 5.35) {
              const dirSign = axisDist >= 0 ? 1 : -1;
              const lateralOffset = session.startBlockPos
                .clone()
                .addScaledVector(
                  session.pullAxis,
                  -session.startBlockPos.dot(session.pullAxis)
                );
              session.stagePoint = lateralOffset.addScaledVector(
                session.pullAxis,
                dirSign * 6.2
              );
              const targetSlot = validTopSlots[0] ?? null;
              session.phase = 'PLACING';
              session.committed = true;
              session.targetPlacement = targetSlot;
              session.yawSteps = targetSlot ? targetSlot.layer % 2 : 0;
              session.isOnSide = false;
              session.hasCustomRotation = false;
              session.targetQuat.copy(
                buildPlacementQuaternion(session.yawSteps, session.isOnSide)
              );
              setDragPhase('PLACING');
              setActiveTargetSlot(targetSlot);
              soundEngine.stopSlide();
              onGrabBlock(session.blockId, true);
            }
          }
        } else if (session.phase === 'PLACING') {
          const topSlot = validTopSlots[0] ?? session.targetPlacement;
          const baseSlotY = topSlot?.position[1] ?? 9.25;
          const topY = baseSlotY + 0.65;
          const placePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -topY);
          const hitPoint = tempVecA;
          const intersected = raycasterRef.current.ray.intersectPlane(placePlane, hitPoint);

          if (intersected) {
            // Find closest open slot on top layer
            let chosenSlot = topSlot;
            let bestDist = Infinity;
            for (const candidate of validTopSlots) {
              const d = Math.hypot(
                hitPoint.x - candidate.position[0],
                hitPoint.z - candidate.position[2]
              );
              if (d < bestDist) {
                bestDist = d;
                chosenSlot = candidate;
              }
            }

            if (chosenSlot) {
              session.targetPlacement = chosenSlot;
              setActiveTargetSlot(chosenSlot);
              if (!session.hasCustomRotation) {
                session.yawSteps = chosenSlot.layer % 2;
                session.targetQuat.copy(
                  buildPlacementQuaternion(session.yawSteps, session.isOnSide)
                );
              }
            }

            const cur = body.translation();
            const showGuides = blocksMovedCount < 5;
            const clearedTopHeight = cur.y >= topY - 0.35;
            const radialFromCenter = Math.hypot(hitPoint.x, hitPoint.z);

            const aligned = clearedTopHeight
              ? showGuides && !session.hasCustomRotation
                ? Boolean(chosenSlot && radialFromCenter < 3.4 && bestDist < 2.25)
                : Boolean(chosenSlot && radialFromCenter < 3.5)
              : false;

            session.alignedWithSlot = aligned;
            setIsAlignedWithSlot(aligned);

            let targetX: number;
            let targetZ: number;
            let targetY: number;

            if (!clearedTopHeight && session.stagePoint) {
              // Lift straight up outside the tower first before gliding over the top
              targetX = session.stagePoint.x;
              targetZ = session.stagePoint.z;
              targetY = topY + 0.55;
              session.freePlacePos = null;
            } else if (aligned && chosenSlot) {
              // Gather live boxes of existing upper-layer blocks to avoid any overlap
              const nearbyBoxes: TopBlockBox[] = [];
              for (const b of blocks) {
                if (b.id === session.blockId || b.isRemoved) continue;
                const otherBody = bodyRefs.current.get(b.id);
                if (!otherBody) continue;
                const ot = otherBody.translation();
                if (ot.y < baseSlotY - BLOCK_HEIGHT * 1.6) continue;
                const orot = otherBody.rotation();
                tempQuatB.set(orot.x, orot.y, orot.z, orot.w);
                const ext = getWorldHalfExtents(tempQuatB);
                nearbyBoxes.push({
                  x: ot.x,
                  y: ot.y,
                  z: ot.z,
                  hx: ext.hx,
                  hy: ext.hy,
                  hz: ext.hz,
                });
              }

              const desiredX =
                showGuides && !session.hasCustomRotation
                  ? chosenSlot.position[0]
                  : THREE.MathUtils.clamp(hitPoint.x, -2.3, 2.3);
              const desiredZ =
                showGuides && !session.hasCustomRotation
                  ? chosenSlot.position[2]
                  : THREE.MathUtils.clamp(hitPoint.z, -2.3, 2.3);

              const resolved = resolveNonOverlappingPlacement(
                desiredX,
                desiredZ,
                session.targetQuat,
                chosenSlot.position[1],
                nearbyBoxes,
                true
              );

              targetX = resolved.x;
              targetZ = resolved.z;
              targetY = resolved.y + 0.14;
              session.freePlacePos = [resolved.x, resolved.y, resolved.z];
            } else {
              targetX = THREE.MathUtils.clamp(hitPoint.x, -9, 9);
              targetZ = THREE.MathUtils.clamp(hitPoint.z, -9, 9);
              targetY = topY + 0.55;
              session.freePlacePos = null;
            }

            const smoothFactor = 1 - Math.exp(-16 * delta);
            const nextPos = {
              x: THREE.MathUtils.lerp(cur.x, targetX, smoothFactor),
              y: THREE.MathUtils.lerp(cur.y, targetY, smoothFactor),
              z: THREE.MathUtils.lerp(cur.z, targetZ, smoothFactor),
            };
            body.setNextKinematicTranslation(nextPos);

            const curRot = body.rotation();
            tempQuatA.set(curRot.x, curRot.y, curRot.z, curRot.w);
            tempQuatA.slerp(session.targetQuat, smoothFactor);
            body.setNextKinematicRotation({
              x: tempQuatA.x,
              y: tempQuatA.y,
              z: tempQuatA.z,
              w: tempQuatA.w,
            });
          }
        }
      }
    }

    // 2. Wake sleeping blocks slightly when tower is disturbed & check tilt/fall collapse
    if (isLocalSimulator && performance.now() > spawnProtectionUntilRef.current) {
      for (const block of blocks) {
        if (
          dragSessionRef.current?.blockId === block.id ||
          block.id === dragBlockId ||
          block.id === stashedBlockId
        ) {
          continue;
        }
        const body = bodyRefs.current.get(block.id);
        if (!body) continue;

        const t = body.translation();
        if (t.y < -0.25 || (block.layer > 0 && t.y < BLOCK_HEIGHT * 0.68)) {
          triggerCollapseOnce();
          break;
        }

        // Check severe longitudinal tilt (> ~42 deg from horizontal) indicating structural collapse;
        // keeps blocks intentionally placed sideways on their narrow edge valid.
        const r = body.rotation();
        tempQuatA.set(r.x, r.y, r.z, r.w);
        const longAxisY = Math.abs(
          tempVecB.set(0, 0, 1).applyQuaternion(tempQuatA).y
        );
        if (longAxisY > 0.67) {
          triggerCollapseOnce();
          break;
        }
      }
    }

    // 3. Stream physics transforms at ~25 Hz when active player in online match
    if (isLocalSimulator) {
      const now = state.clock.elapsedTime * 1000;
      if (now - lastSyncSentAtRef.current >= 40) {
        lastSyncSentAtRef.current = now;
        const compact: CompactBlockTuple[] = [];
        for (const block of blocks) {
          const body = bodyRefs.current.get(block.id);
          if (!body) continue;
          const t = body.translation();
          const r = body.rotation();
          compact.push([
            block.id,
            Number(t.x.toFixed(4)),
            Number(t.y.toFixed(4)),
            Number(t.z.toFixed(4)),
            Number(r.x.toFixed(4)),
            Number(r.y.toFixed(4)),
            Number(r.z.toFixed(4)),
            Number(r.w.toFixed(4)),
          ]);
        }
        if (compact.length > 0) {
          onPhysicsSync(compact);
        }
      }
    } else {
      // 4. Spectator / opponent smooth kinematic interpolation
      const interpAlpha = 1 - Math.exp(-18 * delta);
      for (const block of blocks) {
        const body = bodyRefs.current.get(block.id);
        const target = remotePhysicsFrames.current.get(block.id);
        if (!body || !target) continue;

        const curT = body.translation();
        const curR = body.rotation();
        tempVecA.set(curT.x, curT.y, curT.z).lerp(target.pos, interpAlpha);
        tempQuatA.set(curR.x, curR.y, curR.z, curR.w).slerp(target.quat, interpAlpha);

        body.setNextKinematicTranslation({
          x: tempVecA.x,
          y: tempVecA.y,
          z: tempVecA.z,
        });
        body.setNextKinematicRotation({
          x: tempQuatA.x,
          y: tempQuatA.y,
          z: tempQuatA.z,
          w: tempQuatA.w,
        });
      }
    }
  });

  return (
    <>
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enabled={orbitEnabled}
        enableDamping
        dampingFactor={0.07}
        target={defaultTarget}
        minDistance={6.5}
        maxDistance={26}
        maxPolarAngle={Math.PI * 0.485}
        minPolarAngle={0.14}
      />

      <EnvironmentScene />

      {blocks.map((block) => {
        const isHeldKinematic =
          (dragBlockId === block.id && dragPhase === 'PLACING') ||
          stashedBlockId === block.id;
        const blockDynamic = isLocalSimulator && !isHeldKinematic;
        const isHovered = hoveredBlockId === block.id && isMyTurn && status === 'PLAYING';
        const isIllegalHover =
          isHovered &&
          stashedBlockId !== block.id &&
          !canInteractBlock(block.id);
        const isLegalHover = isHovered && !isIllegalHover;

        return (
          <JengaBlock
            key={`${matchResetVersion}-${block.id}`}
            block={block}
            isDynamic={blockDynamic}
            isSensor={isHeldKinematic}
            isHovered={isLegalHover}
            isRemoteHovered={!isMyTurn && remoteHoveredBlockId === block.id}
            isIllegalHover={isIllegalHover}
            isActiveCommitted={
              activeBlockId === block.id ||
              (!isMyTurn && remoteGrabbedBlockId === block.id)
            }
            isBeingDragged={dragBlockId === block.id || stashedBlockId === block.id}
            registerBody={registerBody}
            onPointerOverBlock={handlePointerOver}
            onPointerOutBlock={handlePointerOut}
            onPointerDownBlock={handlePointerDown}
            onBlockCollision={handleBlockCollision}
          />
        );
      })}

      {blocksMovedCount < 5 &&
        (dragPhase === 'PLACING' || stashedBlockId !== null) &&
        isMyTurn &&
        status === 'PLAYING' && (
          <GhostPlacementGuides
            slots={validTopSlots}
            activeSlot={activeTargetSlot ?? validTopSlots[0] ?? null}
            isAligned={isAlignedWithSlot}
          />
        )}
    </>
  );
}

export function JengaTower(props: JengaTowerProps) {
  return (
    <Physics
      key={props.matchResetVersion}
      gravity={[0, -9.81, 0]}
      timeStep={1 / 60}
      numSolverIterations={16}
      numInternalPgsIterations={8}
    >
      <TowerPhysicsContent {...props} />
    </Physics>
  );
}
