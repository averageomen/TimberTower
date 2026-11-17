import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OrbitControls } from '@react-three/drei';
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
  PowerUpType,
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
  activeBlockId: number | null;
  powerUpTargeting: PowerUpType | null;
  burningBlockId: number | null;
  remoteHoveredBlockId: number | null;
  remoteGrabbedBlockId: number | null;
  remotePhysicsFrames: React.MutableRefObject<Map<number, { pos: THREE.Vector3; quat: THREE.Quaternion }>>;
  matchResetVersion: number;
  cameraResetTrigger: number;
  onHoverBlock: (blockId: number | null) => void;
  onGrabBlock: (blockId: number, committed: boolean) => void;
  onApplyPowerUp: (blockId: number) => void;
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
  hasClearedTop: boolean;
  smoothedTargetPos: THREE.Vector3 | null;
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

function driveBodyTowardPose(
  body: RapierRigidBody,
  targetX: number,
  targetY: number,
  targetZ: number,
  targetQuat: THREE.Quaternion,
  maxLinearSpeed = 14
): void {
  const cur = body.translation();
  const vx = THREE.MathUtils.clamp((targetX - cur.x) * 14, -maxLinearSpeed, maxLinearSpeed);
  const vy = THREE.MathUtils.clamp((targetY - cur.y) * 14, -12, 12);
  const vz = THREE.MathUtils.clamp((targetZ - cur.z) * 14, -maxLinearSpeed, maxLinearSpeed);
  body.setLinvel({ x: vx, y: vy, z: vz }, true);

  const curRot = body.rotation();
  const curQuat = new THREE.Quaternion(curRot.x, curRot.y, curRot.z, curRot.w);
  const dq = targetQuat.clone().multiply(curQuat.invert());
  if (dq.w < 0) {
    dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
  }
  const angle = 2 * Math.acos(THREE.MathUtils.clamp(dq.w, -1, 1));
  if (angle > 0.002) {
    const sinHalf = Math.sqrt(Math.max(1e-8, 1 - dq.w * dq.w));
    const speed = Math.min(12, angle * 12);
    body.setAngvel(
      {
        x: (dq.x / sinHalf) * speed,
        y: (dq.y / sinHalf) * speed,
        z: (dq.z / sinHalf) * speed,
      },
      true
    );
  } else {
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
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
  const gap = 0.06;
  const maxOffset = 2.25;
  let x = THREE.MathUtils.clamp(desiredX, -maxOffset, maxOffset);
  let z = THREE.MathUtils.clamp(desiredZ, -maxOffset, maxOffset);

  const sameLayerBlocks = nearbyBlocks.filter(
    (b) => b.y > baseSlotY - BLOCK_HEIGHT * 0.4
  );

  const hasHorizontalOverlap = (cx: number, cz: number): boolean => {
    for (const other of sameLayerBlocks) {
      const reqX = hx + other.hx + gap;
      const reqZ = hz + other.hz + gap;
      if (Math.abs(cx - other.x) < reqX && Math.abs(cz - other.z) < reqZ) {
        return true;
      }
    }
    return false;
  };

  // Find closest non-overlapping (x, z) on the current layer without iterative ping-pong
  if (allowNudge && sameLayerBlocks.length > 0 && hasHorizontalOverlap(x, z)) {
    const candidates: Array<{ x: number; z: number }> = [];

    for (const other of sameLayerBlocks) {
      const reqX = hx + other.hx + gap;
      const reqZ = hz + other.hz + gap;
      candidates.push(
        { x: other.x + reqX, z },
        { x: other.x - reqX, z },
        { x, z: other.z + reqZ },
        { x, z: other.z - reqZ }
      );
    }

    const xVals = [x, -1.5, 0, 1.5];
    const zVals = [z, -1.5, 0, 1.5];
    for (const other of sameLayerBlocks) {
      const reqX = hx + other.hx + gap;
      const reqZ = hz + other.hz + gap;
      xVals.push(other.x + reqX, other.x - reqX);
      zVals.push(other.z + reqZ, other.z - reqZ);
    }
    for (const cx of xVals) {
      for (const cz of zVals) {
        candidates.push({ x: cx, z: cz });
      }
    }

    for (let gx = -2.1; gx <= 2.11; gx += 0.525) {
      for (let gz = -2.1; gz <= 2.11; gz += 0.525) {
        candidates.push({ x: gx, z: gz });
      }
    }

    let bestDistSq = Infinity;
    let bestX = x;
    let bestZ = z;
    let found = false;

    for (const c of candidates) {
      if (Math.abs(c.x) > maxOffset || Math.abs(c.z) > maxOffset) continue;
      if (hasHorizontalOverlap(c.x, c.z)) continue;
      const distSq = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestX = c.x;
        bestZ = c.z;
        found = true;
      }
    }

    if (found) {
      x = bestX;
      z = bestZ;
    }
  }

  // Compute exact support surface Y beneath (x, z); ignore minor settling jitter on the layer below
  let supportSurfaceY = Math.max(0, baseSlotY - BLOCK_HEIGHT / 2);
  for (const other of nearbyBlocks) {
    const topY = other.y + other.hy;
    if (topY <= baseSlotY - BLOCK_HEIGHT * 0.25) continue;
    const ox = hx + other.hx - Math.abs(x - other.x);
    const oz = hz + other.hz - Math.abs(z - other.z);
    if (ox > 0.04 && oz > 0.04 && topY > supportSurfaceY) {
      supportSurfaceY = topY;
    }
  }

  return {
    x,
    y: supportSurfaceY + hy + 0.04,
    z,
  };
}

function TowerPhysicsContent({
  blocks,
  status,
  isMyTurn,
  activeBlockId,
  powerUpTargeting,
  burningBlockId,
  remoteHoveredBlockId,
  remoteGrabbedBlockId,
  remotePhysicsFrames,
  matchResetVersion,
  cameraResetTrigger,
  onHoverBlock,
  onGrabBlock,
  onApplyPowerUp,
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
  const [stashedBlockId, setStashedBlockId] = useState<number | null>(null);

  const dragSessionRef = useRef<DragSession | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const collapseReportedRef = useRef(false);
  const spawnProtectionUntilRef = useRef(performance.now() + 900);
  const lastSyncSentAtRef = useRef(0);
  const prevDynamicRef = useRef(false);
  const pendingPlacementRef = useRef<{
    blockId: number;
    layer: number;
    slot: number;
    dropPos: Vec3;
    finalQuat: THREE.Quaternion;
    releasedAt: number;
    stillSince: number | null;
  } | null>(null);
  const stashedOrientationRef = useRef<{
    blockId: number;
    yawSteps: number;
    isOnSide: boolean;
    hasCustomRotation: boolean;
    holdPos: THREE.Vector3;
    holdQuat: THREE.Quaternion;
  } | null>(null);

  const tempVecA = useMemo(() => new THREE.Vector3(), []);
  const tempVecB = useMemo(() => new THREE.Vector3(), []);
  const tempCamForward = useMemo(() => new THREE.Vector3(), []);
  const tempCamRight = useMemo(() => new THREE.Vector3(), []);
  const tempQuatA = useMemo(() => new THREE.Quaternion(), []);
  const tempQuatB = useMemo(() => new THREE.Quaternion(), []);
  const keysPressedRef = useRef<Set<string>>(new Set());
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
    spawnProtectionUntilRef.current = performance.now() + 1100;
    prevDynamicRef.current = isLocalSimulator;
    dragSessionRef.current = null;
    stashedOrientationRef.current = null;
    pendingPlacementRef.current = null;
    setDragBlockId(null);
    setStashedBlockId(null);
    setOrbitEnabled(true);
    soundEngine.stopSlide();

    for (const block of blocks) {
      const body = bodyRefs.current.get(block.id);
      if (!body) continue;
      body.setTranslation(
        { x: block.position[0], y: block.position[1], z: block.position[2] },
        true
      );
      body.setRotation(
        {
          x: block.quaternion[0],
          y: block.quaternion[1],
          z: block.quaternion[2],
          w: block.quaternion[3],
        },
        true
      );
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
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
      if (pendingPlacementRef.current !== null) return false;
      if (activeBlockId !== null && activeBlockId !== blockId) return false;
      return isBlockSelectable(blocks, blockId);
    },
    [isMyTurn, status, activeBlockId, blocks]
  );

  const triggerCollapseOnce = useCallback(() => {
    if (collapseReportedRef.current) return;
    if (status !== 'PLAYING' && status !== 'SETTLING') return;
    collapseReportedRef.current = true;
    pendingPlacementRef.current = null;
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

    if (session.phase === 'PLACING' && body) {
      const cur = body.translation();
      const radial = Math.hypot(cur.x, cur.z);
      const canPlaceNow =
        session.alignedWithSlot || (session.hasClearedTop && radial < 4.3);
      const slot = session.targetPlacement ?? validTopSlots[0] ?? null;

      if (canPlaceNow && slot) {
        const finalQuat = session.targetQuat.clone();
        const dropPos: Vec3 = session.freePlacePos ?? [
          slot.position[0],
          slot.position[1] + getWorldHalfExtents(finalQuat).hy - BLOCK_HEIGHT / 2 + 0.05,
          slot.position[2],
        ];

        // Settle straight onto the resolved non-overlapping pose on the top layer
        body.setTranslation(
          {
            x: dropPos[0],
            y: THREE.MathUtils.clamp(cur.y, dropPos[1] + 0.02, dropPos[1] + 0.12),
            z: dropPos[2],
          },
          true
        );
        body.setRotation(
          { x: finalQuat.x, y: finalQuat.y, z: finalQuat.z, w: finalQuat.w },
          true
        );
        body.setLinvel({ x: 0, y: -0.45, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        body.wakeUp();

        soundEngine.playPlace();
        stashedOrientationRef.current = null;
        setDragBlockId(null);
        setStashedBlockId(null);

        const resolvedLayer = Math.max(
          slot.layer,
          Math.round((dropPos[1] - BLOCK_HEIGHT / 2) / BLOCK_HEIGHT)
        );

        // Wait until the placed block stops moving before starting the 3s SETTLING timer
        pendingPlacementRef.current = {
          blockId: session.blockId,
          layer: resolvedLayer,
          slot: slot.slot,
          dropPos,
          finalQuat,
          releasedAt: performance.now(),
          stillSince: null,
        };
        return;
      }
    }

    if (session.phase === 'PLACING') {
      // Released outside the top slot: hold safely in mid-air outside the tower via solid dynamic spring
      const topY = (validTopSlots[0]?.position[1] ?? 9.25) + 0.85;
      const cur = body?.translation();
      const curX = cur?.x ?? session.stagePoint?.x ?? 6.2;
      const curY = cur?.y ?? topY;
      const curZ = cur?.z ?? session.stagePoint?.z ?? 0;
      const radial = Math.hypot(curX, curZ);
      const safeX = radial < 5.2 && session.stagePoint ? session.stagePoint.x : curX;
      const safeZ = radial < 5.2 && session.stagePoint ? session.stagePoint.z : curZ;
      const safeY = Math.max(curY, topY);

      stashedOrientationRef.current = {
        blockId: session.blockId,
        yawSteps: session.yawSteps,
        isOnSide: session.isOnSide,
        hasCustomRotation: session.hasCustomRotation,
        holdPos: new THREE.Vector3(safeX, safeY, safeZ),
        holdQuat: session.targetQuat.clone(),
      };
      setStashedBlockId(session.blockId);
      setDragBlockId(null);
      return;
    }

    // Released during PULLING phase
    if (body) {
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    setDragBlockId(null);
  }, [gl.domElement, onPlaceBlock, validTopSlots]);

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
      const lower = e.key.toLowerCase();
      if (lower === 'w' || lower === 'a' || lower === 's' || lower === 'd') {
        keysPressedRef.current.add(lower);
      } else if (lower === 'r') {
        rotateActiveSession('YAW');
      } else if (lower === 'f') {
        rotateActiveSession('SIDE');
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysPressedRef.current.delete(e.key.toLowerCase());
    };

    const onWindowBlur = () => {
      keysPressedRef.current.clear();
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (dragSessionRef.current?.phase === 'PLACING') {
        rotateActiveSession('YAW');
      }
    };

    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);
    gl.domElement.addEventListener('contextmenu', onContextMenu);
    return () => {
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
      gl.domElement.removeEventListener('contextmenu', onContextMenu);
    };
  }, [finishRelease, gl.domElement]);

  const handlePointerOver = useCallback(
    (blockId: number, _e: ThreeEvent<PointerEvent>) => {
      if (dragSessionRef.current) return;
      if (!isMyTurn || status !== 'PLAYING') return;

      setHoveredBlockId(blockId);
      if (powerUpTargeting) {
        gl.domElement.style.cursor = 'crosshair';
        soundEngine.playHover(true);
        onHoverBlock(blockId);
        return;
      }

      const legal = canInteractBlock(blockId) || stashedBlockId === blockId;
      gl.domElement.style.cursor = legal ? 'grab' : 'not-allowed';
      soundEngine.playHover(legal);
      onHoverBlock(legal ? blockId : null);
    },
    [isMyTurn, status, powerUpTargeting, canInteractBlock, stashedBlockId, gl.domElement, onHoverBlock]
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

      if (powerUpTargeting) {
        soundEngine.unlock();
        soundEngine.playSelect();
        onApplyPowerUp(blockId);
        gl.domElement.style.cursor = 'auto';
        return;
      }

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
        hasClearedTop: isResumingStashed,
        smoothedTargetPos: null,
        stagePoint: initialStagePoint,
        freePlacePos: null,
        yawSteps,
        isOnSide,
        hasCustomRotation,
        targetQuat: buildPlacementQuaternion(yawSteps, isOnSide),
      };

      setDragBlockId(blockId);
      onGrabBlock(blockId, activeBlockId === blockId || isResumingStashed);
    },
    [
      isMyTurn,
      status,
      powerUpTargeting,
      stashedBlockId,
      canInteractBlock,
      gl.domElement,
      validTopSlots,
      activeBlockId,
      onGrabBlock,
      onApplyPowerUp,
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
              session.hasClearedTop = false;
              session.smoothedTargetPos = null;
              session.targetQuat.copy(
                buildPlacementQuaternion(session.yawSteps, session.isOnSide)
              );
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
              if (!session.hasCustomRotation) {
                session.yawSteps = chosenSlot.layer % 2;
                session.targetQuat.copy(
                  buildPlacementQuaternion(session.yawSteps, session.isOnSide)
                );
              }
            }

            const cur = body.translation();
            const radial = Math.hypot(cur.x, cur.z);
            const radialFromCenter = Math.hypot(hitPoint.x, hitPoint.z);

            // Latch top clearance once lifted cleanly so hovering never oscillates up/down
            if (!session.hasClearedTop && (cur.y >= baseSlotY - 0.15 || radial <= 4.0)) {
              session.hasClearedTop = true;
            }

            const aligned =
              session.hasClearedTop && Boolean(chosenSlot && radialFromCenter < 4.2);

            session.alignedWithSlot = aligned;

            let targetX: number;
            let targetZ: number;
            let targetY: number;

            if (!session.hasClearedTop && radial > 3.6 && session.stagePoint) {
              // Lift straight up outside the tower in open air before moving inward over the top
              targetX = session.stagePoint.x;
              targetZ = session.stagePoint.z;
              targetY = topY + 0.65;
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

              const desiredX = THREE.MathUtils.clamp(hitPoint.x, -2.25, 2.25);
              const desiredZ = THREE.MathUtils.clamp(hitPoint.z, -2.25, 2.25);

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
              targetY = resolved.y + 0.36;
              session.freePlacePos = [resolved.x, resolved.y, resolved.z];
            } else {
              targetX = THREE.MathUtils.clamp(hitPoint.x, -9, 9);
              targetZ = THREE.MathUtils.clamp(hitPoint.z, -9, 9);
              targetY = topY + 0.65;
              session.freePlacePos = null;
            }

            if (!session.smoothedTargetPos) {
              session.smoothedTargetPos = new THREE.Vector3(targetX, targetY, targetZ);
            } else {
              const smoothAlpha = 1 - Math.exp(-26 * Math.min(delta, 0.05));
              session.smoothedTargetPos.lerp(
                tempVecB.set(targetX, targetY, targetZ),
                smoothAlpha
              );
            }

            driveBodyTowardPose(
              body,
              session.smoothedTargetPos.x,
              session.smoothedTargetPos.y,
              session.smoothedTargetPos.z,
              session.targetQuat,
              14
            );
          }
        }
      }
    } else if (
      stashedBlockId !== null &&
      isLocalSimulator &&
      stashedOrientationRef.current?.blockId === stashedBlockId
    ) {
      // Keep stashed dynamic solid brick suspended safely outside the tower while orbiting
      const stashedBody = bodyRefs.current.get(stashedBlockId);
      if (stashedBody) {
        stashedBody.wakeUp();
        const hold = stashedOrientationRef.current;
        driveBodyTowardPose(
          stashedBody,
          hold.holdPos.x,
          hold.holdPos.y,
          hold.holdPos.z,
          hold.holdQuat,
          10
        );
      }
    }

    // 1b. Start settling timer only once placed block is standing still or nearly standing still
    const pending = pendingPlacementRef.current;
    if (isLocalSimulator && status === 'PLAYING' && pending) {
      const placedBody = bodyRefs.current.get(pending.blockId);
      const nowMs = performance.now();
      if (placedBody && nowMs - pending.releasedAt >= 140) {
        const v = placedBody.linvel();
        const w = placedBody.angvel();
        const linSpeed = Math.hypot(v.x, v.y, v.z);
        const angSpeed = Math.hypot(w.x, w.y, w.z);

        if (linSpeed < 0.08 && angSpeed < 0.14) {
          if (pending.stillSince === null) {
            pending.stillSince = nowMs;
          } else if (nowMs - pending.stillSince >= 160) {
            const t = placedBody.translation();
            const r = placedBody.rotation();
            pendingPlacementRef.current = null;
            onPlaceBlock(
              pending.blockId,
              {
                position: [t.x, t.y, t.z],
                quaternion: [r.x, r.y, r.z, r.w],
              },
              pending.layer,
              pending.slot
            );
          }
        } else {
          pending.stillSince = null;
        }
      }
    }

    // 2. Wake sleeping blocks slightly when tower is disturbed & check fall collapse
    if (isLocalSimulator && performance.now() > spawnProtectionUntilRef.current) {
      // Amplify horizontal slip for blocks resting on an Ice Block
      for (const iceBlock of blocks) {
        if (iceBlock.isRemoved || iceBlock.effect !== 'ICE') continue;
        const iceBody = bodyRefs.current.get(iceBlock.id);
        if (!iceBody) continue;
        const iceT = iceBody.translation();
        const iceR = iceBody.rotation();
        tempQuatA.set(iceR.x, iceR.y, iceR.z, iceR.w);
        const iceExt = getWorldHalfExtents(tempQuatA);

        for (const other of blocks) {
          if (
            other.id === iceBlock.id ||
            other.isRemoved ||
            dragSessionRef.current?.blockId === other.id
          ) {
            continue;
          }
          const otherBody = bodyRefs.current.get(other.id);
          if (!otherBody) continue;
          const otherT = otherBody.translation();
          const otherR = otherBody.rotation();
          tempQuatB.set(otherR.x, otherR.y, otherR.z, otherR.w);
          const otherExt = getWorldHalfExtents(tempQuatB);

          if (Math.abs(otherT.y - (iceT.y + iceExt.hy + otherExt.hy)) >= 0.28) {
            continue;
          }
          const ox = iceExt.hx + otherExt.hx - Math.abs(otherT.x - iceT.x);
          const oz = iceExt.hz + otherExt.hz - Math.abs(otherT.z - iceT.z);
          if (ox > 0 && oz > 0) {
            const ov = otherBody.linvel();
            const speed = Math.hypot(ov.x, ov.z);
            if (speed > 0.02 && speed < 4) {
              otherBody.wakeUp();
              otherBody.setLinvel({ x: ov.x * 1.06, y: ov.y, z: ov.z * 1.06 }, true);
            }
          }
        }
      }

      for (const block of blocks) {
        if (
          block.isRemoved ||
          dragSessionRef.current?.blockId === block.id ||
          block.id === dragBlockId ||
          block.id === stashedBlockId
        ) {
          continue;
        }
        const body = bodyRefs.current.get(block.id);
        if (!body) continue;

        const t = body.translation();
        const nominalY = BLOCK_HEIGHT / 2 + block.layer * BLOCK_HEIGHT;
        const radial = Math.hypot(t.x, t.z);
        if (
          t.y < -0.25 ||
          (block.layer > 0 && t.y < BLOCK_HEIGHT * 0.68) ||
          (radial > 2.8 && t.y < nominalY - 1.6)
        ) {
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

    // 5. WASD camera movement & strict room bounds
    const controls = controlsRef.current;
    if (controls) {
      const keys = keysPressedRef.current;
      const forwardInput = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
      const strafeInput = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);

      if (forwardInput !== 0 || strafeInput !== 0) {
        camera.getWorldDirection(tempCamForward);
        tempCamForward.y = 0;
        if (tempCamForward.lengthSq() > 1e-6) {
          tempCamForward.normalize();
        } else {
          tempCamForward.set(0, 0, -1);
        }
        tempCamRight.set(-tempCamForward.z, 0, tempCamForward.x);

        const dx = tempCamForward.x * forwardInput + tempCamRight.x * strafeInput;
        const dz = tempCamForward.z * forwardInput + tempCamRight.z * strafeInput;
        const len = Math.hypot(dx, dz);

        if (len > 1e-6) {
          const step = 14 * Math.min(delta, 0.05);
          const moveX = (dx / len) * step;
          const moveZ = (dz / len) * step;

          const minMoveX = Math.max(-29.5 - camera.position.x, -18 - controls.target.x);
          const maxMoveX = Math.min(29.5 - camera.position.x, 18 - controls.target.x);
          const clampedMoveX =
            minMoveX <= maxMoveX
              ? THREE.MathUtils.clamp(moveX, minMoveX, maxMoveX)
              : 0;

          const minMoveZ = Math.max(-29.5 - camera.position.z, -18 - controls.target.z);
          const maxMoveZ = Math.min(29.5 - camera.position.z, 18 - controls.target.z);
          const clampedMoveZ =
            minMoveZ <= maxMoveZ
              ? THREE.MathUtils.clamp(moveZ, minMoveZ, maxMoveZ)
              : 0;

          camera.position.x += clampedMoveX;
          camera.position.z += clampedMoveZ;
          controls.target.x += clampedMoveX;
          controls.target.z += clampedMoveZ;
        }
      }

      controls.target.x = THREE.MathUtils.clamp(controls.target.x, -18, 18);
      controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0.5, 16);
      controls.target.z = THREE.MathUtils.clamp(controls.target.z, -18, 18);

      camera.position.x = THREE.MathUtils.clamp(camera.position.x, -29.5, 29.5);
      camera.position.y = THREE.MathUtils.clamp(camera.position.y, 0.6, 22);
      camera.position.z = THREE.MathUtils.clamp(camera.position.z, -29.5, 29.5);
    }
  });

  return (
    <>
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enabled={orbitEnabled}
        enablePan={false}
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY }}
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
        const isHovered = hoveredBlockId === block.id && isMyTurn && status === 'PLAYING';
        const isTargeting = Boolean(powerUpTargeting && isMyTurn && status === 'PLAYING');
        const isIllegalHover =
          !isTargeting &&
          isHovered &&
          stashedBlockId !== block.id &&
          !canInteractBlock(block.id);
        const isLegalHover = isHovered && !isIllegalHover;

        return (
          <JengaBlock
            key={`${matchResetVersion}-${block.id}`}
            block={block}
            isDynamic={isLocalSimulator}
            isHovered={isLegalHover}
            isRemoteHovered={!isMyTurn && remoteHoveredBlockId === block.id}
            isIllegalHover={isIllegalHover}
            isActiveCommitted={
              activeBlockId === block.id ||
              (!isMyTurn && remoteGrabbedBlockId === block.id)
            }
            isBeingDragged={dragBlockId === block.id || stashedBlockId === block.id}
            isBurningActive={burningBlockId === block.id}
            isTargetingPowerUp={isTargeting}
            registerBody={registerBody}
            onPointerOverBlock={handlePointerOver}
            onPointerOutBlock={handlePointerOut}
            onPointerDownBlock={handlePointerDown}
            onBlockCollision={handleBlockCollision}
          />
        );
      })}
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
