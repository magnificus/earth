import { escapeXml } from "../core/Svg";
import { TILE_GENERATION_STAGES, type TileStageEvent } from "../world/TileGeneration";
import type { TerrainData } from "../terrain/TerrainData";
import type { TerrainLakeSource } from "../terrain/TerrainLakePolygons";
import type { HorizontalSegment } from "../world/Geo";
import type { RoadAndBuildingPlan } from "../roads/RoadAndBuildingPlanner";

export interface TileStageOutput {
  terrain?: TerrainData;
  frame?: { meshWidth: number; meshDepth: number; metersPerUnit: number };
  lakes?: readonly TerrainLakeSource[];
  rivers?: readonly HorizontalSegment[];
  plan?: RoadAndBuildingPlan;
  meshes?: readonly CapturedMesh[];
  placements?: readonly { kind: string; matrices: ArrayLike<number>; count: number }[];
  [key: string]: unknown;
}

interface MeshSource {
  name: string;
  getVerticesDataKinds(): string[];
  getVerticesData(kind: string): ArrayLike<number> | null;
  getIndices(): ArrayLike<number> | null;
  computeWorldMatrix(force: boolean): { asArray(): ArrayLike<number> };
  thinInstanceCount?: number;
  thinInstanceGetWorldMatrices?(): { asArray(): ArrayLike<number> }[];
  getVertexBuffer?(kind: string): { getIsInstanced(): boolean; getData(): ArrayBuffer | ArrayBufferView | ArrayLike<number> | null;
    byteStride: number; byteOffset: number; type: number; normalized: boolean; getSize(): number } | null;
}
export interface CapturedMesh {
  name: string;
  attributes: Record<string, number[]>;
  indices: number[];
  worldMatrix: number[];
  instanceMatrices?: number[][];
  instanceAttributes?: Record<string, { data: number[]; encoding: "bytes" | "numbers"; byteStride: number; byteOffset: number; type: number; normalized: boolean; size: number }>;
}

/** Buffers are copied before mesh merging, disposal, or a later tile revision. */
export function captureTileMeshes(meshes: readonly MeshSource[]): CapturedMesh[] {
  return meshes.map(mesh => {
    const attributes: CapturedMesh["attributes"] = {};
    const instanceAttributes: NonNullable<CapturedMesh["instanceAttributes"]> = {};
    for (const kind of mesh.getVerticesDataKinds()) {
      const buffer = mesh.getVertexBuffer?.(kind);
      // Babylon's vertex getter uses vertex count, which is invalid for shorter instance buffers.
      if (buffer?.getIsInstanced()) {
        const data = buffer.getData();
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
          : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined;
        instanceAttributes[kind] = { data: Array.from(bytes ?? data as ArrayLike<number> ?? []), encoding: bytes ? "bytes" : "numbers",
          byteStride: buffer.byteStride, byteOffset: buffer.byteOffset, type: buffer.type,
          normalized: buffer.normalized, size: buffer.getSize() };
      } else attributes[kind] = Array.from(mesh.getVerticesData(kind) ?? []);
    }
    return { name: mesh.name, attributes, instanceAttributes,
      indices: Array.from(mesh.getIndices() ?? []),
      worldMatrix: Array.from(mesh.computeWorldMatrix(true).asArray()),
      instanceMatrices: mesh.thinInstanceCount ? mesh.thinInstanceGetWorldMatrices?.().map(matrix => Array.from(matrix.asArray())) : undefined,
    };
  });
}

export interface CapturedTileStage extends TileStageEvent {
  sequence: number;
  data: TileStageOutput;
  image: string;
  terrainChangeImage?: string;
  diagnostics: { changedSamples: number; maximumRaiseMeters: number; maximumCutMeters: number; nonFiniteSamples: number };
  captureError?: string;
}
export interface TileGenerationReport {
  format: "earth-tile-generation";
  version: 1;
  id: string;
  tile: string;
  native: boolean;
  seed: number;
  capturedAt: string;
  captureLimit?: string;
  stages: CapturedTileStage[];
}

/** JSON-safe, detached snapshots, including typed arrays and non-finite diagnostics. */
export function snapshotTileData<T>(data: T): T {
  return JSON.parse(JSON.stringify(data, (_key, value: unknown) => {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value as unknown as ArrayLike<number>);
    if (value instanceof Map) return [...value.entries()];
    if (value instanceof Set) return [...value];
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value;
  })) as T;
}

export class TileGenerationCapture {
  readonly report: TileGenerationReport;
  private previous?: number[];
  private range?: readonly [number, number];
  private stopped = false;
  constructor(tile: string, native: boolean, seed: number, id = `${tile}/${native ? "native" : "far"}/${Date.now()}`) {
    this.report = { format: "earth-tile-generation", version: 1, id, tile, native, seed,
      capturedAt: new Date().toISOString(), stages: [] };
  }

  record = (event: TileStageEvent, output?: () => unknown): void => {
    if (this.stopped) return;
    if (this.report.stages.length >= 64) {
      this.report.captureLimit = "Stopped after 64 stage snapshots; clear captures before another rebuild";
      this.stopped = true;
      return;
    }
    try {
      const source = (output?.() ?? this.report.stages.at(-1)?.data ?? {}) as TileStageOutput;
      const heights = source.terrain?.elevations;
      const differences = heights ? new Float32Array(heights.length) : undefined;
      const diagnostics = { changedSamples: 0, maximumRaiseMeters: 0, maximumCutMeters: 0, nonFiniteSamples: 0 };
      if (heights) {
        let low = Infinity, high = -Infinity;
        for (let i = 0; i < heights.length; i++) {
          if (!Number.isFinite(heights[i])) { diagnostics.nonFiniteSamples++; continue; }
          low = Math.min(low, heights[i]); high = Math.max(high, heights[i]);
          const difference = heights[i] - (this.previous?.[i] ?? heights[i]);
          differences![i] = difference;
          if (Math.abs(difference) > 1e-5) diagnostics.changedSamples++;
          diagnostics.maximumRaiseMeters = Math.max(diagnostics.maximumRaiseMeters, difference);
          diagnostics.maximumCutMeters = Math.max(diagnostics.maximumCutMeters, -difference);
        }
        this.range ??= [Number.isFinite(low) ? low : 0, Number.isFinite(high) ? high : 1];
        this.previous = Array.from(heights);
      }
      const data = snapshotTileData(source);
      if (differences) data.terrainChangeMeters = Array.from(differences);
      this.report.stages.push({ ...event, sequence: this.report.stages.length + 1, data, diagnostics,
        image: renderTileStageImage(event.stage, data, this.range),
        terrainChangeImage: source.terrain && differences ? renderTileStageImage(`${event.stage}: terrain change`, {
          frame: source.frame, terrain: { ...source.terrain, elevations: differences },
          changePreview: true,
        }, [-2, 2]) : undefined,
      });
    } catch (error) {
      // Debug export must never break a successfully generated world tile.
      this.report.stages.push({ ...event, sequence: this.report.stages.length + 1, data: {},
        diagnostics: { changedSamples: 0, maximumRaiseMeters: 0, maximumCutMeters: 0, nonFiniteSamples: 0 },
        image: renderTileStageImage(event.stage, {}), captureError: String(error) });
    }
  };

  clear(): void {
    this.stopped = true;
    this.report.stages.length = 0;
    this.previous = undefined;
  }
}

/** North-up stage geometry; full-resolution numerical data is exported separately. */
export function renderTileStageImage(stage: string, data: TileStageOutput, range: readonly [number, number] = [0, 100]): string {
  const width = data.frame?.meshWidth ?? 1, depth = data.frame?.meshDepth ?? 1;
  const scale = 720 / Math.max(width, depth);
  const point = (x: number, z: number) => `${(400 + x * scale).toFixed(2)},${(400 - z * scale).toFixed(2)}`;
  const path = (ring: readonly { x: number; z: number }[]) => ring.length ? `M${ring.map(p => point(p.x, p.z)).join("L")}Z` : "";
  const pieces: string[] = [];
  const terrain = data.terrain;
  if (terrain) {
    const stride = Math.max(1, Math.ceil(Math.max(terrain.width, terrain.height) / 128));
    for (let row = 0; row < terrain.height - 1; row += stride) for (let col = 0; col < terrain.width - 1; col += stride) {
      const elevation = Number(terrain.elevations[row * terrain.width + col]);
      const amount = Math.max(0, Math.min(1, (elevation - range[0]) / Math.max(1, range[1] - range[0])));
      const shade = Math.round(70 + amount * 160);
      const intensity = Math.round(230 - Math.min(1, Math.abs(elevation) / 2) * 190);
      const color = data.changePreview
        ? elevation >= 0 ? `rgb(230,${intensity},${intensity})` : `rgb(${intensity},${intensity},230)`
        : `rgb(${shade},${shade},${shade})`;
      const x = 400 - width * scale / 2 + col / (terrain.width - 1) * width * scale;
      const y = 400 - depth * scale / 2 + row / (terrain.height - 1) * depth * scale;
      pieces.push(`<rect x="${x}" y="${y}" width="${Math.min(stride, terrain.width - 1 - col) / (terrain.width - 1) * width * scale}" height="${Math.min(stride, terrain.height - 1 - row) / (terrain.height - 1) * depth * scale}" fill="${Number.isFinite(elevation) ? color : "#ff00ff"}"/>`);
    }
  }
  for (const lake of data.lakes ?? []) pieces.push(`<path d="${[lake.outline, ...lake.holes].map(path).join(" ")}" fill="#30a7cb" fill-opacity=".65" stroke="#007997" fill-rule="evenodd"/>`);
  for (const river of data.rivers ?? []) pieces.push(`<path d="M${point(river.start.x, river.start.z)}L${point(river.end.x, river.end.z)}" fill="none" stroke="#158bcc" stroke-width="${river.halfWidth * 2 * scale}" opacity=".7"/>`);
  for (const road of data.plan?.shoulders ?? []) pieces.push(`<path d="${path(road.outline)}" fill="#e3c566"/>`);
  for (const road of data.plan?.roads ?? []) pieces.push(`<path d="${path(road.outline)}" fill="#d75765" stroke="#802c39" stroke-width=".4"/>`);
  for (const site of data.plan?.buildingSites ?? []) pieces.push(`<path d="${[site.outline, ...site.holes].map(path).join(" ")}" fill="#ac77c4" stroke="#653b7a" fill-rule="evenodd"/>`);
  let triangles = 0;
  const offset = (data.offset ?? { x: 0, z: 0 }) as { x: number; z: number };
  for (const mesh of data.meshes ?? []) {
    const p = mesh.attributes.position ?? [];
    const m = mesh.worldMatrix;
    const transform = (x: number, y: number, z: number) => ({
      x: x * m[0] + y * m[4] + z * m[8] + m[12] - offset.x,
      z: x * m[2] + y * m[6] + z * m[10] + m[14] - offset.z,
    });
    if (mesh.instanceMatrices?.length) {
      for (const instance of mesh.instanceMatrices) {
        const position = transform(instance[12], instance[13], instance[14]);
        const [x, y] = point(position.x, position.z).split(",");
        pieces.push(`<circle cx="${x}" cy="${y}" r="1.5" fill="#476d51"/>`);
      }
      continue;
    }
    const stride = Math.max(1, Math.ceil(mesh.indices.length / 3 / 20000));
    for (let i = 0; i < mesh.indices.length; i += 3 * stride) {
      const vertices = mesh.indices.slice(i, i + 3).map(index => transform(p[index * 3], p[index * 3 + 1], p[index * 3 + 2]));
      if (vertices.length !== 3 || vertices.some(v => !Number.isFinite(v.x + v.z))) continue;
      pieces.push(`<path d="${path(vertices)}" fill="none" stroke="#173f49" stroke-opacity=".25" stroke-width=".4"/>`);
      triangles++;
    }
  }
  for (const field of data.placements ?? []) for (let i = 0; i < field.count; i++) {
    const [x, y] = point(field.matrices[i * 16 + 12], field.matrices[i * 16 + 14]).split(",");
    pieces.push(`<circle cx="${x}" cy="${y}" r="1" fill="#298344"/>`);
  }
  const legend = data.changePreview ? "Terrain change: red = raised, blue = cut, gray = unchanged; saturated at +/-2 m"
    : `Gray: elevation (${range[0].toFixed(1)} to ${range[1].toFixed(1)} m); blue: water; red: roads`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="850" viewBox="0 0 800 850" role="img" aria-label="${escapeXml(stage)}"><rect width="800" height="850" fill="#f6f7f8"/><defs><clipPath id="tile"><rect x="${400 - width * scale / 2}" y="${400 - depth * scale / 2}" width="${width * scale}" height="${depth * scale}"/></clipPath></defs><g clip-path="url(#tile)">${pieces.join("")}</g><rect x="${400 - width * scale / 2}" y="${400 - depth * scale / 2}" width="${width * scale}" height="${depth * scale}" fill="none" stroke="#111"/><g font-family="sans-serif" font-size="13" fill="#17232b"><text x="40" y="22">${escapeXml(stage)} | North up | ${Math.round(width * (data.frame?.metersPerUnit ?? 1))} m wide</text><text x="40" y="795">${legend}</text><text x="40" y="816">Purple: buildings; green: vegetation; wireframe: mesh (${triangles} displayed triangles)</text><text x="40" y="837">Preview: terrain at most 128 cells/axis; mesh at most ~20k triangles/mesh. JSON is full resolution.</text></g></svg>`;
}

export function renderTileGenerationReport(report: TileGenerationReport): string {
  const encoded = JSON.stringify(report).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Tile ${escapeXml(report.tile)}</title><style>body{margin:24px;font:14px system-ui;color:#17232b;background:#f6f7f8}nav{display:flex;gap:8px;flex-wrap:wrap}button,select{padding:8px;max-width:100%}main{max-width:1000px}img{width:100%;max-width:800px}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#006d86}</style><h1>Tile ${escapeXml(report.tile)} (${report.native ? "native" : "far"})</h1><nav><select id="stage" aria-label="Stage"></select><select id="view" aria-label="Image view"><option value="image">Stage geometry</option><option value="terrainChangeImage">Terrain change</option></select><button id="json">Download stage JSON</button><button id="svg">Download stage SVG</button><button id="all">Download all data</button></nav><main><pre id="details"></pre><img id="image" alt="Stage geometry"></main><script type="application/json" id="report">${encoded}</script><script>
const report=JSON.parse(document.getElementById('report').textContent), select=document.getElementById('stage');
report.stages.forEach((s,i)=>{const o=document.createElement('option');o.value=i;o.textContent=s.sequence+'. '+s.stage+' ('+s.status+')';select.append(o)});
const view=document.getElementById('view');let imageUrl;function show(){const s=report.stages[Number(select.value)];if(!s)return;document.getElementById('details').textContent=JSON.stringify({status:s.status,reason:s.reason,durationMilliseconds:s.durationMilliseconds,diagnostics:s.diagnostics,captureError:s.captureError},null,2);if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=URL.createObjectURL(new Blob([s[view.value]||s.image],{type:'image/svg+xml'}));document.getElementById('image').src=imageUrl;}
function save(name,data,type){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([data],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
select.onchange=show;view.onchange=show;document.getElementById('json').onclick=()=>{const s=report.stages[Number(select.value)];save(s.sequence+'-'+s.stage+'.json',JSON.stringify(s,null,2),'application/json')};document.getElementById('svg').onclick=()=>{const s=report.stages[Number(select.value)];save(s.sequence+'-'+s.stage+'-'+view.value+'.svg',s[view.value]||s.image,'image/svg+xml')};document.getElementById('all').onclick=()=>save('tile-generation.json',JSON.stringify(report,null,2),'application/json');show();
</script></html>`;
}

/** Capture only the selected tile, retaining at most two revisions until cleared. */
export function installTileGenerationDebug(query: URLSearchParams): ((tile: string, native: boolean, seed: number) => TileGenerationCapture | undefined) {
  const reports: TileGenerationCapture[] = [];
  const enabled = query.has("tile-debug");
  let selected = query.get("tile-debug") || undefined;
  if (enabled && typeof window !== "undefined") {
    const api = {
      stages: TILE_GENERATION_STAGES,
      list: () => reports.map(({ report }) => ({ id: report.id, tile: report.tile, native: report.native,
        stages: report.stages.map(s => ({ stage: s.stage, status: s.status })) })),
      get: (id = reports.at(-1)?.report.id) => snapshotTileData(reports.find(c => c.report.id === id)?.report ?? null),
      clear: () => { reports.forEach(capture => capture.clear()); reports.length = 0; },
      download: (id = reports.at(-1)?.report.id) => {
        const report = reports.find(c => c.report.id === id)?.report;
        if (!report) throw new Error("No captured tile revision");
        const url = URL.createObjectURL(new Blob([renderTileGenerationReport(report)], { type: "text/html" }));
        const link = document.createElement("a"); link.href = url;
        link.download = `tile-${report.tile.replace(/[^a-z0-9-]/gi, "_")}-${report.native ? "native" : "far"}.html`;
        link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    };
    (window as unknown as { tileGenerationDebug: typeof api }).tileGenerationDebug = api;
  }
  return (tile, native, seed) => {
    if (!enabled || reports.length >= 2 || (!selected && !native)) return undefined;
    selected ??= tile;
    if (selected !== tile) return undefined;
    const capture = new TileGenerationCapture(tile, native, seed, `${tile}/${native ? "native" : "far"}/${Date.now()}/${reports.length}`);
    reports.push(capture);
    return capture;
  };
}
