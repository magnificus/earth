import { Mesh, ShaderMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { yieldToNextFrame } from "./FrameBudget";
import { SpatialReferenceGrid } from "./SpatialReferenceGrid";

export type VegetationRenderMode = "impostors" | "auto" | "models";

/** Narrow enough to keep the movement-time transition working set small. */
const LOD_TRANSITION_WIDTH_METERS = 20;
/** Sub-frame camera motion is visually irrelevant across the wide LOD blend. */
const LOD_UPDATE_MIN_MOVEMENT_METERS = 0.5;
/** Small gaps are cheaper to upload than issuing another WebGL buffer call. */
const PARTIAL_UPDATE_MERGE_GAP_SLOTS = 8;

export interface VegetationLodDebugStats {
  totalInstances: number;
  updates: number;
  processedInstances: number;
  peakProcessedInstances: number;
  currentGridCandidates: number;
  currentTransitionInstances: number;
  membershipChanges: number;
  fullRebuilds: number;
}

export interface VegetationFieldResult {
  root: TransformNode;
  meshes: Mesh[];
  impostorMeshes: Mesh[];
  modelMeshes: Mesh[];
  /** Native depth-only geometry kept outside normal scene rendering. */
  shadowCasterMeshes: Mesh[];
  instanceMatrices: Float32Array;
  count: number;
  setRenderMode(mode: VegetationRenderMode): void;
  /** Dithers the whole field in or out; 0 hides it and 1 shows it fully. */
  setFade(fade: number): void;
  /** Prepares the first full LOD layout without monopolizing one frame. */
  prepareLod(
    cameraPosition: Vector3,
    distanceMeters: number,
    yieldControl?: () => Promise<void>,
  ): Promise<boolean>;
  /** Updates packed model/impostor instances; true when instance buffers changed. */
  updateLod(cameraPosition: Vector3, distanceMeters: number, forceFullUpdate?: boolean): boolean;
  consumeLodDebugStats(): VegetationLodDebugStats;
}

export async function createVegetationFieldResult(
  root: TransformNode,
  impostorMeshes: Mesh[],
  modelMeshes: Mesh[],
  matrices: Float32Array,
  metersPerUnit: number,
  initialMode: VegetationRenderMode,
  instanceColors?: Float32Array,
  yieldControl?: () => Promise<void>,
): Promise<VegetationFieldResult> {
  const count = matrices.length / 16;
  if (instanceColors && instanceColors.length !== count * 3) {
    throw new Error("Instance color count must match the vegetation matrix count.");
  }
  const impostorMatrices = new Float32Array(matrices.length);
  const modelMatrices = new Float32Array(matrices.length);
  const sourceColors = instanceColors ?? new Float32Array(count * 3).fill(1);
  const impostorColors = new Float32Array(sourceColors.length);
  const modelColors = new Float32Array(sourceColors.length);
  const impostorLodBlend = new Float32Array(count);
  const modelLodBlend = new Float32Array(count);
  const sourceLodBlend = new Float32Array(count);
  impostorMatrices.set(matrices);
  await yieldControl?.();
  modelMatrices.set(matrices);
  await yieldControl?.();
  impostorColors.set(sourceColors);
  modelColors.set(sourceColors);
  modelLodBlend.fill(1);

  await initializeMeshes(
    impostorMeshes,
    impostorMatrices,
    impostorColors,
    impostorLodBlend,
    yieldControl,
  );
  await initializeMeshes(
    modelMeshes,
    modelMatrices,
    modelColors,
    modelLodBlend,
    yieldControl,
  );

  let mode = initialMode;
  const lastCameraPosition = Vector3.Zero();
  let hasLastCameraPosition = false;
  let lastDistanceMeters = 10;
  const allInstanceIndices: number[] = [];
  let minimumInstanceY = Number.POSITIVE_INFINITY;
  let maximumInstanceY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < count; index++) {
    allInstanceIndices.push(index);
    minimumInstanceY = Math.min(minimumInstanceY, matrices[index * 16 + 13]);
    maximumInstanceY = Math.max(maximumInstanceY, matrices[index * 16 + 13]);
    if ((index & 511) === 511) await yieldControl?.();
  }
  const spatialGrid = new SpatialReferenceGrid<number>(
    [],
    Math.max(1 / metersPerUnit, Math.min(LOD_TRANSITION_WIDTH_METERS / metersPerUnit, 16 / metersPerUnit)),
  );
  for (let index = 0; index < count; index++) {
    spatialGrid.add({
      x: matrices[index * 16 + 12],
      z: matrices[index * 16 + 14],
      value: index,
    });
    if ((index & 511) === 511) await yieldControl?.();
  }
  let previousTransitionIndices = new Set<number>();
  const modelSlotBySource = new Int32Array(count).fill(-1);
  const impostorSlotBySource = new Int32Array(count).fill(-1);
  const modelSourceBySlot: number[] = [];
  const impostorSourceBySlot: number[] = [];
  let autoModelCount = 0;
  let autoImpostorCount = 0;
  let autoSlotsValid = false;
  const lodDebugStats: VegetationLodDebugStats = {
    totalInstances: count,
    updates: 0,
    processedInstances: 0,
    peakProcessedInstances: 0,
    currentGridCandidates: 0,
    currentTransitionInstances: 0,
    membershipChanges: 0,
    fullRebuilds: 0,
  };

  const setCounts = (impostorCount: number, modelCount: number): void => {
    setMeshCount(impostorMeshes, impostorCount);
    setMeshCount(modelMeshes, modelCount);
  };

  const setRenderMode = (mode: VegetationRenderMode): void => {
    if (mode === "impostors") {
      autoSlotsValid = false;
      impostorLodBlend.fill(0);
      if (hasLastCameraPosition) {
        writeFrontToBackInstances(
          impostorMatrices,
          matrices,
          allInstanceIndices,
          lastCameraPosition,
          impostorColors,
          sourceColors,
          impostorLodBlend,
          impostorLodBlend,
          false,
        );
      } else {
        impostorMatrices.set(matrices);
        impostorColors.set(sourceColors);
      }
      setCounts(count, 0);
      updateMeshBuffers(impostorMeshes, true);
    } else if (mode === "models") {
      autoSlotsValid = false;
      modelMatrices.set(matrices);
      modelColors.set(sourceColors);
      modelLodBlend.fill(1);
      setCounts(0, count);
      updateMeshBuffers(modelMeshes, true);
    } else if (hasLastCameraPosition) {
      updateAutoLod(lastCameraPosition, lastDistanceMeters, true);
    } else {
      impostorMatrices.set(matrices);
      impostorColors.set(sourceColors);
      setCounts(count, 0);
      updateMeshBuffers(impostorMeshes, true);
      autoSlotsValid = false;
    }
  };

  interface AutoLodUpdate {
    rebuildSlots: boolean;
    innerDistanceSquared: number;
    outerDistanceSquared: number;
    currentTransitionIndices: Set<number>;
    transitionIndices: Iterable<number>;
    transitionCount: number;
    exactTransitionCount: number;
    dirtyModelSlots: Set<number>;
    dirtyModelBlendSlots: Set<number>;
    dirtyImpostorSlots: Set<number>;
    dirtyImpostorBlendSlots: Set<number>;
  }

  const beginAutoLodUpdate = (
    cameraPosition: Vector3,
    distanceMeters: number,
    forceFullUpdate: boolean,
  ): AutoLodUpdate => {
    const rebuildSlots = forceFullUpdate || !autoSlotsValid;
    if (rebuildSlots) lodDebugStats.fullRebuilds++;
    if (rebuildSlots) {
      modelSlotBySource.fill(-1);
      impostorSlotBySource.fill(-1);
      modelSourceBySlot.length = 0;
      impostorSourceBySlot.length = 0;
      autoModelCount = 0;
      autoImpostorCount = 0;
      autoSlotsValid = true;
    }
    const transitionWidthMeters = Math.min(LOD_TRANSITION_WIDTH_METERS, distanceMeters);
    const innerDistance = (distanceMeters - transitionWidthMeters / 2) / metersPerUnit;
    const outerDistance = (distanceMeters + transitionWidthMeters / 2) / metersPerUnit;
    const innerDistanceSquared = innerDistance * innerDistance;
    const outerDistanceSquared = outerDistance * outerDistance;
    const currentTransitionIndices = new Set<number>();
    const addBounds = (near: number, far: number): void => {
      const maximumVerticalOffset = Math.max(
        Math.abs(minimumInstanceY - cameraPosition.y),
        Math.abs(maximumInstanceY - cameraPosition.y),
      );
      const conservativeInnerRadius = Math.sqrt(Math.max(
        0,
        near * near - maximumVerticalOffset * maximumVerticalOffset,
      ));
      for (const index of spatialGrid.queryAnnulusBounds(
        cameraPosition.x,
        cameraPosition.z,
        conservativeInnerRadius,
        far,
      )) currentTransitionIndices.add(index);
    };
    addBounds(innerDistance, outerDistance);
    const incrementalIndices = new Set(currentTransitionIndices);
    if (!forceFullUpdate) {
      previousTransitionIndices.forEach((index) => incrementalIndices.add(index));
    }
    return {
      rebuildSlots,
      innerDistanceSquared,
      outerDistanceSquared,
      currentTransitionIndices,
      transitionIndices: forceFullUpdate ? allInstanceIndices : incrementalIndices,
      transitionCount: forceFullUpdate ? allInstanceIndices.length : incrementalIndices.size,
      exactTransitionCount: 0,
      dirtyModelSlots: new Set<number>(),
      dirtyModelBlendSlots: new Set<number>(),
      dirtyImpostorSlots: new Set<number>(),
      dirtyImpostorBlendSlots: new Set<number>(),
    };
  };

  const updateAutoLodInstance = (
    instanceIndex: number,
    cameraPosition: Vector3,
    update: AutoLodUpdate,
  ): void => {
      const matrixOffset = instanceIndex * 16;
      const dx = matrices[matrixOffset + 12] - cameraPosition.x;
      const dy = matrices[matrixOffset + 13] - cameraPosition.y;
      const dz = matrices[matrixOffset + 14] - cameraPosition.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (
        distanceSquared > update.innerDistanceSquared &&
        distanceSquared < update.outerDistanceSquared
      ) update.exactTransitionCount++;
      let modelWeight: number;
      if (distanceSquared <= update.innerDistanceSquared) {
        modelWeight = 1;
      } else if (distanceSquared >= update.outerDistanceSquared) {
        modelWeight = 0;
      } else {
        const distance = Math.sqrt(distanceSquared);
        const innerDistance = Math.sqrt(update.innerDistanceSquared);
        const outerDistance = Math.sqrt(update.outerDistanceSquared);
        const linearBlend = (outerDistance - distance) / (outerDistance - innerDistance);
        modelWeight = linearBlend * linearBlend * (3 - 2 * linearBlend);
      }
      const previousModelWeight = sourceLodBlend[instanceIndex];
      sourceLodBlend[instanceIndex] = modelWeight;

      updatePackedMembership(
        instanceIndex,
        modelWeight > 0,
        true,
        update,
      );
      updatePackedMembership(
        instanceIndex,
        modelWeight < 1,
        false,
        update,
      );
      const modelSlot = modelSlotBySource[instanceIndex];
      if (modelSlot >= 0 && (update.rebuildSlots || modelWeight !== previousModelWeight)) {
        modelLodBlend[modelSlot] = modelWeight;
        if (!update.rebuildSlots) {
          update.dirtyModelBlendSlots.add(modelSlot);
        }
      }
      const impostorSlot = impostorSlotBySource[instanceIndex];
      if (impostorSlot >= 0 && (update.rebuildSlots || modelWeight !== previousModelWeight)) {
        impostorLodBlend[impostorSlot] = modelWeight;
        if (!update.rebuildSlots) {
          update.dirtyImpostorBlendSlots.add(impostorSlot);
        }
      }
  };

  const finishAutoLodUpdate = (update: AutoLodUpdate, deferFullUpload = false): void => {
    recordLodDebugUpdate(
      update.transitionCount,
      update.currentTransitionIndices.size,
      update.exactTransitionCount,
    );
    previousTransitionIndices = update.currentTransitionIndices;
    setCounts(autoImpostorCount, autoModelCount);
    if (update.rebuildSlots && !deferFullUpload) {
      updateMeshBuffers(impostorMeshes, true);
      updateMeshBuffers(modelMeshes, true);
    } else {
      flushPackedUpdates(
        modelMeshes,
        modelMatrices,
        modelColors,
        modelLodBlend,
        update.dirtyModelSlots,
        update.dirtyModelBlendSlots,
      );
      flushPackedUpdates(
        impostorMeshes,
        impostorMatrices,
        impostorColors,
        impostorLodBlend,
        update.dirtyImpostorSlots,
        update.dirtyImpostorBlendSlots,
      );
    }
  };

  const updateAutoLod = (cameraPosition: Vector3, distanceMeters: number, forceFullUpdate = false): void => {
    const update = beginAutoLodUpdate(cameraPosition, distanceMeters, forceFullUpdate);
    for (const instanceIndex of update.transitionIndices) {
      updateAutoLodInstance(instanceIndex, cameraPosition, update);
    }
    finishAutoLodUpdate(update);
  };

  const updatePackedMembership = (
    sourceIndex: number,
    shouldBePresent: boolean,
    model: boolean,
    update: AutoLodUpdate,
  ): void => {
    const slotBySource = model ? modelSlotBySource : impostorSlotBySource;
    const sourceBySlot = model ? modelSourceBySlot : impostorSourceBySlot;
    const currentSlot = slotBySource[sourceIndex];
    if (shouldBePresent === (currentSlot >= 0)) return;
    lodDebugStats.membershipChanges++;

    if (shouldBePresent) {
      const slot = model ? autoModelCount++ : autoImpostorCount++;
      slotBySource[sourceIndex] = slot;
      sourceBySlot[slot] = sourceIndex;
      writePackedSlot(model, slot, sourceIndex, update);
      return;
    }

    const lastSlot = (model ? autoModelCount : autoImpostorCount) - 1;
    const movedSourceIndex = sourceBySlot[lastSlot];
    if (currentSlot !== lastSlot) {
      sourceBySlot[currentSlot] = movedSourceIndex;
      slotBySource[movedSourceIndex] = currentSlot;
      writePackedSlot(model, currentSlot, movedSourceIndex, update);
    }
    sourceBySlot.pop();
    slotBySource[sourceIndex] = -1;
    if (model) autoModelCount--;
    else autoImpostorCount--;
  };

  const writePackedSlot = (
    model: boolean,
    slot: number,
    sourceIndex: number,
    update: AutoLodUpdate,
  ): void => {
    const destinationMatrices = model ? modelMatrices : impostorMatrices;
    const destinationColors = model ? modelColors : impostorColors;
    const destinationLod = model ? modelLodBlend : impostorLodBlend;
    copyMatrix(destinationMatrices, slot * 16, matrices, sourceIndex * 16);
    copyColor(destinationColors, slot * 3, sourceColors, sourceIndex * 3);
    destinationLod[slot] = sourceLodBlend[sourceIndex];
    if (update.rebuildSlots) return;
    (model ? update.dirtyModelSlots : update.dirtyImpostorSlots).add(slot);
    (model ? update.dirtyModelBlendSlots : update.dirtyImpostorBlendSlots).add(slot);
  };

  const updateLod = (
    cameraPosition: Vector3,
    distanceMeters: number,
    forceFullUpdate = false,
  ): boolean => {
    const distanceChanged = distanceMeters !== lastDistanceMeters;
    const movementSquared = hasLastCameraPosition
      ? Vector3.DistanceSquared(cameraPosition, lastCameraPosition)
      : Number.POSITIVE_INFINITY;
    const minimumMovement = LOD_UPDATE_MIN_MOVEMENT_METERS / metersPerUnit;
    if (!forceFullUpdate && !distanceChanged &&
        movementSquared < minimumMovement * minimumMovement) return false;
    const hadPreviousCameraPosition = hasLastCameraPosition;
    const transitionWidth = Math.min(LOD_TRANSITION_WIDTH_METERS, distanceMeters) / metersPerUnit;
    const rebuildAllSlots = forceFullUpdate || !hadPreviousCameraPosition || distanceChanged ||
      movementSquared >= transitionWidth * transitionWidth;
    lastCameraPosition.copyFrom(cameraPosition);
    hasLastCameraPosition = true;
    lastDistanceMeters = distanceMeters;
    // Impostor-only and model-only modes hold a fixed instance set; the
    // material resolves impostor detail per fragment.
    if (mode !== "auto") return false;
    updateAutoLod(cameraPosition, distanceMeters, rebuildAllSlots);
    return true;
  };

  const prepareLod = async (
    cameraPosition: Vector3,
    distanceMeters: number,
    yieldControl?: () => Promise<void>,
  ): Promise<boolean> => {
    lastCameraPosition.copyFrom(cameraPosition);
    hasLastCameraPosition = true;
    lastDistanceMeters = distanceMeters;
    if (mode !== "auto") return false;
    const update = beginAutoLodUpdate(cameraPosition, distanceMeters, true);
    let processed = 0;
    for (const instanceIndex of update.transitionIndices) {
      updateAutoLodInstance(instanceIndex, cameraPosition, update);
      if ((processed++ & 511) === 511) await yieldControl?.();
    }
    finishAutoLodUpdate(update, true);
    await updateMeshBuffersOverFrames(impostorMeshes, true, yieldControl);
    await updateMeshBuffersOverFrames(modelMeshes, true, yieldControl);
    return true;
  };

  const recordLodDebugUpdate = (
    processed: number,
    currentCandidates: number,
    currentTransitions: number,
  ): void => {
    lodDebugStats.updates++;
    lodDebugStats.processedInstances += processed;
    lodDebugStats.peakProcessedInstances = Math.max(
      lodDebugStats.peakProcessedInstances,
      processed,
    );
    lodDebugStats.currentGridCandidates = currentCandidates;
    lodDebugStats.currentTransitionInstances = currentTransitions;
  };

  const consumeLodDebugStats = (): VegetationLodDebugStats => {
    const snapshot = { ...lodDebugStats };
    lodDebugStats.updates = 0;
    lodDebugStats.processedInstances = 0;
    lodDebugStats.peakProcessedInstances = 0;
    lodDebugStats.membershipChanges = 0;
    lodDebugStats.fullRebuilds = 0;
    return snapshot;
  };

  const applyRenderMode = (nextMode: VegetationRenderMode): void => {
    mode = nextMode;
    setRenderMode(nextMode);
  };

  const setFade = (fade: number): void => {
    for (const mesh of [...impostorMeshes, ...modelMeshes]) {
      const material = mesh.material;
      if (material instanceof ShaderMaterial) material.setFloat("fieldFade", fade);
    }
  };

  // The buffers above already contain the initial data. Only choose which set
  // is visible here; uploading all three buffers again caused a large spike.
  if (initialMode === "models") setCounts(0, count);
  else setCounts(count, 0);
  return {
    root,
    meshes: [...impostorMeshes, ...modelMeshes],
    impostorMeshes,
    modelMeshes,
    shadowCasterMeshes: [],
    instanceMatrices: matrices,
    count,
    setRenderMode: applyRenderMode,
    setFade,
    prepareLod,
    updateLod,
    consumeLodDebugStats,
  };
}

function writeFrontToBackInstances(
  destinationMatrices: Float32Array,
  sourceMatrices: Float32Array,
  instanceIndices: number[],
  cameraPosition: Vector3,
  destinationColors?: Float32Array,
  sourceColors?: Float32Array,
  destinationLodBlend?: Float32Array,
  sourceLodBlend?: Float32Array,
  sortInstances = true,
): void {
  if (sortInstances) {
    sortInstanceIndicesFrontToBack(instanceIndices, sourceMatrices, cameraPosition);
  }
  for (let destinationIndex = 0; destinationIndex < instanceIndices.length; destinationIndex++) {
    const sourceIndex = instanceIndices[destinationIndex];
    copyMatrix(
      destinationMatrices,
      destinationIndex * 16,
      sourceMatrices,
      sourceIndex * 16,
    );
    if (destinationColors && sourceColors) {
      copyColor(destinationColors, destinationIndex * 3, sourceColors, sourceIndex * 3);
    }
    if (destinationLodBlend && sourceLodBlend) {
      destinationLodBlend[destinationIndex] = sourceLodBlend[sourceIndex];
    }
  }
}

function sortInstanceIndicesFrontToBack(
  instanceIndices: number[],
  matrices: Float32Array,
  cameraPosition: Vector3,
): void {
  const distances = new Float64Array(matrices.length / 16);
  for (const instanceIndex of instanceIndices) {
    distances[instanceIndex] = instanceDistanceSquared(matrices, instanceIndex, cameraPosition);
  }
  instanceIndices.sort((left, right) => distances[left] - distances[right]);
}

function instanceDistanceSquared(
  matrices: Float32Array,
  instanceIndex: number,
  cameraPosition: Vector3,
): number {
  const offset = instanceIndex * 16;
  const dx = matrices[offset + 12] - cameraPosition.x;
  const dy = matrices[offset + 13] - cameraPosition.y;
  const dz = matrices[offset + 14] - cameraPosition.z;
  return dx * dx + dy * dy + dz * dz;
}

function copyMatrix(
  destination: Float32Array,
  destinationOffset: number,
  source: Float32Array,
  sourceOffset: number,
): void {
  for (let element = 0; element < 16; element++) {
    destination[destinationOffset + element] = source[sourceOffset + element];
  }
}

function copyColor(
  destination: Float32Array,
  destinationOffset: number,
  source: Float32Array,
  sourceOffset: number,
): void {
  destination[destinationOffset] = source[sourceOffset];
  destination[destinationOffset + 1] = source[sourceOffset + 1];
  destination[destinationOffset + 2] = source[sourceOffset + 2];
}

async function initializeMeshes(
  meshes: Mesh[],
  matrices: Float32Array,
  instanceColors?: Float32Array,
  instanceLodBlend?: Float32Array,
  yieldControl?: () => Promise<void>,
): Promise<void> {
  for (const mesh of meshes) {
    await yieldToNextFrame(yieldControl);
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
    if (instanceColors) {
      await yieldToNextFrame(yieldControl);
      mesh.thinInstanceSetBuffer("vegetationColor", instanceColors, 3, false);
    }
    if (instanceLodBlend) {
      await yieldToNextFrame(yieldControl);
      mesh.thinInstanceSetBuffer("instanceLodBlend", instanceLodBlend, 1, false);
    }
    await yieldControl?.();
    mesh.thinInstanceRefreshBoundingInfo(true);
    // The bounds were computed from every source instance and remain a safe
    // superset while LOD packing changes the active prefix of the buffers.
    mesh.alwaysSelectAsActiveMesh = false;
    mesh.freezeWorldMatrix();
  }
}

function updateMeshBuffers(meshes: Mesh[], updateInstanceData = false): void {
  meshes.forEach((mesh) => {
    mesh.thinInstanceBufferUpdated("matrix");
    if (updateInstanceData) {
      mesh.thinInstanceBufferUpdated("vegetationColor");
      mesh.thinInstanceBufferUpdated("instanceLodBlend");
    }
  });
}

function partialUpdateArray(
  meshes: Mesh[],
  kind: string,
  source: Float32Array,
  offset: number,
  length: number,
): void {
  const data = source.subarray(offset, offset + length);
  for (const mesh of meshes) mesh.thinInstancePartialBufferUpdate(kind, data, offset);
}

/** Combines independently rendered regional variants behind one streamed field API. */
export function combineVegetationFieldResults(
  root: TransformNode,
  fields: readonly VegetationFieldResult[],
  instanceMatrices: Float32Array,
): VegetationFieldResult {
  const impostorMeshes = fields.flatMap((field) => field.impostorMeshes);
  const modelMeshes = fields.flatMap((field) => field.modelMeshes);
  const shadowCasterMeshes = fields.flatMap((field) => field.shadowCasterMeshes);
  return {
    root,
    meshes: [...impostorMeshes, ...modelMeshes],
    impostorMeshes,
    modelMeshes,
    shadowCasterMeshes,
    instanceMatrices,
    count: fields.reduce((sum, field) => sum + field.count, 0),
    setRenderMode: (mode) => fields.forEach((field) => field.setRenderMode(mode)),
    setFade: (fade) => fields.forEach((field) => field.setFade(fade)),
    prepareLod: async (cameraPosition, distanceMeters, yieldControl) => {
      let changed = false;
      for (const field of fields) {
        changed = await field.prepareLod(cameraPosition, distanceMeters, yieldControl) || changed;
      }
      return changed;
    },
    updateLod: (cameraPosition, distanceMeters, forceFullUpdate) => fields.reduce(
      (changed, field) =>
        field.updateLod(cameraPosition, distanceMeters, forceFullUpdate) || changed,
      false,
    ),
    consumeLodDebugStats: () => fields.reduce<VegetationLodDebugStats>(
      (total, field) => {
        const stats = field.consumeLodDebugStats();
        total.totalInstances += stats.totalInstances;
        total.updates += stats.updates;
        total.processedInstances += stats.processedInstances;
        total.peakProcessedInstances += stats.peakProcessedInstances;
        total.currentGridCandidates += stats.currentGridCandidates;
        total.currentTransitionInstances += stats.currentTransitionInstances;
        total.membershipChanges += stats.membershipChanges;
        total.fullRebuilds += stats.fullRebuilds;
        return total;
      },
      {
        totalInstances: 0,
        updates: 0,
        processedInstances: 0,
        peakProcessedInstances: 0,
        currentGridCandidates: 0,
        currentTransitionInstances: 0,
        membershipChanges: 0,
        fullRebuilds: 0,
      },
    ),
  };
}

async function updateMeshBuffersOverFrames(
  meshes: Mesh[],
  updateInstanceData: boolean,
  yieldControl?: () => Promise<void>,
): Promise<void> {
  for (const mesh of meshes) {
    await yieldToNextFrame(yieldControl);
    mesh.thinInstanceBufferUpdated("matrix");
    if (updateInstanceData) {
      await yieldToNextFrame(yieldControl);
      mesh.thinInstanceBufferUpdated("vegetationColor");
      await yieldToNextFrame(yieldControl);
      mesh.thinInstanceBufferUpdated("instanceLodBlend");
    }
  }
}

function flushPackedUpdates(
  meshes: Mesh[],
  matrices: Float32Array,
  colors: Float32Array,
  lodBlend: Float32Array,
  dirtySlots: Set<number>,
  dirtyBlendSlots: Set<number>,
): void {
  partialUpdateSlots(meshes, "matrix", matrices, 16, dirtySlots);
  partialUpdateSlots(meshes, "vegetationColor", colors, 3, dirtySlots);
  partialUpdateSlots(meshes, "instanceLodBlend", lodBlend, 1, dirtyBlendSlots);
}

function partialUpdateSlots(
  meshes: Mesh[],
  kind: string,
  source: Float32Array,
  stride: number,
  dirtySlots: Set<number>,
): void {
  if (dirtySlots.size === 0) return;
  const slots = [...dirtySlots].sort((left, right) => left - right);
  let rangeStart = slots[0];
  let rangeEnd = rangeStart;
  const flushRange = (): void => {
    partialUpdateArray(
      meshes,
      kind,
      source,
      rangeStart * stride,
      (rangeEnd - rangeStart + 1) * stride,
    );
  };
  for (let index = 1; index < slots.length; index++) {
    const slot = slots[index];
    if (slot <= rangeEnd + PARTIAL_UPDATE_MERGE_GAP_SLOTS + 1) {
      rangeEnd = slot;
      continue;
    }
    flushRange();
    rangeStart = slot;
    rangeEnd = slot;
  }
  flushRange();
}

function setMeshCount(meshes: Mesh[], count: number): void {
  for (const mesh of meshes) {
    mesh.thinInstanceCount = count;
    mesh.setEnabled(count > 0);
  }
}
