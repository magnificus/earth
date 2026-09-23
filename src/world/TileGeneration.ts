/** Dependencies describe execution, not just the order of a debug report. */
export const TILE_GENERATION_STAGES = {
  sources: [],
  relief: ["sources"],
  coastline: ["relief"],
  "water-selection": ["coastline"],
  "lake-terrain": ["water-selection"],
  "river-terrain": ["lake-terrain"],
  "site-plan": ["river-terrain"],
  "building-pads": ["site-plan"],
  "road-grades": ["building-pads"],
  stitching: ["road-grades"],
  "terrain-mesh": ["stitching"],
  "water-mesh": ["terrain-mesh"],
  buildings: ["water-mesh"],
  "roads-rivers": ["water-mesh"],
  vegetation: ["water-mesh"],
  props: ["buildings", "roads-rivers", "vegetation"],
} as const;

export type TileGenerationStage = keyof typeof TILE_GENERATION_STAGES;
export interface TileStageEvent {
  stage: TileGenerationStage;
  status: "complete" | "skipped" | "failed" | "cancelled";
  durationMilliseconds: number;
  reason?: string;
}

/** One instance per terrain revision; downstream LOD stages may be rebuilt. */
export class TileGeneration {
  private readonly completed = new Set<TileGenerationStage>();
  private readonly active = new Map<TileGenerationStage, number>();

  private readonly observe?: (event: TileStageEvent, output?: () => unknown) => void;
  constructor(observe?: (event: TileStageEvent, output?: () => unknown) => void) {
    this.observe = observe;
  }

  begin(stage: TileGenerationStage): void {
    for (const dependency of TILE_GENERATION_STAGES[stage]) {
      if (!this.completed.has(dependency)) throw new Error(`${stage} requires completed ${dependency}`);
    }
    if (this.active.has(stage)) throw new Error(`${stage} is already running`);
    this.completed.delete(stage);
    this.active.set(stage, performance.now());
  }

  finish(stage: TileGenerationStage, output?: () => unknown, skippedReason?: string): void {
    const start = this.active.get(stage);
    if (start === undefined) throw new Error(`${stage} was not started`);
    this.active.delete(stage);
    this.completed.add(stage);
    this.observe?.({ stage, status: skippedReason ? "skipped" : "complete",
      durationMilliseconds: performance.now() - start, reason: skippedReason }, output);
  }

  abort(reason: unknown, cancelled = false): void {
    for (const [stage, start] of this.active) {
      this.observe?.({ stage, status: cancelled ? "cancelled" : "failed",
        durationMilliseconds: performance.now() - start,
        reason: reason instanceof Error ? reason.message : String(reason) });
    }
    this.active.clear();
  }
}
