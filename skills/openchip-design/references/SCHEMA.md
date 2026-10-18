# Raw graph mode — the `.openchip` file, field by field

A `.openchip` file is plain JSON, pretty-printed with two-space indentation and
a trailing newline. There is no wrapper: the file *is* the project object.

Use raw mode when the user asks for it, when they want to hand-edit the result,
or when they are extending a `.openchip` file that already exists. Everything
the DSL can express, this can too — it is simply the DSL's output.

Whichever mode you use, run the checker before handing the file over:

```bash
# <skill dir> is wherever this skill is installed.
node <skill dir>/scripts/openchip.mjs check chip.openchip
```

## Top level

```json
{
  "formatVersion": 1,
  "meta": { "name": "…", "createdAt": "…", "modifiedAt": "…", "units": "mm" },
  "printerProfile": { "…": "…" },
  "chipParams": { "…": "…" },
  "channelGraph": { "nodes": [], "edges": [] },
  "fluidProfiles": [],
  "fluidSetup": { "assignments": [], "chipMaterialThermalConductivityWmK": 0.2 },
  "savedImages": [],
  "drainageVents": [],
  "presetLibraryRef": null
}
```

`formatVersion`, `meta`, `printerProfile`, `chipParams` and `channelGraph` are
required. The rest have defaults and may be omitted — but write them anyway, so
the file reads the same as one the app saved.

Every measurement is millimetres unless the field name says otherwise
(`…Microns`, `…UlPerMin`, `…C`). Coordinates put the origin at the chip's
bottom-left corner, `+x` right, `+y` up, `+z` out of the top face.

## `meta`

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Non-empty. Becomes the suggested filename. |
| `createdAt` / `modifiedAt` | string | ISO-8601. Use the same value for both on a new file. |
| `units` | `"mm"` | The only accepted value. |

## `printerProfile`

| Field | Type |
| --- | --- |
| `name` | string |
| `xyResolutionMicrons` | number > 0 |
| `layerHeightMicrons` | number > 0 |
| `minFeatureSizeMm` | number > 0 |
| `buildVolumeMm` | `{ x, y, z }`, all > 0 |

The three built-ins, copied verbatim from the app:

```json
{ "name": "Standard 4K resin printer",  "xyResolutionMicrons": 35, "layerHeightMicrons": 50, "minFeatureSizeMm": 0.2,  "buildVolumeMm": { "x": 143, "y": 89,  "z": 175 } }
{ "name": "High-resolution 8K / 12K",   "xyResolutionMicrons": 20, "layerHeightMicrons": 30, "minFeatureSizeMm": 0.12, "buildVolumeMm": { "x": 219, "y": 123, "z": 260 } }
{ "name": "Large-format resin printer", "xyResolutionMicrons": 46, "layerHeightMicrons": 50, "minFeatureSizeMm": 0.25, "buildVolumeMm": { "x": 298, "y": 165, "z": 300 } }
```

## `chipParams`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `width` / `length` | number > 0 | 40 / 60 | Footprint in X and Y. |
| `baseThickness` | number > 0 | 4 | Total block height. |
| `wallThickness` | number > 0 | 2 | Minimum material between a channel and anything else. |
| `minEdgeSpacing` | number ≥ 0 | 3 | Minimum clearance to the chip boundary. |
| `splitType` | `two-piece` \| `monolithic` \| `glass-slide` | `two-piece` | |
| `splitHeight` | number ≥ 0 | 2 | Cut plane Z. Ignored by `glass-slide`; **outside `0 < z < baseThickness` the chip prints sealed.** |
| `slide` | object | 75 × 25 × 1 mm | Only used by `glass-slide`. |
| `defaultChannelWidthMm` | number > 0 | 0.8 | Applied to any edge with no dimension markers. |
| `defaultChannelHeightMm` | number > 0 | 0.5 | Unused by `round`. |
| `defaultCrossSection` | `round` \| `rect` \| `trapezoid` | `rect` | |

`slide`: `{ widthMm, lengthMm, thicknessMm, clearanceMm, bondGapMm, offsetXMm, offsetYMm }`.
Defaults `{ 75, 25, 1, 0.2, 0, 0, 0 }` — a plain microscope slide, which does
*not* fit the default 40 × 60 chip. Size the chip to the slide, not the reverse.

## `channelGraph.nodes`

All nodes share `id` (unique, non-empty), `x`, `y`, `type`.

**Waypoint** — a plain vertex:
```json
{ "id": "j1", "x": 20, "y": 47, "type": "waypoint" }
```

**Port** — where fluid enters or leaves:
```json
{
  "id": "inletA", "x": 13, "y": 54, "type": "port",
  "portType": "luer", "diameterMm": 1.6,
  "customSpec": { "taperLargeDiameterMm": 4.27, "taperSmallDiameterMm": 3.858, "taperLengthMm": 7.5, "bossHeightMm": 3.5 }
}
```
`portType` is one of `syringe`, `luer`, `luer-lock`, `luer-male`, `barb`,
`custom`. `luer` and `luer-lock` are **sockets cut into** the chip;
`luer-male` and `barb` are **spigots standing proud of** it — the geometry
pipeline subtracts one and adds the other. `diameterMm` is the through-bore.
Full `customSpec` blocks for every fitting are in `FITTINGS` at the top of
`scripts/openchip.mjs`; copy them rather than inventing taper figures.

**Chamber** — an enlarged volume at a junction or turn:
```json
{ "id": "pot", "x": 20, "y": 40, "type": "chamber", "shape": "sphere", "sizeMm": 4, "autoPlaced": false }
```
`shape` is `sphere` or `cylinder`; `sizeMm` is the diameter either way. Set
`autoPlaced` to `false` for anything you place deliberately.

## `channelGraph.edges`

```json
{
  "id": "e1", "fromNodeId": "inletA", "toNodeId": "j1",
  "curveType": "straight",
  "crossSection": "rect",
  "dimensionPoints": []
}
```

| Field | Notes |
| --- | --- |
| `id` | Unique across edges. |
| `fromNodeId` / `toNodeId` | Must resolve to existing nodes; a dangling id makes the file unopenable. |
| `curveType` | `straight`, or `bezier` with `controlPoints`. |
| `controlPoints` | `[{x,y},{x,y}]` — the two cubic handles, in chip mm. Present only for `bezier`. Fewer than two handles silently degrades to a line. |
| `crossSection` | `round`, `rect` or `trapezoid`. |
| `dimensionPoints` | `[]` means "use the project defaults everywhere". |

A dimension point is `{ "t": 0–1, "widthMm": > 0, "heightMm"?: > 0 }`, where `t`
runs 0 at `fromNodeId` to 1 at `toNodeId`. `heightMm` is omitted for `round`,
where width is the diameter.

**Markers loft across a chain, not an edge.** Edges joined end-to-end through
degree-2 nodes share one arc-length axis; width at any point interpolates
linearly between the neighbouring markers on that axis, and holds constant
outside the outermost ones. A junction of three or more edges ends a chain. So a
single marker on one segment governs a whole run — which is the feature, and
also the way to accidentally resize six segments at once.

## `fluidProfiles`

```json
{ "id": "preset-water", "name": "Water", "builtIn": true,
  "densityKgM3": 998.2, "dynamicViscosityPaS": 0.001002,
  "thermalConductivityWmK": 0.598, "specificHeatCapacityJkgK": 4182,
  "inletTemperatureC": 20 }
```

Ship all six built-ins so the user's fluid picker looks normal — the exact
objects are in `FLUID_PRESETS` in `scripts/openchip.mjs`. Ids: `preset-water`,
`preset-pbs`, `preset-ethanol`, `preset-mineral-oil`, `preset-glycerol-water`,
`preset-blood-analog`. Custom fluids take `builtIn: false` and any unique id.

## `fluidSetup`

```json
{
  "assignments": [
    { "portId": "inletA", "role": "inlet", "fluidProfileId": "preset-water", "flowRateUlPerMin": 10, "inletTemperatureC": null },
    { "portId": "outlet", "role": "outlet", "fluidProfileId": "preset-water", "flowRateUlPerMin": 0, "inletTemperatureC": null }
  ],
  "chipMaterialThermalConductivityWmK": 0.2
}
```

Assign **every** port. The app can only guess otherwise, and a gradient
generator with three of six ports mislabelled shows a confident estimate of the
wrong device. `inletTemperatureC: null` means "use the fluid profile's own".
0.2 W/m·K is standard photopolymer resin.

## `drainageVents`

```json
{ "id": "vent-1", "nodeId": "mid", "diameterMm": 0.8, "autoPlaced": false }
```

Anchored to a node, never to free coordinates, so a vent follows the channel
when it moves and disappears with it. Only meaningful when the chip is
enclosed — see `DESIGN-RULES.md`.

## `savedImages` and `presetLibraryRef`

Leave `savedImages` as `[]`; it holds exported SVG/PNG data URIs the app writes
itself. `presetLibraryRef` is the id of the starter template a project began
from, or `null` — provenance only, nothing enforces it.
