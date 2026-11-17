export type RoomStatus = 'WAITING' | 'PLAYING' | 'SETTLING' | 'GAME_OVER';

export type GameOverReason =
  | 'TOWER_COLLAPSED'
  | 'TIMEOUT'
  | 'PLAYER_DISCONNECTED'
  | null;

export type GameMode = 'ONLINE' | 'LOCAL';

export type GameRulesMode = 'CLASSIC' | 'ELIMINATION';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type CompactBlockTuple = [
  id: number,
  x: number,
  y: number,
  z: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number
];

export interface Player {
  id: string;
  name: string;
  score: number;
  isHost: boolean;
  connected: boolean;
  eliminated?: boolean;
}

export interface BlockState {
  id: number;
  layer: number;
  slot: number;
  position: Vec3;
  quaternion: Quat;
  isRemoved: boolean;
}

export interface RoomState {
  roomId: string;
  status: RoomStatus;
  rulesMode: GameRulesMode;
  players: Player[];
  currentTurnIndex: number;
  startingPlayerIndex: number;
  turnStartedAt: number;
  turnDurationMs: number;
  settlingStartedAt: number | null;
  settlingDurationMs: number;
  activeBlockId: number | null;
  blocksMovedCount: number;
  blocks: BlockState[];
  lastStableBlocks: BlockState[];
  towerRestoreVersion: number;
  lastEliminatedPlayerId: string | null;
  lastEliminatedAt: number | null;
  winnerId: string | null;
  loserId: string | null;
  gameOverReason: GameOverReason;
  serverTimestampMs?: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  message: string;
  emoji?: string;
  system: boolean;
  timestamp: number;
}

export interface PlacementSlot {
  layer: number;
  slot: number;
  position: Vec3;
  quaternion: Quat;
}

export const BLOCK_WIDTH = 1.5;
export const BLOCK_HEIGHT = 0.5;
export const BLOCK_LENGTH = 4.5;
export const BLOCK_LATERAL_GAP = 0.015;
export const INITIAL_LAYERS = 18;
export const BLOCKS_PER_LAYER = 3;
export const TOTAL_BLOCKS = INITIAL_LAYERS * BLOCKS_PER_LAYER;

export const TURN_DURATION_MS = 45_000;
export const SETTLING_DURATION_MS = 3_000;

const EVEN_QUAT: Quat = [0, 0, 0, 1];
const ODD_QUAT: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

export function getSlotPosition(layer: number, slot: number): Vec3 {
  const step = BLOCK_WIDTH + BLOCK_LATERAL_GAP;
  const offset = (slot - 1) * step;
  const y = BLOCK_HEIGHT / 2 + layer * BLOCK_HEIGHT;
  const isOddLayer = layer % 2 === 1;
  return isOddLayer ? [0, y, offset] : [offset, y, 0];
}

export function getLayerQuaternion(layer: number): Quat {
  return layer % 2 === 1 ? [...ODD_QUAT] : [...EVEN_QUAT];
}

export function createInitialBlocks(): BlockState[] {
  const blocks: BlockState[] = [];
  for (let layer = 0; layer < INITIAL_LAYERS; layer++) {
    for (let slot = 0; slot < BLOCKS_PER_LAYER; slot++) {
      const id = layer * BLOCKS_PER_LAYER + slot;
      blocks.push({
        id,
        layer,
        slot,
        position: getSlotPosition(layer, slot),
        quaternion: getLayerQuaternion(layer),
        isRemoved: false,
      });
    }
  }
  return blocks;
}

export function cloneBlocks(blocks: BlockState[]): BlockState[] {
  return blocks.map((b) => ({
    ...b,
    position: [b.position[0], b.position[1], b.position[2]],
    quaternion: [b.quaternion[0], b.quaternion[1], b.quaternion[2], b.quaternion[3]],
  }));
}

export function sanitizeStableBlocks(
  candidateBlocks: BlockState[],
  fallbackSafeBlocks: BlockState[]
): BlockState[] {
  const fallbackMap = new Map<number, BlockState>();
  for (const fb of fallbackSafeBlocks) {
    fallbackMap.set(fb.id, fb);
  }

  const getFallbackFor = (block: BlockState): BlockState => {
    const fb = fallbackMap.get(block.id);
    if (fb) {
      return {
        ...fb,
        position: [fb.position[0], fb.position[1], fb.position[2]],
        quaternion: [
          fb.quaternion[0],
          fb.quaternion[1],
          fb.quaternion[2],
          fb.quaternion[3],
        ],
      };
    }
    return {
      ...block,
      position: getSlotPosition(block.layer, block.slot),
      quaternion: getLayerQuaternion(block.layer),
    };
  };

  let unsafeCount = 0;
  const unsafeFlags = candidateBlocks.map((b) => {
    if (b.isRemoved) return false;
    const [x, y, z] = b.position;
    const [qx, qy, qz, qw] = b.quaternion;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      !Number.isFinite(qx) ||
      !Number.isFinite(qy) ||
      !Number.isFinite(qz) ||
      !Number.isFinite(qw)
    ) {
      unsafeCount++;
      return true;
    }

    const expectedFlatY = BLOCK_HEIGHT / 2 + b.layer * BLOCK_HEIGHT;
    const isUnsafe =
      Math.abs(x) > 2.65 ||
      Math.abs(z) > 2.65 ||
      y < Math.max(0.15, expectedFlatY - 1.2) ||
      y > expectedFlatY + 1.5;

    if (isUnsafe) {
      unsafeCount++;
    }
    return isUnsafe;
  });

  if (unsafeCount > 1 && fallbackSafeBlocks.length > 0) {
    return cloneBlocks(fallbackSafeBlocks);
  }

  return candidateBlocks.map((b, idx) => {
    if (unsafeFlags[idx] && !b.isRemoved) {
      return getFallbackFor(b);
    }
    return {
      ...b,
      position: [b.position[0], b.position[1], b.position[2]],
      quaternion: [
        b.quaternion[0],
        b.quaternion[1],
        b.quaternion[2],
        b.quaternion[3],
      ],
    };
  });
}

export function getHighestOccupiedLayer(
  blocks: BlockState[],
  excludeBlockId?: number | null
): {
  highestLayer: number;
  countInHighest: number;
} {
  let highestLayer = 0;
  for (const block of blocks) {
    if (block.id === excludeBlockId || block.isRemoved) continue;
    if (block.layer > highestLayer) {
      highestLayer = block.layer;
    }
  }
  let countInHighest = 0;
  for (const block of blocks) {
    if (block.id === excludeBlockId || block.isRemoved) continue;
    if (block.layer === highestLayer) {
      countInHighest++;
    }
  }
  return { highestLayer, countInHighest };
}

export function isBlockSelectable(blocks: BlockState[], blockId: number): boolean {
  const target = blocks.find((b) => b.id === blockId);
  if (!target || target.isRemoved) {
    return false;
  }

  const { highestLayer, countInHighest } = getHighestOccupiedLayer(blocks);
  if (countInHighest < BLOCKS_PER_LAYER) {
    return target.layer < highestLayer - 1;
  }
  return target.layer < highestLayer;
}

export function getValidTopPlacements(
  blocks: BlockState[],
  movingBlockId?: number | null
): PlacementSlot[] {
  const { highestLayer, countInHighest } = getHighestOccupiedLayer(blocks, movingBlockId);
  const targetLayer = countInHighest < BLOCKS_PER_LAYER ? highestLayer : highestLayer + 1;
  const occupiedSlots = new Set(
    blocks
      .filter((b) => b.id !== movingBlockId && !b.isRemoved && b.layer === targetLayer)
      .map((b) => b.slot)
  );

  const slots: PlacementSlot[] = [];
  for (let slot = 0; slot < BLOCKS_PER_LAYER; slot++) {
    if (!occupiedSlots.has(slot)) {
      slots.push({
        layer: targetLayer,
        slot,
        position: getSlotPosition(targetLayer, slot),
        quaternion: getLayerQuaternion(targetLayer),
      });
    }
  }

  if (slots.length === 0) {
    const fallbackLayer = targetLayer + 1;
    slots.push({
      layer: fallbackLayer,
      slot: 1,
      position: getSlotPosition(fallbackLayer, 1),
      quaternion: getLayerQuaternion(fallbackLayer),
    });
  }

  return slots;
}
