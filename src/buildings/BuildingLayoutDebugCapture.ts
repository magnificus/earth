import { downloadJson } from "../core/Download";
import type { ApartmentLayout } from "./ApartmentLayoutPlanner";
import type { BuildingLayout, BuildingPlannerInput } from "./BuildingLayoutPlanner";
import type { BuildingPlan } from "./BuildingPlanner";
import type { Opening2D } from "./FloorPlan";

export interface EncounteredBuildingLayoutCapture {
  id: string;
  buildingClass: BuildingPlan["buildingClass"];
  heightMeters: number;
  levels?: number;
  geographicFootprint: BuildingPlan["footprint"];
  plannerInput: BuildingPlannerInput;
  facadeOpenings: readonly Opening2D[];
  buildingLayout?: BuildingLayout;
  apartmentLayouts?: readonly ApartmentLayout[];
  fallbackReason?: string;
}

interface BuildingLayoutCaptureFile {
  format: "earth-building-layout-captures";
  version: 1;
  capturedAt: string;
  buildings: EncounteredBuildingLayoutCapture[];
}

const captures = new Map<string, EncounteredBuildingLayoutCapture>();

export function encounteredBuildingLayouts(ids: readonly string[]): EncounteredBuildingLayoutCapture[] {
  return ids.flatMap(id => { const capture = captures.get(id); return capture ? [capture] : []; });
}
const activeReferences = new Map<string, number>();
interface CaptureOwner {
  onDisposeObservable: { add(callback: () => void): unknown };
  computeWorldMatrix?(force?: boolean): unknown;
  getBoundingInfo?(): { boundingSphere: { centerWorld: { x: number; z: number } } };
  getScene?(): { activeCamera?: { globalPosition: { x: number; z: number } } | null };
}
const activeTiles = new Set<{ ids: readonly string[]; owner: CaptureOwner }>();
let initialized = false;

/**
 * Captures the planner data for rendered buildings. The renderer separately
 * retains captures while their streamed tile mesh remains in the scene.
 */
export function captureEncounteredBuildingLayout(
  capture: EncounteredBuildingLayoutCapture,
): void {
  if (typeof window === "undefined") return;
  initializeBrowserCapture();
  captures.set(capture.id, capture);
}

/** Limits Shift+B exports to buildings owned by meshes currently in the scene. */
export function retainCurrentBuildingLayoutCaptures(
  buildingIds: readonly string[],
  owner: CaptureOwner,
): void {
  if (typeof window === "undefined" || buildingIds.length === 0) return;
  initializeBrowserCapture();
  const uniqueIds = [...new Set(buildingIds)];
  for (const id of uniqueIds) {
    activeReferences.set(id, (activeReferences.get(id) ?? 0) + 1);
  }
  const tile = { ids: uniqueIds, owner };
  activeTiles.add(tile);
  owner.onDisposeObservable.add(() => {
    activeTiles.delete(tile);
    for (const id of uniqueIds) {
      const remaining = (activeReferences.get(id) ?? 1) - 1;
      if (remaining > 0) activeReferences.set(id, remaining);
      else {
        activeReferences.delete(id);
        captures.delete(id);
      }
    }
  });
}

export function downloadEncounteredBuildingLayouts(): void {
  if (typeof window === "undefined") return;
  const currentTile = nearestActiveTile();
  const currentIds = new Set(currentTile?.ids ?? []);
  const currentCaptures = [...captures.values()]
    .filter((capture) => currentIds.has(capture.id))
    .sort((first, second) => first.id.localeCompare(second.id));
  if (currentCaptures.length === 0) {
    console.info("[Building layout debug] No detailed buildings are loaded in the current tile.");
    return;
  }
  const report: BuildingLayoutCaptureFile = {
    format: "earth-building-layout-captures",
    version: 1,
    capturedAt: new Date().toISOString(),
    buildings: currentCaptures,
  };
  const timestamp = report.capturedAt.replace(/[:.]/g, "-");
  const filename = `earth-building-layouts-${timestamp}.json`;
  downloadJson(filename, report);
  console.info(`[Building layout debug] Downloaded ${currentCaptures.length} buildings to ${filename}.`);
}

function nearestActiveTile(): { ids: readonly string[]; owner: CaptureOwner } | undefined {
  let nearest: { ids: readonly string[]; owner: CaptureOwner } | undefined;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  for (const tile of activeTiles) {
    tile.owner.computeWorldMatrix?.(true);
    const center = tile.owner.getBoundingInfo?.().boundingSphere.centerWorld;
    const camera = tile.owner.getScene?.().activeCamera?.globalPosition;
    const distanceSquared = center && camera
      ? (center.x - camera.x) ** 2 + (center.z - camera.z) ** 2
      : 0;
    if (distanceSquared < nearestDistanceSquared) {
      nearest = tile;
      nearestDistanceSquared = distanceSquared;
    }
  }
  return nearest;
}

function initializeBrowserCapture(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener("keydown", (event) => {
    if (event.shiftKey && event.code === "KeyB") downloadEncounteredBuildingLayouts();
  });
  (window as Window & {
    downloadEncounteredBuildingLayouts?: typeof downloadEncounteredBuildingLayouts;
  }).downloadEncounteredBuildingLayouts = downloadEncounteredBuildingLayouts;
  console.info(
    "[Building layout debug] Shift+B downloads building polygons from the current detailed tile.",
  );
}
