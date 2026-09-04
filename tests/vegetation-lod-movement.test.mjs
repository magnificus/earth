import assert from "node:assert/strict";
import test from "node:test";
import { Matrix, Vector3 } from "@babylonjs/core";

// node's type stripping cannot resolve without this hook.
const { createVegetationFieldResult } = await import("../src/VegetationField.ts");

/**
 * Emulates Babylon's thin-instance buffer API closely enough to observe what
 * the GPU would draw: full uploads via thinInstanceBufferUpdated and ranged
 * uploads via thinInstancePartialBufferUpdate (offsets in floats).
 */
function createMeshStub(name) {
  const cpuBuffers = new Map();
  const gpuBuffers = new Map();
  return {
    name,
    thinInstanceCount: 0,
    enabled: true,
    alwaysSelectAsActiveMesh: false,
    partialUpdateCalls: 0,
    thinInstanceSetBuffer(kind, buffer) {
      cpuBuffers.set(kind, buffer);
      gpuBuffers.set(kind, buffer.slice());
    },
    thinInstanceRefreshBoundingInfo() {},
    freezeWorldMatrix() {},
    setEnabled(enabled) { this.enabled = enabled; },
    thinInstanceBufferUpdated(kind) {
      const cpu = cpuBuffers.get(kind);
      if (cpu) gpuBuffers.get(kind).set(cpu);
    },
    thinInstancePartialBufferUpdate(kind, data, offset) {
      this.partialUpdateCalls++;
      const gpu = gpuBuffers.get(kind);
      if (gpu) gpu.set(data, offset);
    },
    gpuBuffer(kind) { return gpuBuffers.get(kind); },
    resetPartialUpdateCalls() { this.partialUpdateCalls = 0; },
  };
}

function packMatrices(positions) {
  const data = new Float32Array(positions.length * 16);
  positions.forEach((position, index) => {
    Matrix.Translation(position.x, position.y, position.z).copyToArray(data, index * 16);
  });
  return data;
}

/** The weight the shader mask expects: 1 = model only, 0 = impostor only. */
function expectedModelWeight(position, camera, distanceMeters, transitionWidthMeters) {
  const width = Math.min(transitionWidthMeters, distanceMeters);
  const inner = distanceMeters - width / 2;
  const outer = distanceMeters + width / 2;
  const distance = Math.hypot(position.x - camera.x, position.y - camera.y, position.z - camera.z);
  if (distance <= inner) return 1;
  if (distance >= outer) return 0;
  const linear = (outer - distance) / (outer - inner);
  return linear * linear * (3 - 2 * linear);
}

function drawnInstances(mesh) {
  const matrices = mesh.gpuBuffer("matrix");
  const blends = mesh.gpuBuffer("instanceLodBlend");
  const drawn = [];
  for (let slot = 0; slot < mesh.thinInstanceCount; slot++) {
    drawn.push({
      x: matrices[slot * 16 + 12],
      y: matrices[slot * 16 + 13],
      z: matrices[slot * 16 + 14],
      blend: blends[slot],
    });
  }
  return drawn;
}

function assertFieldMatchesGroundTruth(impostorMesh, modelMesh, positions, camera, distanceMeters, label) {
  assert.equal(impostorMesh.enabled, impostorMesh.thinInstanceCount > 0);
  assert.equal(modelMesh.enabled, modelMesh.thinInstanceCount > 0);
  const keyed = (instance) => `${instance.x},${instance.y},${instance.z}`;
  const impostors = new Map(drawnInstances(impostorMesh).map((i) => [keyed(i), i]));
  const models = new Map(drawnInstances(modelMesh).map((i) => [keyed(i), i]));

  for (const position of positions) {
    const weight = expectedModelWeight(position, camera, distanceMeters, 20);
    const key = `${position.x},${position.y},${position.z}`;
    const impostor = impostors.get(key);
    const model = models.get(key);
    assert.equal(
      model !== undefined,
      weight > 0,
      `${label}: model presence for instance at ${key} (weight ${weight})`,
    );
    assert.equal(
      impostor !== undefined,
      weight < 1,
      `${label}: impostor presence for instance at ${key} (weight ${weight})`,
    );
    if (model) {
      assert.ok(
        Math.abs(model.blend - weight) < 1e-5,
        `${label}: model blend for ${key}: ${model.blend} vs expected ${weight}`,
      );
    }
    if (impostor) {
      assert.ok(
        Math.abs(impostor.blend - weight) < 1e-5,
        `${label}: impostor blend for ${key}: ${impostor.blend} vs expected ${weight}`,
      );
    }
  }
  assert.equal(
    models.size,
    positions.filter((p) => expectedModelWeight(p, camera, distanceMeters, 20) > 0).length,
    `${label}: no duplicate or stale model instances`,
  );
  assert.equal(
    impostors.size,
    positions.filter((p) => expectedModelWeight(p, camera, distanceMeters, 20) < 1).length,
    `${label}: no duplicate or stale impostor instances`,
  );
}

test("incremental LOD keeps every instance drawn while the camera walks", async () => {
  const positions = [];
  for (let x = 0; x <= 300; x += 3) {
    for (let z = -6; z <= 6; z += 6) {
      positions.push({ x, y: 0, z });
    }
  }
  const matrices = packMatrices(positions);
  const impostorMesh = createMeshStub("impostors");
  const modelMesh = createMeshStub("models");
  const field = await createVegetationFieldResult(
    { name: "test-root" },
    [impostorMesh],
    [modelMesh],
    matrices,
    1,
    "auto",
  );

  const distanceMeters = 60;
  // Small keyboard-style steps stay below the 20 m transition width so every
  // update after the first takes the incremental path.
  for (let step = 0; step <= 60; step++) {
    const camera = new Vector3(step * 4, 2, 0);
    field.updateLod(camera, distanceMeters);
    assertFieldMatchesGroundTruth(
      impostorMesh,
      modelMesh,
      positions,
      camera,
      distanceMeters,
      `step ${step}`,
    );
  }
});

test("incremental LOD coalesces per-instance GPU buffer uploads", async () => {
  const positions = [];
  for (let x = -100; x <= 100; x += 1) {
    for (let z = -8; z <= 8; z += 2) positions.push({ x, y: 0, z });
  }
  const impostorMesh = createMeshStub("impostors");
  const modelMesh = createMeshStub("models");
  const field = await createVegetationFieldResult(
    { name: "test-root" },
    [impostorMesh],
    [modelMesh],
    packMatrices(positions),
    1,
    "auto",
  );

  field.updateLod(new Vector3(0, 2, 0), 40);
  impostorMesh.resetPartialUpdateCalls();
  modelMesh.resetPartialUpdateCalls();
  field.updateLod(new Vector3(1, 2, 0), 40);

  const uploadCalls = impostorMesh.partialUpdateCalls + modelMesh.partialUpdateCalls;
  assert.ok(uploadCalls > 0, "movement should update LOD buffers");
  assert.ok(uploadCalls < 40, `expected coalesced uploads, got ${uploadCalls}`);
});

test("sub-meter movement does not churn LOD buffers", async () => {
  const positions = [];
  for (let x = -100; x <= 100; x += 2) positions.push({ x, y: 0, z: 0 });
  const impostorMesh = createMeshStub("impostors");
  const modelMesh = createMeshStub("models");
  const field = await createVegetationFieldResult(
    { name: "test-root" },
    [impostorMesh],
    [modelMesh],
    packMatrices(positions),
    1,
    "auto",
  );

  assert.equal(field.updateLod(new Vector3(0, 2, 0), 40), true);
  impostorMesh.resetPartialUpdateCalls();
  modelMesh.resetPartialUpdateCalls();
  assert.equal(field.updateLod(new Vector3(0.25, 2, 0), 40), false);
  assert.equal(impostorMesh.partialUpdateCalls + modelMesh.partialUpdateCalls, 0);
  assert.equal(field.updateLod(new Vector3(0.5, 2, 0), 40), true);
});

test("vegetation fields retain conservative bounds and allow frustum culling", async () => {
  const impostorMesh = createMeshStub("impostors");
  const modelMesh = createMeshStub("models");
  await createVegetationFieldResult(
    { name: "test-root" },
    [impostorMesh],
    [modelMesh],
    packMatrices([{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 100 }]),
    1,
    "auto",
  );

  assert.equal(impostorMesh.alwaysSelectAsActiveMesh, false);
  assert.equal(modelMesh.alwaysSelectAsActiveMesh, false);
});

test("first full LOD layout cooperatively yields before the field commits", async () => {
  const positions = [];
  for (let x = -100; x <= 100; x += 2) {
    for (let z = -20; z <= 20; z += 2) positions.push({ x, y: 0, z });
  }
  const impostorMesh = createMeshStub("impostors");
  const modelMesh = createMeshStub("models");
  const field = await createVegetationFieldResult(
    { name: "test-root" },
    [impostorMesh],
    [modelMesh],
    packMatrices(positions),
    1,
    "auto",
  );
  const camera = new Vector3(0, 2, 0);
  let yields = 0;

  await field.prepareLod(camera, 40, async () => { yields++; });

  assert.ok(yields >= 4, `expected multiple LOD budget checks, got ${yields}`);
  assert.equal(field.updateLod(camera, 40), false, "prepared camera state should not rebuild on commit");
  assertFieldMatchesGroundTruth(impostorMesh, modelMesh, positions, camera, 40, "prepared");
});

test("forced activation rebuilds a prepared field at the same camera position", async () => {
  const positions = [
    { x: 0, y: 0, z: 0 },
    { x: 35, y: 0, z: 0 },
    { x: 80, y: 0, z: 0 },
  ];
  const impostorMesh = createMeshStub("impostors");
  const modelMesh = createMeshStub("models");
  const field = await createVegetationFieldResult(
    { name: "test-root" },
    [impostorMesh],
    [modelMesh],
    packMatrices(positions),
    1,
    "auto",
  );
  const camera = new Vector3(0, 2, 0);

  await field.prepareLod(camera, 40);
  const fullRebuildsBeforeActivation = field.consumeLodDebugStats().fullRebuilds;
  assert.equal(field.updateLod(camera, 40), false, "an ordinary unchanged update should be skipped");
  assert.equal(field.updateLod(camera, 40, true), true);
  assert.equal(field.consumeLodDebugStats().fullRebuilds, 1);
  assert.equal(fullRebuildsBeforeActivation, 1);
  assertFieldMatchesGroundTruth(impostorMesh, modelMesh, positions, camera, 40, "activated");
});

test("incremental LOD survives direction changes and revisits", async () => {
  const positions = [];
  for (let x = -120; x <= 120; x += 4) {
    positions.push({ x, y: 0, z: 0 }, { x, y: 0, z: 30 });
  }
  const matrices = packMatrices(positions);
  const impostorMesh = createMeshStub("impostors");
  const modelMesh = createMeshStub("models");
  const field = await createVegetationFieldResult(
    { name: "test-root" },
    [impostorMesh],
    [modelMesh],
    matrices,
    1,
    "auto",
  );

  const distanceMeters = 40;
  const path = [];
  for (let step = 0; step <= 20; step++) path.push(new Vector3(step * 6, 2, 0));
  for (let step = 20; step >= -10; step--) path.push(new Vector3(step * 6, 2, step));
  for (const [index, camera] of path.entries()) {
    field.updateLod(camera, distanceMeters);
    assertFieldMatchesGroundTruth(
      impostorMesh,
      modelMesh,
      positions,
      camera,
      distanceMeters,
      `path point ${index}`,
    );
  }
});
