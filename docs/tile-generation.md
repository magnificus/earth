# Per-Tile Generation

Each terrain revision owns a `TileGeneration` instance. Stage dependencies are
checked even when debug capture is disabled. Native/far promotion creates a new
revision; scenery rebuilds may repeat downstream stages. Vegetation and map
geometry can run concurrently after water meshes are ready.

| Stage | Output |
| --- | --- |
| sources | Unmodified terrain, provider GeoJSON (all context layers), land-cover rasters, candidate water polygons, waterway segments, tile frame and source inputs |
| relief | Terrain after procedural relief |
| coastline | Terrain after land-cover shaping; pre-carving elevation reference |
| water-selection | Accepted polygons, per-source acceptance decisions and context polygons |
| lake-terrain | Water levels, lake beds, shoreline terrain and support diagnostics |
| river-terrain | Carved river channels |
| site-plan | Road planning inputs and full roads/buildings/plots/lamps/boundaries plan |
| building-pads | Terrain after building pads, before road shaping |
| road-grades | Terrain after road earthworks; far tiles explicitly skip both earthwork stages |
| stitching | Final terrain after shared-edge stitching |
| terrain-mesh | Terrain geometry buffers and world transform |
| water-mesh | Lake geometry, water outlines and shared ocean-plane descriptor |
| buildings | Semantic building plans, available interior layout captures and exterior mesh buffers; far tiles capture massing |
| roads-rivers | Road/bridge/river mesh buffers; far tiles defer river ribbons |
| vegetation | Instance placements for each vegetation field, rock meshes, actor mix and seasonal inputs; far tiles capture trees |
| props | Lamp and boundary plans and meshes; far tiles explicitly skip geometry |

Stage 1 waits for elevation and OSM context before any relief, coastal, lake,
river, building, or road shaping. Context includes the existing lake terrain
margin beyond the tile. Water candidates are collected from those context tiles,
including polygons crossing application/provider boundaries. Source GeoJSON
retains provider-clipped features, including underground water excluded from
surface generation. This does not fetch complete upstream river networks or
entire lakes beyond the provider/context extent.

## Capture

Open the app with `?tile-debug` (or append `&tile-debug`). It selects the first
native tile built, normally the spawn tile. To select another tile explicitly,
use `?tile-debug=<worldTileKey>`; explicit selection also captures far revisions.
Only two revisions of the selected tile are retained, preventing continuous
streaming from accumulating captures. Full geometry captures are intentionally
limited to 64 stage snapshots per revision, including repeated scenery rebuilds;
the report records when that limit is reached. Full geometry captures are
expensive; leave the option off for normal play and performance measurements.

Use the browser console:

```javascript
tileGenerationDebug.list()          // captured revisions and completed stages
tileGenerationDebug.download()      // latest revision as a standalone HTML report
tileGenerationDebug.download(id)    // specific revision
tileGenerationDebug.get(id)         // detached JSON-compatible report
tileGenerationDebug.clear()         // release retained reports; subsequent builds capture again
```

The report works offline. Select a stage and switch between its north-up geometry
image and a terrain-change image (red = fill, blue = excavation). Download the
selected SVG, the full stage JSON, or all data. Elevation coloring uses one fixed
range per revision; terrain-change coloring saturates at +/-2 meters. Images are
diagnostic plan views, not photorealistic screenshots. Terrain previews sample
at most 128 cells per axis and wireframes approximately 20,000 triangles per mesh;
JSON retains all raster samples, mesh vertex attributes, indices, transforms,
and captured instance matrices. Material textures and live Babylon objects are
not serialized. Deferred interior geometry/furniture is not a tile-build output;
the building stage captures its available plans and explicitly identifies it as
deferred.

Snapshots are detached when a stage finishes. Later terrain mutation, mesh
disposal, or tile promotion cannot change them. Diagnostics include changed
sample counts, maximum cut/fill, and non-finite elevations. Failed/cancelled
stages retain the previous available output as context and report their error;
they do not claim a successful result. Capture errors are recorded separately
and do not break world generation. Unreached stages are absent, not successful.

The capture reports existing policies faithfully. It does not fix road/water
crossings or road/building conflicts: the separate river, pad, and road snapshots
make those interactions inspectable.

## Export Files

Run a real tile end to end from the command line, with no browser interaction or
dev server required:

```sh
yarn tiles:debug --lat 59.9047 --lon 10.6110 --out data/tile-casa
```

This builds an isolated app, fetches the tile's data in headless Chrome, runs all
stages, and writes PNG/SVG images, terrain-change images, stage JSON, a complete
capture, an offline report, `manifest.json`, and a `stages.png` contact sheet.
The temporary server and browser close automatically. Chrome defaults to the
standard Windows installation; use `--chrome <path>` or `CHROME_PATH` elsewhere.
Use `--timeout 300` for slow source downloads and `--seed 1337` for repeatability.
Failures export available partial results and exit with an error.

Individual PNGs are 1600 x 1700 pixels. Open `sequence.html` for large, numbered
stages in reading order. `compare-01-02.png`, `compare-02-03.png`, etc. place
consecutive stages side by side with terrain-change statistics. `stages.png`
remains a compact overview; use the individual images for inspection.

```sh
yarn tiles:debug <capture.json> [output-directory]
yarn tiles:debug --example
```

The exporter writes an HTML report, complete capture JSON, and separate PNG/JSON/SVG
files per stage to `data/tile-generation` by default. The synthetic example runs
the real river and road terrain algorithms on a flat crossing through the
road-grades stage, making the existing channel-refilling behavior visible.
