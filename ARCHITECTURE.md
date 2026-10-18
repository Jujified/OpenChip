# Architecture

How OpenChip is put together, for anyone reading or changing the code. For what
the app does and how to use it, see the [README](README.md) and the
[documentation](https://wiki.openchip.tech).

**The stack:** React and TypeScript on Vite; Paper.js for the 2D canvas;
Three.js for the 3D view; [manifold-3d](https://github.com/elalish/manifold)
(WebAssembly) for solid geometry; Zustand for state; Tailwind CSS for styling;
zod for validating project files. Everything runs client-side.

**Conventions:** all physical measurements are millimetres, internally and in
the UI. The coordinate system matches Three.js and manifold-3d: +Z up.

## Layout

```
src/
├── types/project.ts     the .openchip data model — extend, never replace
├── lib/
│   ├── defaults.ts      printer presets, chip defaults, new-project factory
│   ├── schema.ts        zod validation + plain-language error phrasing
│   ├── projectFile.ts   serialise / parse / migrate .openchip
│   ├── fileAccess.ts    File System Access API + download/upload fallback
│   ├── persistence.ts   safe localStorage, debounced writes
│   ├── geometry.ts      vectors, cubics, splitting, corner angles
│   ├── loft.ts          chains + width interpolation along a path
│   ├── graphOps.ts      pure channelGraph operations (split, array, spacing)
│   ├── snapping.ts      endpoint / angle / grid snap resolution
│   ├── hitTest.ts       what is under the cursor, in chip space
│   ├── ports.ts         port types, plus named catalogue fittings
│   ├── shortcuts.ts     the keyboard catalogue the help sheet reads
│   ├── tour.ts          the guided-tour script
│   ├── zip.ts           store-only archive writer
│   ├── download.ts      handing a generated file to the user
│   ├── presentationExport.ts  the bundled figure export
│   ├── siteUrls.ts      links out to the website and documentation
│   ├── wikiLinks.ts     in-app context → documentation anchors
│   ├── presets/
│   │   ├── builders.ts     GraphBuilder, arc handles, spirals, zig-zags
│   │   ├── library.ts      the seven starter templates
│   │   ├── thumbnail.ts    preview geometry for a template card
│   │   └── index.ts        template → project
│   ├── paperScene.ts    Paper.js rendering
│   ├── svgExport.ts     schematic SVG
│   ├── cad/
│   │   ├── placement.ts     where a channel sits in Z, and its profile
│   │   ├── sweep.ts         swept-loft and helical mesh construction
│   │   ├── portGeometry.ts  port cavities, bosses, male cones, barbs, threads
│   │   ├── fittingProfile.ts  a fitting's half-section, for the catalogue drawings
│   │   ├── slide.ts         the glass-slide pocket and its channel plane
│   │   ├── buildChip.ts     the CSG pipeline
│   │   ├── creasedMesh.ts   render-ready meshes with creased normals
│   │   ├── stlExport.ts     binary STL
│   │   └── scadExport.ts    editable OpenSCAD source
│   ├── validation/
│   │   ├── manufacturability.ts  min feature, clearance, build volume, overhangs
│   │   ├── flow.ts            dead ends, islands, abrupt tapers
│   │   ├── drainage.ts        enclosure detection and vent planning
│   │   └── slide.ts           checks for a glass-slide-capped chip
│   └── fluids/
│       ├── properties.ts      presets + the glycerol/water viscosity model
│       ├── hydraulics.ts      hydraulic diameter, Poiseuille numbers, Reynolds
│       ├── network.ts         nodal solve for flow distribution
│       ├── thermal.ts         wall heat transfer between streams
│       ├── reconcile.ts       fluid inputs as the estimate sees them
│       ├── simulate.ts        the run: geometry + fluids → per-segment results
│       ├── consumption.ts     what a run costs: reagent draw, priming, wash
│       ├── heatmap.ts         validated colour scales and legend stops
│       └── heatmapExport.ts   presentation-ready SVG
├── workers/
│   └── cadWorker.ts     runs the CSG pipeline off the main thread
├── store/
│   ├── projectStore.ts  the open project, its file, and undo/redo
│   ├── settingsStore.ts app-level settings that outlive any project
│   ├── editorStore.ts   tool, selection, snapping, viewport
│   ├── cadStore.ts      the built solid and the worker that produces it
│   ├── validationStore.ts  focused warning and check thresholds
│   ├── fluidStore.ts    selected metric and fluid being edited
│   └── uiStore.ts       overlays and pending confirmations
├── components/          shell, onboarding, tour, dialogs, UI primitives, draw/
└── views/               one per tab: Draw, CAD Preview, Fluid Dynamics, Library

examples/                saved .openchip projects, also parsed as test fixtures
brand/                   design tokens and the logo geometry, shared with the website
```

## How the drawing editor is put together

The `channelGraph` in the store is the single source of truth. Paper.js is a
renderer and view transform over it, not a parallel model — and hit testing runs
against the graph in chip-space millimetres rather than against Paper items, so
it stays correct regardless of how things are drawn and is testable without a
DOM.

**Width is solved per chain, not per edge.** A dimension marker's influence does
not stop at the segment it sits on: `loft.ts` groups edges into maximal runs
through degree-2 nodes, projects every marker onto one arc-length axis, and
interpolates across the whole run. That is what lets a taper cross a segment
carrying no markers of its own. The CSG sweep consumes the same solution,
which is why it lives apart from the canvas.

Outside the outermost markers, width holds constant rather than extrapolating —
running a taper off the end of the markers would invent geometry the user never
asked for, and could drive a channel to zero.

## How the CAD engine is put together

`lib/cad/` turns the graph into a solid with manifold-3d, in a fixed order:
sweep each edge, union chambers, union port cavities, subtract the
whole network from the block, then split. Everything before the subtraction
builds one **negative** solid — the void the fluid occupies. Port bosses and
male fittings (Luer cones, hose barbs) are additive, unioned on before the
subtraction so their bores drive straight through them; a Luer-lock thread goes
on after, because it stands in the collar groove the subtraction cuts.

**The sweep is the load-bearing primitive.** manifold has `extrude` and
`revolve` but no general sweep, so `sweep.ts` stitches profile rings into a
watertight tube. It detects its own frame handedness and flips winding when
needed — without that a helix comes out inside-out with negative volume, which
silently complements every later boolean.

**Z placement decides whether the chip can be printed.** Rect and trapezoid
channels hang below the split plane with their ceiling on it, leaving an open
groove and a flat lid. Round channels are centered *on* the plane instead: a
circle tangent to the cut would leave a re-entrant lip that cannot be printed as
an open groove or cleared of resin. Trapezoids are drafted wide-side-up toward
the open face.

Builds run in a Web Worker (`workers/cadWorker.ts`) — a serpentine rebuild is
50–130 ms, which would visibly stick the UI on every slider tick. Requests
coalesce by sequence number so a drag collapses into one build instead of a
backlog.

## How validation is put together

`lib/validation/` runs manufacturability, flow-feasibility and drainage checks
against the active printer profile, and returns one ranked list. The panel is
docked to the bottom of both the Draw and CAD tabs; clicking a warning selects
its elements and highlights them in whichever view is open, and the Show in
2D / Show in 3D buttons jump between them carrying the focus along.

**Nothing here can block anything.** `runValidation` returns exactly
`{ warnings, counts }` — there is no `isValid`, no `canExport`, no severity that
means "stop". That is enforced by a test that asserts those keys are absent,
because the cheapest way to keep a rule true is to never expose the shape that
would make breaking it easy.

**"Local low point" is interpreted, not taken literally.** The obvious place for
a drainage hole is a low point in the enclosed geometry, but every channel sits at
a single Z, so the literal reading selects everything or nothing. What actually
traps resin is *distance from an opening* — so vents go at local maxima of the
along-channel distance to the nearest port, plus every dead end and every island
with no port at all. `planDrainage` iterates that to convergence, because
venting the worst spot exposes the next-worst and a "one-click" helper that
needs three clicks is not one-click.

## How the fluid estimates are put together

`lib/fluids/` is a **one-dimensional network model**, and the tab says so
permanently: fully developed laminar flow, perfect mixing at junctions, no
entrance or bend effects. It sizes a chip and catches an unusable design; it does
not replace solving Navier–Stokes.

**A laminar channel network is a resistor network.** ΔP = R·Q is Ohm's law and
junctions conserve volume the way nodes conserve current, so flow distribution
comes from a nodal solve rather than an assumption that branches split evenly — a
branch twice as wide carries roughly sixteen times the flow. Inlets are flow
sources (a syringe pump delivers its rate regardless of back-pressure); outlets
are pressure references at ambient.

**Shape factors are not optional.** Hagen–Poiseuille is generalised as
ΔP = Po·μ·L·Q / (2·A·Dh²), where the Poiseuille number Po is a pure function of
cross-section — 64 for a circle, 56.91 for a square, up to 96 for a thin slot.
Using the circular value for a rectangular channel under-predicts the pressure
drop by up to 50%, which is the difference between a pump coping and stalling.

**Reynolds number is always shown**, for every segment, however unremarkable.
Microfluidics is nearly always deeply laminar, but a user may be *designing* for
turbulence, and hiding the number when it looks boring would hide the transition
they are hunting for. The regime colours are deliberately not a red/amber/green
severity set for the same reason.

**Wall shear gets reference bands, not severity colours** — the same reasoning
as the Reynolds regimes, and for the same reason. τ_w = (Dh/4)·(ΔP/L) falls out
of the force balance on a duct element, so it costs nothing beyond the pressure
field already solved. But high shear is a legitimate design target: it is how
you break an emulsion, keep a wall from fouling, or size a lysis step. Painting
50 Pa red would tell a user doing that on purpose that their chip is broken. So
the ramp carries the magnitude, and named boundaries — typical perfusion,
shear-sensitive cells at risk, lysis territory — appear on the legend as ticks
with the caveat attached: those are order-of-magnitude figures for mammalian
cells in suspension, and real tolerance varies with cell type, exposure time and
whether the cells are adherent. They give the number a sense of scale. They do
not certify anything.

**Segment volume is integrated along the loft, not taken from the mean
cross-section.** The geometry pass walks the loft samples accumulating length
anyway, so it carries an area accumulator alongside and applies the trapezoid
rule to ∫A(s)ds. The shortcut — area of the mean section, times the length —
agrees exactly on a uniform channel and is wrong wherever one tapers, because
area goes as the square of a width that is only linear in arc length. A round
channel running 0.4 → 1.6 mm over 30 mm holds 26.39 mm³; the mean-diameter
shortcut says 23.56, which is 12% light. Taper is a first-class feature of the
drawing editor, so that is not an edge case. The hydraulics are untouched by
this: resistance and Reynolds still run off the mean section, and volume gets
its own accumulator.

**Transit time is reported as a range, because a branched network has no single
answer.** Arrival times propagate downstream the same way fluid identity does,
carrying an earliest and a latest at each node; a wide branch delivers long
before a narrow one running in parallel with it, and collapsing that to one
number would be a quiet fiction. Segments on an island with no path from an
inlet are left out rather than counted as zero, and a stalled segment is not a
slow route — no fluid element ever traverses it, so its residence time is
infinite and it contributes no arrival at all. Residence time is the one metric
drawn on a logarithmic scale, since a chip with a wide flow split spans orders
of magnitude, and the legend says so: a log scale the reader cannot see is a lie.

**Glycerol fraction gets a real model** (Cheng 2008, *Industrial & Engineering Chemistry Research* 47, 3285–3288) rather than an interpolated
table: it is the standard knob for viscosity-matching, the relationship is
strongly non-linear — 50% by mass is ~6 mPa·s where a linear guess says 700 —
and being an order of magnitude out exactly where people work would be worse
than useless.

**Heat exchange is solved at steady state, not marched.** Each segment satisfies
C·(T_out − T_in) = UA·(T_neighbour − T_mean), solved for T_out and iterated. The
tempting alternative — compute a heat flow, add it to the temperature, repeat —
is a time march that injects another dose every pass and runs away. Each stretch
of channel is also attributed to exactly one neighbour, so a millimetre of wall
cannot exchange the same heat several times over.

### What is approximated

The 6% Luer taper is exact. **Luer-lock threads are not**: they are generated as
a single-start helical rib at the nominal major diameter and pitch, rather than
the two-start ISO 80369-7 form with its specified crest and root profile. It
screws and it prints, but test-fit before relying on it. The app says so next to
the fitting, and the exported `.scad` says so in the file. OpenSCAD has no thread
primitive either, so the `.scad` collar is a plain counterbore — the STL is the
one that carries a thread.

## How the template library is put together

`lib/presets/` ships seven geometries as **static data** — nothing is fetched,
because the app never needs a network connection.
Node ids are deterministic (`serpentine-n7`, not a UUID), which is what lets a
thumbnail render without touching the store, lets the geometry be asserted in a
test, and makes the build cache safe.

**A template is not a mode.** Starting from one calls the same `newProject` the
File menu does, with the graph and a seeded fluid setup passed in. The only
trace left behind is `presetLibraryRef`, which is a note about provenance and
nothing the app enforces later.

**The thumbnails are rendered from the geometry**, through the same `solveLoft`
the canvas and the CSG sweep use — so the droplet generator's 0.35 mm throat is
visible at card size, and editing a template cannot leave its picture behind.

**The herringbone is a deliberate reinterpretation.** The published staggered
herringbone mixer works by chevron ridges cut into the channel *floor*; those
are sub-channel features, and `channelGraph` puts every channel at a single Z.
Rather than ship something that looks like an SHM and mixes like something else,
it is the planar chevron interpretation and says so in the card.

`presets.test.ts` is the bar a shipped template has to clear: one connected
network, every port footprint inside `minEdgeSpacing`, fits the default build
volume, and **no risk-severity warning on open**. A starter chip that greets a
new user with a red warning teaches them to ignore the warnings panel, and the
entire safety model here is advisory.

## How the presentation export is put together

`lib/presentationExport.ts` bundles the schematic, the CAD view and the flow
heatmap into one `.zip`, at a chosen DPI, with a README recording the chip
parameters and printer profile it was exported against.

**It is one file, and it also contains a composed sheet.** "One export" is best
read literally — but a bare archive of three images is not what goes into a
slide, so the bundle carries the source assets *and* a single titled 16:9 figure
laying them out together.

**The SVGs are regenerated at the target resolution, not resampled**, so 300 DPI
is genuinely 300 DPI rather than an upscaled screen rendering.

`zip.ts` is hand-written and store-only rather than a dependency: the payload is
already-compressed PNGs, so deflate would buy nothing, and a zip library is real
weight in an app that has to work offline. Its test reads the record layout back
rather than agreeing with itself — which is how it caught the central-directory
size being measured after the end record had already advanced the write cursor.

## How persistence works

Two independent layers:

1. **The `.openchip` file is the artifact.** JSON, validated on open, with
   errors that name the section and field at fault. Saved through the File
   System Access API where available (Chrome/Edge overwrite the same file in
   place); elsewhere each save downloads a copy.
2. **A local draft is a safety net.** The open project is mirrored to
   `localStorage` on a 400 ms debounce and restored on reload, so an accidental
   refresh doesn't cost an afternoon's work. Opening a file always replaces the
   draft. If storage is unavailable the app still works — it just loses
   recovery.

Both sit behind interfaces (`ProjectStorage`, `StateStorage`) so a server-backed
adapter could be added later without touching the stores or the UI.

## Forward compatibility

Project files are parsed with loose object schemas, so a file written by a later
version opens in an earlier build with its unknown fields preserved through a save
round-trip. `formatVersion` gates migrations; the hook lives in
`migrate()` in `lib/projectFile.ts`.

## Deploying

Any static host works — the build output in `dist/` is plain files and the app
never calls a backend.

`vercel.json` carries the two settings a client-routed SPA needs:

- **A catch-all rewrite to `/index.html`.** React Router uses browser history,
  so `/library` is a route the client resolves, not a file on the server.
  Without the rewrite every deep link and every refresh outside `/` returns 404.
  Static files are matched before rewrites, so `/assets/*` still serves itself.
- **Split cache policy.** Hashed assets are immutable and cached for a year;
  `index.html` must revalidate. Caching the HTML is what leaves a returning
  visitor holding a document that points at a bundle the next deploy deleted —
  a blank page with a 404 in the console and nothing wrong with the code.
