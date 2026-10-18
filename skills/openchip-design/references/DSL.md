# Chip-DSL reference

A line-oriented text format that compiles to a complete `.openchip` project.

```bash
# <skill dir> is wherever this skill is installed.
node <skill dir>/scripts/openchip.mjs build mixer.chip -o mixer.openchip
```

The compiler in `scripts/openchip.mjs` is the only implementation of this
grammar. If the two ever disagree, the compiler is right and this file is a bug.

## Shape of a file

- One statement per line. Blank lines are ignored.
- `#` starts a comment, to end of line.
- Keywords are case-insensitive; node ids are not.
- Leading whitespace is ignored, so indentation is free for readability.
- Declaration order does not matter for `port` / `node` / `chamber` — every
  declaration is collected before paths resolve. A path may still define new
  waypoints inline.

## Header statements

| Statement | Meaning | Default |
| --- | --- | --- |
| `chip "Name"` | Project name (`meta.name`) | `Untitled chip` |
| `printer <key>` | `standard-4k`, `high-res-8k`, `large-format` | `standard-4k` |
| `printer custom name=X xy=35 layer=50 minfeature=0.2 volume=143x89x175` | A hand-entered profile | — |
| `size <W> x <L>` | Chip footprint, mm | `40 x 60` |
| `base <mm>` | Total block height | `4` |
| `wall <mm>` | Minimum material between two channels | `2` |
| `edge-spacing <mm>` | Minimum clearance to the chip boundary | `3` |
| `split two-piece at <z>` | Cut plane height, mm | `two-piece at 2` |
| `split monolithic` | One sealed block — needs vents | — |
| `split glass-slide` | Open-faced, roofed by a glass slide | — |
| `slide 75x25 thick 1 clearance 0.2 gap 0 offset (0,0)` | Slide pocket geometry | standard slide |
| `channel <w> [x <h>] [round\|rect\|trapezoid]` | Default channel size and section | `0.8 x 0.5 rect` |
| `material-k <W/m·K>` | Chip material thermal conductivity | `0.2` |
| `from <preset-id>` | Records `presetLibraryRef` provenance | `null` |
| `note <text>` | Free comment; not written to the file | — |

Every header statement is optional. A file with only ports and paths compiles
against the defaults above.

## Nodes

```
port  <id> at <x>,<y> [<fitting>] [bore <mm>] [inlet <fluid> <µL/min> [at <T>C] | outlet]
node  <id> at <x>,<y>
chamber <id> at <x>,<y> [sphere|cylinder] <sizeMm>
vent  <nodeId> [<diameterMm>]
```

Coordinates are millimetres from the chip's bottom-left corner, `+x` right and
`+y` up.

**Fittings** — the word chooses a real catalogue part, its `portType`, bore and
full `customSpec`:

| Word | Port type | What plugs in |
| --- | --- | --- |
| `luer-slip` *(default)* | `luer` | Female 6% taper socket. A Norm-Ject luer-slip tip, or any male-luer adapter. |
| `luer-lock` | `luer-lock` | Same taper plus lugs, so a collar screws down. Use whenever the line is pressurised. |
| `male-luer-barb` | `luer-lock` | Lock socket on a lower boss, for a male-luer × 1/8" barb adapter. |
| `female-luer-barb` | `luer-male` | The chip grows the male cone; a female-luer adapter pushes on. Fragile — stands proud. |
| `barb` | `barb` | Printed ridges. Tubing pushes straight on, no adapter. Most fragile feature on the chip. |
| `tubing-socket` | `custom` | 4.7 mm socket that takes 0.188" OD PVC directly. |
| `syringe` | `syringe` | Plain barrel socket, no taper. |

**Fluid words** map to the built-in profiles: `water`, `pbs` (or `buffer`),
`ethanol`, `oil` (or `mineral-oil`), `glycerol` (`glycerol-50`), `blood`
(`blood-analog`). A `fluid` statement adds your own, and its id becomes a word
you can use on a port:

```
fluid pdms-oil name "Silicone oil 20cSt" density 950 viscosity 0.019 k 0.15 cp 1500 temp 20
port oilIn at 7,32 luer-slip inlet pdms-oil 15
```

`inlet` defaults to 10 µL/min of water when the fluid or rate is omitted.
`outlet` carries no flow. Ports with neither word are left unassigned — the app
will ask.

## Paths

```
path <ref> -> <ref> [-> <ref> ...] [modifiers]
```

A `ref` is one of:

| Form | Meaning |
| --- | --- |
| `junction` | An already-declared node |
| `(20,47)` | **Creates a new** anonymous waypoint at those coordinates |
| `mid(20,47)` | Creates a waypoint *and* names it, so later lines can refer to it |

> **Coordinates never join anything.** `(20,47)` always creates a *fresh* node.
> Writing it on two different lines gives you two separate nodes sitting on top
> of each other with no channel between them — which compiles without complaint
> and shows up much later as a baffling dead end. Any point that more than one
> path has to reach needs a **name**: declare it with `node`, or name it inline
> the first time with `mid(20,47)` and write `mid` from then on.
>
> The checker's *Authoring notes* section flags coincident nodes and nodes no
> path mentions, so a mistake of this shape is named at the cause rather than
> guessed at from its symptoms.

A line beginning with `->` continues the previous path from its last point, so a
long serpentine stays readable:

```
path lead -> (7,43)
  -> (7,37)  -> (33,37)
  -> (33,31) -> (7,31)
```

### Modifiers

Modifiers come after the chain and apply to every segment that line lays down.

| Modifier | Effect |
| --- | --- |
| `width 0.6` | Constant width; height stays the project default |
| `width 0.6x0.4` | Constant width × height |
| `section round` | Cross-section for these segments (`round`, `rect`, `trapezoid`) |
| `via (cx,cy) (cx,cy)` | Two cubic control points — makes the segment a bezier. Single-segment paths only. |
| `taper 0.6x0.4@0 0.35x0.3@0.45 0.9x0.5@1` | Dimension markers at `t` along the segment. Single-segment paths only. |

`width` is shorthand for a `taper` with the same size at `t=0` and `t=1`.

### How an unmarked segment gets its size

**Dimension markers loft across a whole chain**, not just their own segment: a
run of edges joined end-to-end through degree-2 nodes shares one arc-length
axis, and width interpolates smoothly between whichever markers sit on it. A
junction of three or more edges ends a chain.

So a segment with no size modifier does **not** simply fall back to `channel`.
It falls back to `channel` only when *nothing on its whole chain* carries a
marker. Put a marker anywhere on the chain and every unmarked segment on that
chain is interpolated between the markers on either side of it:

```
node m1 at 8,22
node m2 at 8,38
path a  -> m1 taper 1.0x0.6@0 1.0x0.6@1
path m1 -> m2                              # ← no modifier at all
path m2 -> b  taper 0.4x0.3@0 0.4x0.3@1
```

The middle segment is not 0.8 mm. It runs 1.0 → 0.4 mm, interpolated across its
own length, because it sits between those two markers on one chain.

That is the feature, and it is what makes a long steady taper cheap to write:
**mark the two ends of the run and leave everything between them bare.** You do
not need a `taper` on every segment, and adding one to each is how you
accidentally turn a smooth taper into a staircase of constant-width steps.

Outside the outermost markers the size holds constant rather than
extrapolating — a taper never runs off the end of its markers and drives a
channel to zero. The droplet example puts `0.9x0.5` at the end of one segment
and again at the start of the next precisely because the two agree, so the neck
reflows continuously across the join instead of stepping.

## Worked fragment

```
chip "T-junction mixer"
size 36 x 40
channel 0.8 x 0.5 rect

port inletA at 6,33  luer-slip inlet water 10
port inletB at 30,33 luer-slip inlet pbs 10
port outlet at 18,6  luer-slip outlet

node tee at 18,33
path inletA -> tee
path inletB -> tee
path tee -> (18,26) -> (18,19) -> (18,12) -> outlet
```

## What the compiler does not do

- It never invents geometry. No auto-routing, no auto-fillets, no auto-ports.
- It never silently moves anything to satisfy a check. Warnings are reported;
  the coordinates stay exactly as written.
- It has no notion of a failed build. A design with risks still compiles and
  still writes its file.
