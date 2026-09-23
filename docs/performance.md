# Performance and Diagnostics

[Back to Earth](../README.md)

## Creation Statistics

Creation diagnostics produce one `[Creation stats / 10s]` console report every
10 seconds while active, with counts, totals, averages, minimums and peaks for
creation and streaming work. Idle intervals are silent; errors and warnings remain
immediate. Timing values use milliseconds and include waits unless labelled CPU
or slice time. Set `globalThis.buildingTimingEnabled = false` to disable building
and interior timing collection. Adjust `CREATION_STATS_INTERVAL_MS` in
`src/diagnostics/CreationStats.ts` to change the reporting interval.

## Runtime Diagnostics

Add `performance-debug` (or `perf`) to expand the top-right counter with frame
time, measured frame pacing, hitch counts, game-loop, movement-LOD, and
render-call CPU averages/peaks, long
animation frames (or long tasks as a fallback), the hottest attributed script,
and a render breakdown for active-mesh evaluation, render targets, draw
submission, GPU frame time, and shader compilation. It also shows streaming
counts, heap use where supported, draw calls, active meshes, and render scale.
Press `Shift+F` to toggle the expanded counter at runtime.

Press `R` to download a timestamped JSON render report and mirror it to the
browser console. Reports retain the latest 300 frame samples with percentile
summaries and mark individual stutters with their render-callback cost,
unexplained time outside the callback, frame budget, and concurrent streaming
state. They also include detailed Babylon CPU/GPU counters, recent long-frame
attribution,
browser and GPU capabilities, memory use, camera state, streaming and LOD
configuration, scene resource totals, and every active mesh's geometry and
instance counts. Enable the expanded counter with `Shift+F` at least one second before
capturing when the detailed instrumentation is not already enabled.

## Building Layout Capture

Per-tile stage images and complete numerical/geometry snapshots are available
with `?tile-debug`. See [Per-tile generation](tile-generation.md) for stage order,
offline reports, exports, and capture limits.

Press `Shift+B` to download the building polygons from the detailed tile that is
currently loaded in the scene. No startup option is required. The JSON includes
source and metre-space polygons, facade openings, planner results, apartment
layouts, and fallback errors. Replay and render it with:

`yarn layouts:captured <earth-building-layouts.json>`

The command writes SVG plans, a machine-readable summary, and an `index.html`
gallery to `data/captured-building-layouts`.

## Memory Regression Test

Run `yarn test:memory` for a five-minute stationary soak at Reso with the default
33-tile terrain diameter. It uses an isolated headless Chrome profile, samples
garbage-collected heap and backing buffers, and fails above 1.5 GiB or if memory
keeps growing after all scenery loads. Measurements, allocation profiles, and a
final screenshot are saved under `.cache/memory-soak/`.

Use `--seconds=600` for a longer run or `--heap-mb=512` to stress the renderer
with a smaller JavaScript heap. To replay another location and settings:

```bash
yarn test:memory --fixture="terrain-size=33&detail-size=2&lat=58.79605454&lon=11.18236156"
```

The runner requires Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`.

## Oslo walking performance test

Run `yarn test:oslo-walk` on Windows with Chrome installed. It builds an isolated
test bundle, spawns at 59.9116, 10.7334 in central Oslo, and holds forward in
walking mode facing west until horizontal displacement reaches 100 meters.
Normal collisions, streaming, scene detail, and rendering remain active. The
test starts after initialization without waiting for far terrain to settle.

Each run writes `artifacts/oslo-walk/<timestamp>/results.json`, `errors.json`,
`browser.log`, and `finish.png`. Failures after the walk runner starts retain
`failure.json`; earlier browser-launch/navigation failures retain diagnostics
in the printed temporary build/profile directories.
The JSON retains every walking frame, positions, CPU timings, new shader effects,
browser stalls, streaming diagnostics, settings, GPU identity, and a summary.
The command fails for an incomplete/blocked route, browser errors, an unfocused
page, or any frame interval over **33.33 ms**. A 10-second lack of progress ends
a blocked route. This is a machine-dependent performance check, separate from
the unit suite; a passing run only certifies this route and configuration.
The application's adaptive stutter flags are also counted separately: a fixed
33.33 ms pass does not mean perfectly uniform frame pacing.

Diagnostic options:

- `--metrics`: enable the application's detailed renderer/GPU instrumentation.
  Default validation keeps the normal HUD state while still recording every
  frame interval and the game's CPU timings.
- `--profile`: save a Chrome CPU profile as `walk.cpuprofile`.
- `--trace`: save `trace.json` for Chrome/Perfetto timeline inspection.
- `--trace --trace-gpu`: trace individual GPU calls for roughly the first two
  seconds (higher overhead); frame measurements still cover the entire walk.
- `--max-frame-ms=50`: explicitly change the failure limit; the limit is recorded.
- `--no-direct-composition`: Windows compositor comparison only; changes the
  browser presentation path and must not be reported as an application fix.
- `--bundle=<absolute-directory>`: reuse an already compiled test bundle for
  controlled comparisons. Omit this after changing application source.

Profiling can affect timings. Run validation without profiling, with other
performance tests and builds stopped. Chrome gets its own temporary profile,
debugging port and tab; the test closes its browser on completion.
Compilation runs in a separate process that exits before Chrome starts.
