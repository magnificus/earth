# Babylon.js Earth

A 3D Earth visualization built with Babylon.js, TypeScript, and Webpack.

![Babylon.js](https://img.shields.io/badge/Babylon.js-7.0-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)
![Webpack](https://img.shields.io/badge/Webpack-5.89-blue)

## Features

- 🌍 Interactive 3D Earth with atmosphere effect
- 🌙 Orbiting moon with animation
- ✨ Dynamic starfield background
- 🎥 Auto-rotating camera with manual control
- 📦 Production-ready Webpack build
- 🚀 GitHub Actions CI/CD with GitHub Pages deployment

## Getting Started

### Prerequisites

- Node.js 22.5+ for the local SQLite backend
- pnpm (`npm install -g pnpm`)

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd earth

# Install dependencies
pnpm install
```

### Development

Start the development server with hot reload:

```bash
pnpm dev
```

The app will open at [http://localhost:3000](http://localhost:3000)

The game backend is a separate local process. Start it alongside the frontend:

```bash
pnpm game:dev
```

Local player state is persisted in `data/earth.sqlite` by the backend, not in browser storage.
The browser connects to `ws://localhost:3001/game`; pass `?game-backend=wss://...` when using
another backend endpoint.

### Production Build

Create an optimized production build:

```bash
npm run build
```

The output will be in the `dist/` directory.

### Tree Impostor Experiment

Open `http://localhost:3000/?tree-impostor` to run the tree-only capture tool.
The controls configure the number of samples along each cube-face edge and the
resolution of each capture. The default produces 150 captures: six faces,
each with a 5 by 5 grid of 192 px frames. Streamed regional tree atlases use
the same directional grid and frame resolution; only their capture scheduling
is cooperative so the work can be spread across gameplay frames.

The source family contains deterministic procedural birch, pine, and spruce trees. Birch uses
tapered branches with runtime-generated bark and textured leaf cards; pine and spruce use distinct
procedural conifer silhouettes. Forest placements mix all three species in the scene.

`treeDistributionAt(longitude, latitude)` in `src/TreeDistribution.ts` supplies the next-stage
geographic species mix. It returns a broad biome, coarse tree-cover potential, and normalized ratios
for eleven common visual tree groups. Exact forest presence should continue to come from ESA
WorldCover 2021; the coordinate-only distribution is an offline approximation, not a botanical survey.
Every group now has its own deterministic procedural source. Tree placement samples the geographic
ratios from each tile's longitude/latitude coordinates first, then captures impostors only for the
species that were actually encountered in that tile.
After capture, that source mesh is disabled and the scene renders only a
camera-facing impostor. Its shader selects the dominant cube face and
bilinearly blends the four nearest frames. `Export ZIP` writes the six face
atlas PNGs and a JSON manifest; captured alpha is strictly 0 or 255 and RGB is
black wherever alpha is zero.

The Earth view generates mature trees, saplings, grass, wildflower colonies, bushes, fern
undergrowth, and low-poly rocks procedurally at startup and thin-instances them across suitable ESA
WorldCover classes. Mature trees and 3.5 m saplings share the six-face tree
impostor pipeline and geographic species groves. Grass captures only one side and
the top; directional wildflowers, bushes, and ferns retain several side views. Their atlases use the optional
upper-hemisphere mode, spending every vertical row on level-to-overhead views
because these low vegetation types are not normally seen from below. Tree captures
retain the full below-to-above range and use 5 horizontal by 5 vertical samples
per face. Each tree frame keeps a 192 px height and derives its narrower width
from the generated tree's bounding box.

Rocks are low-poly procedural meshes with smooth surface normals. Most are partly
buried, while a smaller set barely peeks through the soil. Damp biomes increase
the chance of moss, which colors only upward-facing patches. Along shorelines,
coherent noise selects intermittent formations of tightly spaced rocks stretched
parallel to the local water boundary; the regular inland scatter is suppressed
inside that shoreline band.
Selected natural shore stretches also receive dense procedural pebble patches.
These use the grass-style model/impostor pipeline: nearby patches retain their
low-poly stones while distance switches to an upper-hemisphere atlas. Mapped bare
and shingle shore has the strongest coverage, with world-anchored broad variation
preventing the effect from appearing uniformly along every beach.

Tree foliage is baked for the calendar date captured at world startup.
Temperate deciduous trees gain sparse spring crowns, autumn color and leaf loss,
or bare winter silhouettes; seasons reverse in the southern hemisphere, while
tropical and evergreen crowns remain stable. Models and their impostors are
generated from the same seasonal geometry. Changing the date control later only
updates the sky and intentionally does not rebuild vegetation.
During that hemisphere's winter, non-tropical terrain uses a shared snow
material and grass placement is suppressed as well.

`tree-impostor-x-samples`,
`tree-impostor-y-samples`, and `tree-impostor-resolution` query parameters can
override those defaults for quality testing, up to a maximum resolution of 256
px. Grass uses a 5 by 5 grid at
128 px by default. `grass-impostor-x-samples`,
`grass-impostor-y-samples`, and `grass-impostor-resolution` query parameters
can override those values for quality testing.

Bushes are generated from procedural branches and dense curved shoots, captured
into their own directional atlases, and scattered in noise-shaped clusters most
densely through WorldCover shrubland with lighter placement elsewhere.
Wildflower regions choose between tall fireweed-like spires and the former short
daisy patches. Both share one denser colony field, model/impostor lifecycle, and
regional variant bank.
Fern clumps use paired tapered leaflets and form rare patches predominantly
beneath tree cover, with occasional growth in shrubland, wetlands, and
mangroves. Saplings and ferns are created only for the
fully detailed tile rings; distant tiles retain their cheaper mature-tree layer.

Grass, wildflowers, bushes, and ferns lean in a looping wind cycle; trees remain still.
`src/Wind.ts` owns the shared cycle and its GLSL shear. Displacement grows
linearly with height above the base, so roots stay planted and tips lean
furthest. Gusts travel across the world, making an instance's position set its
phase so nearby vegetation reads as one moving air mass.

The shear needs no captured animation frames. Real geometry adds the gradient
to its vertices, while an impostor subtracts the same gradient from the point it
samples inside its static atlas frame. Both LODs therefore lean by the same
amount without adding a time dimension to the atlas. Because nothing is baked,
the wind can follow one world direction and include a second harmonic even for
the rotationally symmetric grass and bush atlases.

Displacing the sample point *after* it has been projected is what anchors the
lean to the subject rather than to its proxy box, which for grass is over four
times the clump's own height. Side on, image height is capture height, so the
frame shears progressively. From overhead the projection plane is level and the
whole frame shifts by the lean at mid-height, which is as close as a flat lookup
gets to a silhouette smeared through every height. The technique needs slack
around the subject inside its frame; the square captures of low vegetation have
it, and a tightly fitted capture like the trees' would clip.

`?wind=0` removes grass, wildflower, bush, and fern motion; values up to 3 scale it.

Vegetation shadows remain cached and therefore do not animate with wind. The
shadow map renders once and refreshes when the LOD packing or sun changes;
redrawing every grass caster continuously would be substantially more expensive.

Impostor capture is model-agnostic. `src/Impostor.ts` owns sampling validation,
URL overrides, per-scene reuse, source disposal, optional bounds fitting, and
atlas generation. To add another procedural model, define an
`ImpostorDefinition` with its geometry factory, capture dimensions, sampling
limits, faces, and symmetry, then create its provider with
`createImpostorAssetProvider`. The tree, bush, and grass files are examples;
they contain only model-specific geometry and descriptor values.

Procedural vegetation models are location-bound through virtual 256 by 256
application-tile regions. Trees, bushes, grass, wildflowers, and ferns use
independently shifted region grids, so their model captures normally change at
different locations. A four-tile-per-side border band assigns nearby placements to either
neighbor with deterministic spatial weights; this creates a gradual population
transition without drawing two models per plant. Mature trees and saplings share
the tree grid. Every region receives its own deterministic procedural model;
there is no repeating model palette during long-distance travel. Regional model
and impostor sources use the same seed, while leased per-scene atlas caches retain
active regions and evict older captures so infinite variation does not imply
unbounded GPU memory.
Use `?procedural-region-size=8` to make boundaries frequent during testing; the
value is normalized to a power of two so regions wrap cleanly at the date line.

Each application tile also samples a normalized procedural-actor mix from
world-seeded simplex fields using its tile X/Y coordinates. The mix biases the
relative density of trees, bushes, grass, ferns, wildflowers, and rocks. Nearby
tiles therefore transition gradually while distant areas gain distinct character;
the same world seed and tile ID always reproduce the same mix.

The production view renders grass and bushes as dense impostor clumps. Mature
trees, saplings, and fern undergrowth can switch between impostors, automatic
distance LOD, and original geometry. Auto mode uses a
dithered 6 m transition around the configurable model range (50 m by default)
to blend real models into impostors. Press `V` to cycle the tree mode.
The top-right counter reports live FPS and active triangles; use
`?vegetation=models` to force tree models or
`?vegetation-distance=20` to change the initial Auto range.

The sky includes distant procedural cloud impostors. Eight density variants span
bank, clustered, broken, and tower-like formations generated at startup by
integrating deterministic three-dimensional cloud volumes. Each formation is
captured from eight azimuths and blends between adjacent views at runtime, so it
retains the low draw cost of a thin-instanced billboard while its silhouette
changes like a volume as the camera moves around it. Runtime clouds use compact
cumulus-like proportions and are independently mirrored to make repeated
captures less apparent. A separate top-down density capture projects the four
cloud footprints nearest the visible terrain directly along the current sun
direction. The terrain samples these impostors in world space without expanding
or continuously invalidating the local tree and building shadow map. Clouds share a 7 km altitude and drift
together with the prevailing wind; their shadows follow the same drift. Their deterministic world
grid is sampled in that moving frame so new formations remain beyond the visible
horizon. Each geographic area receives a weighted clear, sparse, scattered, or
dense weather regime. Cloud-bearing skies dominate: scattered conditions are most
common, dense banks remain significant, and clear weather is rare. Grayscale
density provides smooth alpha coverage without a screen-space dither pattern,
with solid shaded cores and softer edge coverage. Clouds fade out before the
camera reaches them and through their own high-altitude haze beyond the terrain
fog; use `?clouds=off` for a cloud-free performance comparison.
Use `?time=12` to hold the sun at noon when comparing cloud shape and ground
shadows, and `?date=2026-08-23` to hold the simulation on a specific local
calendar date. Automatic game time follows the current local time with the year
shifted 100 years ahead and the clock shifted four hours back. The settings menu's Manual clock
toggle switches the date and time together. Clock mode and the last manual date
and time persist across reloads, allowing a reload to regenerate seasonal trees
for the selected date. `?clock=automatic` or `?clock=manual` can override the
persisted mode; supplying `?date` or `?time` selects manual mode by default.

The world uses an application-owned Web Mercator grid at fixed level 16. A tile
is identified by the app's level/x/y coordinates and receives a stable seed from
the world seed and that identity. Elevation, WorldCover, and OpenStreetMap tile
coordinates are source implementation details used only to populate the app
tile's geographic bounds. Because this is Web Mercator, ground dimensions vary
with latitude (a tile is about 307 m wide around Oslo). Use `?seed=123`
to select another deterministic world seed.

Terrain streams across a moving 17 by 17 tile window around the camera. The
inner 3 by 3 tiles include native terrain, map features, and full vegetation;
the outer rings
use coarse terrain and tree impostors so the visible horizon reaches farther
without paying the full detail cost. Overlapping elevation, WorldCover, and
OpenStreetMap source requests are cached between tile loads. CPU-heavy terrain,
map, vegetation, and LOD-index construction runs in small post-render slices.
Large terrain and vegetation GPU uploads are committed on separate animation
frames so replacement tiles have less impact on frame rate.

Click the world once to capture the pointer; looking around then follows mouse
movement without holding a button in either movement mode. Press Escape to
release the pointer and open the settings menu. It can resize both streaming
windows, adjust cloud density at runtime, set the date and time of day, and load a new
world location from latitude and longitude. Grass density remains fixed at 1.
Numeric scene settings are remembered in local storage. The same settings can
be initialized with `?detail-size=3`, `?terrain-size=17`, and
`?cloud-density=0.5`; explicit URL values override remembered values for that
page load.

`?render-scale=0.75` renders at 75% of the canvas resolution (values are clamped
from 0.25 through 1), and
`?vegetation=impostors` avoids the more expensive nearby models. These options
can be combined, for example:

`?render-scale=0.75&vegetation=impostors&performance-debug`

WebGL remains the default renderer. Use `?renderer=webgpu` to try Babylon's
WebGPU engine; unsupported devices or initialization failures automatically
fall back to WebGL. Combine it with `?performance-debug` and press `R` to
download comparable renderer and frame-time diagnostics.

The WebGPU trial starts with regular depth and without screen-space
reflections. Use `?renderer=webgpu&reverse-depth=force` or
`?renderer=webgpu&reflections=force` to isolate those features after validating
the base renderer.

Add `performance-debug` (or `perf`) to expand the top-right counter with frame
time, measured frame pacing, hitch counts, game-loop, movement-LOD, and
render-call CPU averages/peaks, long
animation frames (or long tasks as a fallback), the hottest attributed script,
and a render breakdown for active-mesh evaluation, render targets, draw
submission, GPU frame time, and shader compilation. It also shows streaming
counts, heap use where supported, draw calls, active meshes, and render scale.
Press `F` to toggle the expanded counter at runtime.

Press `R` to download a timestamped JSON render report and mirror it to the
browser console. Reports retain the latest 300 frame samples with percentile
summaries and mark individual stutters with their render-callback cost,
unexplained time outside the callback, frame budget, and concurrent streaming
state. They also include detailed Babylon CPU/GPU counters, recent long-frame
attribution,
browser and GPU capabilities, memory use, camera state, streaming and LOD
configuration, scene resource totals, and every active mesh's geometry and
instance counts. Enable the expanded counter with `F` at least one second before
capturing when the detailed instrumentation is not already enabled.

Press `Shift+B` to download the building polygons from the detailed tile that is
currently loaded in the scene. No startup option is required. The JSON includes
source and metre-space polygons, facade openings, planner results, apartment
layouts, and fallback errors. Replay and render it with:

`yarn layouts:captured <earth-building-layouts.json>`

The command writes SVG plans, a machine-readable summary, and an `index.html`
gallery to `data/captured-building-layouts`.


## Project Structure

```
earth/
├── .github/
│   └── workflows/
│       └── build-deploy.yml    # GitHub Actions CI/CD
├── src/
│   ├── index.html              # HTML template
│   ├── index.ts                # Entry point
│   └── Game.ts                 # Main Babylon.js game class
├── public/                     # Static assets (copied to dist)
├── package.json
├── tsconfig.json               # TypeScript configuration
├── webpack.config.js           # Webpack configuration
└── README.md
```

## Controls

- **G**: Switch between fly and walker modes
- **W/A/S/D**: Move forward, left, backward, and right
- **Q/E**: Fly down and up (fly mode only)
- **Space**: Jump (walker mode only)
- **Mouse + Drag**: Look around
- **Mouse Wheel**: Increase or decrease fly speed (fly mode only)

Walker mode uses a 1.8 m player height, terrain collision, and gravity.

## Deployment

This project includes automated deployment to GitHub Pages:

1. Push to `main` or `master` branch
2. GitHub Actions will automatically build and deploy
3. Your site will be available at `https://<username>.github.io/<repo-name>`

### Manual Deployment

To deploy manually to any static hosting:

```bash
pnpm build
# Upload the contents of dist/ to your hosting provider
```

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start development server |
| `pnpm build` | Create production build |
| `pnpm clean` | Remove dist folder |

## Customization

### Adding Textures

The normal terrain appearance is isolated in `src/TerrainMaterial.ts`. Its
procedural detail texture is tinted with softly blended ESA WorldCover surface
colors so vegetated ground visually supports the grass, bush, and tree layers.
Place texture images in the `public/` folder and assign them in that factory:

```typescript
import { Texture } from '@babylonjs/core';

material.diffuseTexture = new Texture('/terrain-texture.jpg', scene);
```

Detailed tiles refine ESA WorldCover 2021 with globally available OpenStreetMap
land-cover and land-use polygons. OSM also supplies building-part visibility,
road class, path and service type, surface, tunnels, and permanent waterways;
those attributes drive building filtering, road widths and materials, vegetation
placement, and narrow water surfaces without relying on regional data sources.
Street lamps are placed deterministically from the road plan. The client does not
query the public Overpass API while streaming terrain detail.

### Interior building layouts

`BuildingLayoutPlanner.ts` contains the renderer-independent interface for
dividing a local, meter-based building footprint into apartment, hallway, and
stair polygons. Footprints up to 120 m² remain one apartment shell. Larger
footprints receive common circulation and are divided into apartment shells no
larger than 120 m². The same algorithm is currently used for every building
type. The stair core sits beside one continuous hallway and is placed
deterministically so matching floors retain the same vertical core. A supplied
exterior door creates an entrance-lobby branch to the hallway; the stair moves
beside that lobby instead of occupying the doorway. Apartment entrance doors
are generated on each shared apartment–hallway boundary.

`ApartmentLayoutPlanner.ts` recursively bisects an apartment into equally sized
rooms with orthogonal walls. It stops before either resulting room would be
smaller than 10 m² and tries the other axis when a proposed wall intersects a
supplied door or window segment.

```typescript
import { planBuildingLayout } from "./BuildingLayoutPlanner";
import { renderFloorPlanSvg } from "./FloorPlan";

const layout = planBuildingLayout({
  buildingType: "apartment-building",
  buildingPolygon: {
    outer: [
      { x: 0, y: 0 }, { x: 20, y: 0 },
      { x: 20, y: 12 }, { x: 0, y: 12 },
    ],
  },
});

const svgImage = renderFloorPlanSvg(layout, { width: 900, height: 600 });
```

`renderFloorPlanSvg` depends only on the generic `PolygonLayout` contract, so
the apartment-room planner and other future planners can use the same image
pipeline. Callers can display the returned SVG directly or save it as an
`.svg` file for design review. Optional `door` and `window` opening segments are
included in planner output and drawn over the plan outline.

Run `yarn layouts:examples` to regenerate rectangular, tapered, and angled
example plans in `data/layout-examples`.

### Road and building plans

`RoadAndBuildingPlanImage.ts` turns the renderer-independent output of
`planRoadsAndBuildings` into a standalone, north-up SVG. The image uses the
plan's complete tile bounds, so sparse and empty plans retain the same scale.
It draws the exact partitioned road surfaces and shoulders, building footprints
and holes, building plots, street lamps, road markings, layers, and structures
with machine-readable SVG data attributes for future planning diagnostics.

The plan also places street lamps (mapped lamp nodes plus deterministic
road-side infill just beyond the planned road bed) and designates one convex
plot per building. Plots grow outward from the building, then are cut flush
against nearby road beds, the tile bounds, and the bisector toward each
neighboring plot, so adjacent plots share their dividing boundary exactly —
the attachment line for future hedgerows and fences.

```typescript
import { renderRoadAndBuildingPlanSvg } from "./RoadAndBuildingPlanImage";

const svgImage = renderRoadAndBuildingPlanSvg(plan, {
  width: 1000,
  height: 700,
  title: "Road and building planning",
  showLabels: true,
});
```

Run `yarn site-plan:example` to write an example to
`data/road-building-plan-examples/site-plan.svg`.

### Modifying the Scene

Edit `src/Game.ts` to customize:
- Lighting and colors
- Camera settings
- 3D objects and materials
- Animations

## Tech Stack

- **[Babylon.js](https://www.babylonjs.com/)** - 3D rendering engine
- **[TypeScript](https://www.typescriptlang.org/)** - Type-safe JavaScript
- **[Webpack](https://webpack.js.org/)** - Module bundler
- **[GitHub Actions](https://github.com/features/actions)** - CI/CD

## License

MIT
