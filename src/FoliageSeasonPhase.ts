import { cellRandom, unitFromSeed } from "./Random";

/** The subset of tree geometry buffers the seasonal phase bake reads and writes. */
export interface FoliageCardBuffers {
  positions: ArrayLike<number>;
  uvs: ArrayLike<number>;
  colors: number[] | Float32Array;
}

/**
 * Visits every foliage card in geometry order. Cards are four consecutive
 * vertices whose texture coordinates all lie inside the leaf image; bark
 * quads use a shifted U range and are skipped.
 */
export function forEachFoliageCard(
  buffers: FoliageCardBuffers,
  visit: (vertexStart: number) => void,
): void {
  const vertexCount = buffers.positions.length / 3;
  for (let vertex = 0; vertex + 3 < vertexCount;) {
    let foliageCard = true;
    for (let corner = 0; corner < 4; corner++) {
      const u = buffers.uvs[(vertex + corner) * 2];
      const v = buffers.uvs[(vertex + corner) * 2 + 1];
      foliageCard &&= u >= 0 && u <= 1 && v >= 0 && v <= 1;
    }
    if (!foliageCard) {
      vertex++;
      continue;
    }
    visit(vertex);
    vertex += 4;
  }
}

/** Smooth trilinear value noise addressed by integer lattice cells. */
function valueNoise3(seed: number, x: number, y: number, z: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = smooth(x - x0), fy = smooth(y - y0), fz = smooth(z - z0);
  const corner = (dx: number, dy: number, dz: number): number => (
    cellRandom(seed, x0 + dx, y0 + dy, (z0 + dz) | 0)
  );
  const bottom = lerp(
    lerp(corner(0, 0, 0), corner(1, 0, 0), fx),
    lerp(corner(0, 1, 0), corner(1, 1, 0), fx),
    fy,
  );
  const top = lerp(
    lerp(corner(0, 0, 1), corner(1, 0, 1), fx),
    lerp(corner(0, 1, 1), corner(1, 1, 1), fx),
    fy,
  );
  return lerp(bottom, top, fz);
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/** Broad blobs spanning roughly a third of the crown decide which side turns first. */
const REGION_FREQUENCY = 2.8;
/** A finer octave breaks the blobs into branch-sized clusters. */
const CLUSTER_FREQUENCY = 6.2;
/** The sun-exposed upper crown leads the lower, shaded foliage. */
const HEIGHT_LEAD = 0.16;
/** Softens region boundaries so adjacent leaves never turn in lockstep. */
const LEAF_JITTER = 0.05;

/**
 * Writes each foliage card's seasonal turning phase into its vertex color
 * alpha. Phases are spatially coherent (nearby leaves turn together) yet
 * uniformly distributed across the crown, so a shader's season progress maps
 * linearly onto the share of turned foliage. The rest of the crown keeps
 * alpha 1, which the shaders treat as "never turns".
 *
 * Returns the number of foliage cards found.
 */
export function bakeFoliageSeasonPhase(buffers: FoliageCardBuffers, seed: number): number {
  const cardStarts: number[] = [];
  const centers: number[] = [];
  const bounds = [
    Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY,
  ];
  forEachFoliageCard(buffers, (vertexStart) => {
    cardStarts.push(vertexStart);
    for (let axis = 0; axis < 3; axis++) {
      let sum = 0;
      for (let corner = 0; corner < 4; corner++) {
        sum += buffers.positions[(vertexStart + corner) * 3 + axis];
      }
      const center = sum / 4;
      centers.push(center);
      bounds[axis] = Math.min(bounds[axis], center);
      bounds[axis + 3] = Math.max(bounds[axis + 3], center);
    }
  });
  if (cardStarts.length === 0) return 0;

  const extents = [0, 1, 2].map((axis) => Math.max(bounds[axis + 3] - bounds[axis], 1e-6));
  const regionSeed = seed ^ 0x5345_4153;
  const clusterSeed = seed ^ 0x4c45_4146;
  const raw = new Float64Array(cardStarts.length);
  for (let card = 0; card < cardStarts.length; card++) {
    const nx = (centers[card * 3] - bounds[0]) / extents[0];
    const ny = (centers[card * 3 + 1] - bounds[1]) / extents[1];
    const nz = (centers[card * 3 + 2] - bounds[2]) / extents[2];
    // Offsetting the lattice keeps the crown away from the origin cell so two
    // sister models never share a phase layout just because they share bounds.
    const region = valueNoise3(regionSeed, nx * REGION_FREQUENCY + 7.3, ny * REGION_FREQUENCY + 3.1, nz * REGION_FREQUENCY + 5.7);
    const cluster = valueNoise3(clusterSeed, nx * CLUSTER_FREQUENCY + 1.9, ny * CLUSTER_FREQUENCY + 8.4, nz * CLUSTER_FREQUENCY + 2.6);
    const jitter = unitFromSeed(seed ^ (card * 0x9e37_79b9)) - 0.5;
    raw[card] = region * (1 - 0.3 - HEIGHT_LEAD)
      + cluster * 0.3
      + (1 - ny) * HEIGHT_LEAD
      + jitter * LEAF_JITTER;
  }

  // Rank normalisation turns the arbitrary noise histogram into a uniform one.
  const order = Array.from(cardStarts.keys()).sort((left, right) => raw[left] - raw[right]);
  const denominator = Math.max(1, cardStarts.length - 1);
  for (let rank = 0; rank < order.length; rank++) {
    const phase = cardStarts.length === 1 ? 0.5 : rank / denominator;
    const vertexStart = cardStarts[order[rank]];
    for (let corner = 0; corner < 4; corner++) {
      buffers.colors[(vertexStart + corner) * 4 + 3] = phase;
    }
  }
  return cardStarts.length;
}
