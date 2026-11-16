export type RoomStatus = 'WAITING' | 'PLAYING' | 'SETTLING' | 'GAME_OVER';

export type GameOverReason =
  | 'TOWER_COLLAPSED'
  | 'TIMEOUT'
  | 'PLAYER_DISCONNECTED'
  | null;

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
  winnerId: string | null;
  loserId: string | null;
  gameOverReason: GameOverReason;
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

export const BLOCK_WIDTH = 1.5;
export const BLOCK_HEIGHT = 0.5;
export const BLOCK_LENGTH = 4.5;
export const BLOCK_LATERAL_GAP = 0.015;
export const INITIAL_LAYERS = 18;
export const BLOCKS_PER_LAYER = 3;
export const TOTAL_BLOCKS = INITIAL_LAYERS * BLOCKS_PER_LAYER;

export const TURN_DURATION_MS = 45_000;
export const SETTLING_DURATION_MS = 3_000;
export const DISCONNECT_GRACE_MS = 12_000;
export const MAX_PLAYERS_PER_ROOM = 6;

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

export function getHighestOccupiedLayer(blocks: BlockState[]): {
  highestLayer: number;
  countInHighest: number;
} {
  let highestLayer = 0;
  for (const block of blocks) {
    if (!block.isRemoved && block.layer > highestLayer) {
      highestLayer = block.layer;
    }
  }
  let countInHighest = 0;
  for (const block of blocks) {
    if (!block.isRemoved && block.layer === highestLayer) {
      countInHighest++;
    }
  }
  return { highestLayer, countInHighest };
}

/**
 * Official Jenga rule:
 * Players may only take a block from any layer below the highest completed 3-block layer.
 * If the top layer has fewer than 3 blocks (incomplete), both that layer and the layer
 * directly beneath it are off-limits.
 */
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

export function getNextTopPlacement(blocks: BlockState[]): {
  layer: number;
  slot: number;
  position: Vec3;
  quaternion: Quat;
} {
  const { highestLayer, countInHighest } = getHighestOccupiedLayer(blocks);
  const targetLayer = countInHighest < BLOCKS_PER_LAYER ? highestLayer : highestLayer + 1;
  const occupiedSlots = new Set(
    blocks
      .filter((b) => !b.isRemoved && b.layer === targetLayer)
      .map((b) => b.slot)
  );

  let targetSlot = 0;
  for (let s = 0; s < BLOCKS_PER_LAYER; s++) {
    if (!occupiedSlots.has(s)) {
      targetSlot = s;
      break;
    }
  }

  return {
    layer: targetLayer,
    slot: targetSlot,
    position: getSlotPosition(targetLayer, targetSlot),
    quaternion: getLayerQuaternion(targetLayer),
  };
}
