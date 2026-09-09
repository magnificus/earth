import type { TreeSpecies } from "./procedural/ProceduralTree";
import { lerp } from "./MathUtils";

export type TreeSeason = "spring" | "summer" | "autumn" | "winter";

export interface TreeSeasonAppearance {
  /** Stable identity used by the procedural model and impostor caches. */
  key: string;
  season: TreeSeason;
  /** Fraction of deciduous leaf cards retained in the generated crown. */
  leafCoverage: number;
  /**
   * Target foliage colour multiplier for this season. It is applied live by
   * the tree materials, spreading through each crown region by region (see
   * `treeSeasonProgressAt`), and is never baked into models or atlases.
   */
  foliageTint: readonly [number, number, number];
}

/** Days after the season begins by which autumn colour has reached every tree. */
const AUTUMN_TURN_DAYS = 60;
/** Days over which spring's fresh flush settles into summer green. */
const SPRING_SETTLE_DAYS = 75;

/**
 * How far the season's `foliageTint` has spread through the crowns: 0 leaves
 * every tree in summer colour, 1 has turned every leaf. Autumn rises through
 * the season and spring falls back as new leaves mature; winter's few remaining
 * leaves are fully turned. Individual trees run ahead of or behind this value
 * in the shader, so it describes the local forest as a whole.
 */
export function treeSeasonProgressAt(date: Date | undefined, latitude: number): number {
  if (!date || !Number.isFinite(date.getTime()) || !Number.isFinite(latitude)) return 0;
  const season = meteorologicalSeason(date.getMonth(), latitude < 0);
  const days = daysIntoSeason(date);
  switch (season) {
    case "autumn":
      return clamp01(days / AUTUMN_TURN_DAYS);
    case "spring":
      return 1 - clamp01(days / SPRING_SETTLE_DAYS);
    case "winter":
      return 1;
    default:
      return 0;
  }
}

/** Seasons change on the same month boundaries in both hemispheres. */
function daysIntoSeason(date: Date): number {
  const monthsIntoSeason = (date.getMonth() + 1) % 3;
  return monthsIntoSeason * 30.4 + (date.getDate() - 1);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Whether seasonal snow cover is appropriate at a location. Tropical places
 * retain year-round ground cover even during their hemisphere's nominal
 * winter, matching the tropical tree treatment below.
 */
export function hasWinterGroundCover(
  date: Date | undefined,
  latitude: number,
): boolean {
  return Boolean(
    date
    && Number.isFinite(date.getTime())
    && Number.isFinite(latitude)
    && Math.abs(latitude) >= 23.5
    && meteorologicalSeason(date.getMonth(), latitude < 0) === "winter",
  );
}

const EVERGREEN_SPECIES = new Set<TreeSpecies>([
  "acacia", "eucalyptus", "fir", "kapok", "mangrove", "palm", "pine", "spruce",
]);

const SUMMER: TreeSeasonAppearance = {
  key: "summer",
  season: "summer",
  leafCoverage: 1,
  foliageTint: [1, 1, 1],
};

/**
 * Resolves the seasonal appearance of a tree: crown density baked into the
 * model and atlas, plus the live colour target. Seasons reverse across the
 * equator; tropical trees and evergreen species retain their crowns, while
 * subtropical deciduous trees react more gently.
 */
export function treeSeasonAt(
  date: Date | undefined,
  latitude: number,
  species: TreeSpecies,
): TreeSeasonAppearance {
  if (!date || !Number.isFinite(date.getTime())) return SUMMER;

  const season = meteorologicalSeason(date.getMonth(), latitude < 0);
  if (Math.abs(latitude) < 23.5) {
    return { ...SUMMER, key: "tropical", season };
  }
  if (EVERGREEN_SPECIES.has(species)) {
    return evergreenAppearance(season);
  }

  const climateStrength = Math.abs(latitude) < 35 ? 0.55 : 1;
  const seasonal = deciduousAppearance(season, species);
  return {
    key: `${climateStrength < 1 ? "mild-" : ""}${season}`,
    season,
    leafCoverage: lerp(1, seasonal.leafCoverage, climateStrength),
    foliageTint: [
      lerp(1, seasonal.foliageTint[0], climateStrength),
      lerp(1, seasonal.foliageTint[1], climateStrength),
      lerp(1, seasonal.foliageTint[2], climateStrength),
    ],
  };
}

function meteorologicalSeason(month: number, southernHemisphere: boolean): TreeSeason {
  const northern: TreeSeason = month < 2 || month === 11
    ? "winter"
    : month < 5
      ? "spring"
      : month < 8
        ? "summer"
        : "autumn";
  if (!southernHemisphere) return northern;
  return northern === "winter" ? "summer"
    : northern === "summer" ? "winter"
      : northern === "spring" ? "autumn"
        : "spring";
}

function evergreenAppearance(season: TreeSeason): TreeSeasonAppearance {
  if (season !== "winter") return { ...SUMMER, key: `evergreen-${season}`, season };
  return {
    key: "evergreen-winter",
    season,
    leafCoverage: 1,
    foliageTint: [0.9, 0.96, 1.04],
  };
}

function deciduousAppearance(
  season: TreeSeason,
  species: TreeSpecies,
): Omit<TreeSeasonAppearance, "key"> {
  switch (season) {
    case "winter":
      return { season, leafCoverage: 0.035, foliageTint: [0.68, 0.5, 0.28] };
    case "spring":
      return { season, leafCoverage: 0.58, foliageTint: [1.08, 1.18, 0.78] };
    case "autumn": {
      const red = species === "maple" ? 1.48 : species === "beech" ? 1.28 : 1.36;
      const green = species === "oak" ? 0.68 : 0.56;
      return { season, leafCoverage: 0.72, foliageTint: [red, green, 0.2] };
    }
    default:
      return { season, leafCoverage: 1, foliageTint: [1, 1, 1] };
  }
}

