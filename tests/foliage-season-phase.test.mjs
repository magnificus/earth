import assert from "node:assert/strict";
import test from "node:test";
import { bakeFoliageSeasonPhase, forEachFoliageCard } from "../src/FoliageSeasonPhase.ts";

/** A crown of leaf cards on a jittered lattice inside a sphere, plus one bark quad. */
function crown(seed = 1, radius = 1.2, step = 0.16) {
  const buffers = { positions: [], uvs: [], colors: [] };
  const centers = [];
  let hash = seed;
  const random = () => {
    hash = (hash * 1664525 + 1013904223) >>> 0;
    return hash / 4294967296;
  };
  const addQuad = (x, y, z, uvs) => {
    for (const [dx, dy] of [[-0.05, -0.05], [0.05, -0.05], [0.05, 0.05], [-0.05, 0.05]]) {
      buffers.positions.push(x + dx, y + dy, z);
      buffers.colors.push(0.3, 0.6, 0.2, 1);
    }
    buffers.uvs.push(...uvs);
  };
  addQuad(0, -1.5, 0, [2, 0, 3, 0, 3, 1, 2, 1]);
  for (let x = -radius; x <= radius; x += step) {
    for (let y = -radius; y <= radius; y += step) {
      for (let z = -radius; z <= radius; z += step) {
        if (Math.hypot(x, y, z) > radius) continue;
        const center = [x + (random() - 0.5) * step * 0.5, y + (random() - 0.5) * step * 0.5, z];
        centers.push(center);
        addQuad(center[0], center[1], center[2], [0, 1, 1, 1, 1, 0, 0, 0]);
      }
    }
  }
  return { buffers, centers };
}

function phaseOfCard(buffers, card) {
  // The bark quad occupies the first four vertices.
  return buffers.colors[(4 + card * 4) * 4 + 3];
}

test("foliage cards are visited in order and bark quads are skipped", () => {
  const { buffers, centers } = crown();
  const starts = [];
  forEachFoliageCard(buffers, (vertexStart) => starts.push(vertexStart));
  assert.equal(starts.length, centers.length);
  assert.equal(starts[0], 4);
  assert.ok(starts.every((start, index) => index === 0 || start === starts[index - 1] + 4));
});

test("phases are uniform over the crown, leave bark alone and cover all four corners", () => {
  const { buffers, centers } = crown();
  assert.equal(bakeFoliageSeasonPhase(buffers, 7), centers.length);
  for (let corner = 0; corner < 4; corner++) assert.equal(buffers.colors[corner * 4 + 3], 1);

  const phases = centers.map((_, card) => phaseOfCard(buffers, card));
  const sorted = [...phases].sort((left, right) => left - right);
  assert.equal(sorted[0], 0);
  assert.equal(sorted[sorted.length - 1], 1);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(Math.abs(median - 0.5) < 0.02, `median ${median}`);
  const quarter = sorted[Math.floor(sorted.length / 4)];
  assert.ok(Math.abs(quarter - 0.25) < 0.02, `quartile ${quarter}`);
  for (let card = 0; card < centers.length; card++) {
    const first = buffers.colors[(4 + card * 4) * 4 + 3];
    for (let corner = 1; corner < 4; corner++) {
      assert.equal(buffers.colors[(4 + card * 4 + corner) * 4 + 3], first);
    }
    // Leaf colour itself is untouched; only alpha carries the phase.
    assert.deepEqual(buffers.colors.slice((4 + card * 4) * 4, (4 + card * 4) * 4 + 3), [0.3, 0.6, 0.2]);
  }
});

test("neighbouring leaves turn together while distant leaves are unrelated", () => {
  const { buffers, centers } = crown();
  bakeFoliageSeasonPhase(buffers, 11);
  const phases = centers.map((_, card) => phaseOfCard(buffers, card));

  let neighbourDifference = 0;
  let neighbourPairs = 0;
  let distantDifference = 0;
  let distantPairs = 0;
  for (let a = 0; a < centers.length; a++) {
    for (let b = a + 1; b < centers.length; b += 7) {
      const distance = Math.hypot(
        centers[a][0] - centers[b][0],
        centers[a][1] - centers[b][1],
        centers[a][2] - centers[b][2],
      );
      const difference = Math.abs(phases[a] - phases[b]);
      if (distance < 0.2) {
        neighbourDifference += difference;
        neighbourPairs++;
      } else if (distance > 1.2) {
        distantDifference += difference;
        distantPairs++;
      }
    }
  }
  const neighbourMean = neighbourDifference / neighbourPairs;
  const distantMean = distantDifference / distantPairs;
  // Uniform, unrelated phases differ by 1/3 on average. Coherent regions must
  // keep adjacent leaves far closer than that without becoming identical.
  assert.ok(neighbourPairs > 50 && distantPairs > 50);
  assert.ok(neighbourMean < 0.12, `neighbour mean difference ${neighbourMean}`);
  assert.ok(distantMean > 0.25, `distant mean difference ${distantMean}`);
  assert.ok(neighbourMean > 0.01, "adjacent leaves still differ slightly");
});

test("the upper crown leads and different seeds lay out different regions", () => {
  const upper = crown();
  bakeFoliageSeasonPhase(upper.buffers, 3);
  let topSum = 0, topCount = 0, bottomSum = 0, bottomCount = 0;
  upper.centers.forEach((center, card) => {
    const phase = phaseOfCard(upper.buffers, card);
    if (center[1] > 0.6) { topSum += phase; topCount++; }
    if (center[1] < -0.6) { bottomSum += phase; bottomCount++; }
  });
  assert.ok(topSum / topCount < bottomSum / bottomCount, "top turns before bottom on average");

  const other = crown();
  bakeFoliageSeasonPhase(other.buffers, 4);
  let differing = 0;
  for (let card = 0; card < upper.centers.length; card++) {
    if (Math.abs(phaseOfCard(upper.buffers, card) - phaseOfCard(other.buffers, card)) > 0.1) differing++;
  }
  assert.ok(differing > upper.centers.length / 2, "seeds change the region layout");

  const repeat = crown();
  bakeFoliageSeasonPhase(repeat.buffers, 3);
  assert.deepEqual(repeat.buffers.colors, upper.buffers.colors);
});

test("empty and single-card geometry are handled", () => {
  assert.equal(bakeFoliageSeasonPhase({ positions: [], uvs: [], colors: [] }, 1), 0);
  const single = { positions: [], uvs: [], colors: [] };
  for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    single.positions.push(x, y, 0);
    single.colors.push(1, 1, 1, 1);
  }
  single.uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
  assert.equal(bakeFoliageSeasonPhase(single, 1), 1);
  assert.equal(single.colors[3], 0.5);
});
