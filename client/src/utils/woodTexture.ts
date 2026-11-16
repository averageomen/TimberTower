import * as THREE from 'three';

export interface WoodMaterialMaps {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

const blockMapsCache = new Map<number, WoodMaterialMaps>();
let tableMapsCache: WoodMaterialMaps | null = null;

function createSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function generateWoodMaps(
  seed: number,
  baseHue: number,
  baseSat: number,
  baseLight: number,
  grainDensity: number,
  repeatX: number,
  repeatY: number
): WoodMaterialMaps {
  const width = 512;
  const height = 512;
  const rng = createSeededRng(seed);

  const diffuseCanvas = document.createElement('canvas');
  diffuseCanvas.width = width;
  diffuseCanvas.height = height;
  const dCtx = diffuseCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = width;
  bumpCanvas.height = height;
  const bCtx = bumpCanvas.getContext('2d')!;

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = width;
  roughCanvas.height = height;
  const rCtx = roughCanvas.getContext('2d')!;

  dCtx.fillStyle = `hsl(${baseHue}, ${baseSat}%, ${baseLight}%)`;
  dCtx.fillRect(0, 0, width, height);

  bCtx.fillStyle = 'rgb(128, 128, 128)';
  bCtx.fillRect(0, 0, width, height);

  rCtx.fillStyle = 'rgb(155, 155, 155)';
  rCtx.fillRect(0, 0, width, height);

  // Subtle growth-ring bands along the length of the plank
  for (let i = 0; i < grainDensity; i++) {
    const yBase = rng() * height;
    const thickness = 1 + rng() * 3.5;
    const lightDelta = (rng() - 0.52) * 14;
    const satDelta = (rng() - 0.5) * 8;
    const alpha = 0.14 + rng() * 0.24;

    dCtx.strokeStyle = `hsla(${baseHue + (rng() - 0.5) * 4}, ${Math.min(
      85,
      Math.max(15, baseSat + satDelta)
    )}%, ${Math.min(88, Math.max(12, baseLight + lightDelta))}%, ${alpha})`;
    dCtx.lineWidth = thickness;

    const bumpShade = Math.round(118 + lightDelta * 1.4);
    bCtx.strokeStyle = `rgba(${bumpShade}, ${bumpShade}, ${bumpShade}, ${alpha * 0.9})`;
    bCtx.lineWidth = thickness;

    const roughShade = Math.round(145 - lightDelta * 1.1);
    rCtx.strokeStyle = `rgba(${roughShade}, ${roughShade}, ${roughShade}, ${alpha * 0.85})`;
    rCtx.lineWidth = thickness;

    const waveAmp = 2 + rng() * 8;
    const waveFreq = 0.008 + rng() * 0.015;
    const phase = rng() * Math.PI * 2;

    const tracePath = (ctx: CanvasRenderingContext2D) => {
      ctx.beginPath();
      for (let x = 0; x <= width; x += 16) {
        const y = yBase + Math.sin(x * waveFreq + phase) * waveAmp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    tracePath(dCtx);
    tracePath(bCtx);
    tracePath(rCtx);
  }

  // Fine wood pores
  for (let i = 0; i < 420; i++) {
    const x = rng() * width;
    const y = rng() * height;
    const len = 8 + rng() * 28;
    const shade = rng() > 0.5 ? 'rgba(65, 38, 16, 0.11)' : 'rgba(255, 232, 198, 0.09)';
    dCtx.fillStyle = shade;
    dCtx.fillRect(x, y, len, 1.1);

    bCtx.fillStyle = 'rgba(95, 95, 95, 0.16)';
    bCtx.fillRect(x, y, len, 1);
  }

  const configureTexture = (
    canvas: HTMLCanvasElement,
    isColor: boolean
  ): THREE.CanvasTexture => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    texture.anisotropy = 8;
    if (isColor) {
      texture.colorSpace = THREE.SRGBColorSpace;
    }
    texture.needsUpdate = true;
    return texture;
  };

  return {
    map: configureTexture(diffuseCanvas, true),
    bumpMap: configureTexture(bumpCanvas, false),
    roughnessMap: configureTexture(roughCanvas, false),
  };
}

export function getBlockWoodMaps(variantIndex: number): WoodMaterialMaps {
  const safeVariant = ((variantIndex % 6) + 6) % 6;
  const cached = blockMapsCache.get(safeVariant);
  if (cached) return cached;

  const palette = [
    { hue: 33, sat: 54, light: 69 },
    { hue: 30, sat: 50, light: 64 },
    { hue: 35, sat: 58, light: 72 },
    { hue: 28, sat: 46, light: 61 },
    { hue: 34, sat: 52, light: 67 },
    { hue: 31, sat: 55, light: 66 },
  ][safeVariant];

  const maps = generateWoodMaps(
    1337 + safeVariant * 97,
    palette.hue,
    palette.sat,
    palette.light,
    115,
    1,
    1
  );
  blockMapsCache.set(safeVariant, maps);
  return maps;
}

export function getTableWoodMaps(): WoodMaterialMaps {
  if (tableMapsCache) return tableMapsCache;
  tableMapsCache = generateWoodMaps(9001, 24, 42, 26, 150, 2, 2);
  return tableMapsCache;
}

export function getBlockTintColor(blockId: number): string {
  const rng = createSeededRng(4200 + blockId * 31);
  const hue = (33 + (rng() - 0.5) * 6) / 360;
  const sat = (18 + rng() * 12) / 100;
  const light = (92 + (rng() - 0.5) * 10) / 100;
  return `#${new THREE.Color().setHSL(hue, sat, light).getHexString()}`;
}
