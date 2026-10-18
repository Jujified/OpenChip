# Design rules, layout recipes and the physics behind them

Everything here is either a rule the checker enforces (with its exact
threshold), or a number you need to pick coordinates that pass it.

---

## 1. The checks, and how to satisfy them

`node <skill dir>/scripts/openchip.mjs check` runs a port of the app's own
design checks. Same thresholds, same
arithmetic. These are the ones that shape your layout:

| Check | Threshold | How to satisfy it |
| --- | --- | --- |
| `channel-below-min-feature` | narrowest sampled width (or height, for `rect`/`trapezoid`) < `printerProfile.minFeatureSizeMm` | Keep every channel — including the narrow point of a taper — above 0.2 mm on a standard 4K, 0.12 mm on an 8K, 0.25 mm on a large-format machine. |
| `channels-too-close` / `channels-overlap` | wall between two edges that share no node < `max(wallThickness, 0.4)` | With the default 2 mm wall and 0.8 mm channels, **centreline pitch ≥ 2.8 mm**. A 6 mm serpentine row pitch leaves 5.2 mm of wall — comfortable. |
| `channel-near-boundary` | node footprint or channel edge closer to the chip outline than `minEdgeSpacing` | See the port footprint table below. A luer port needs its centre ≥ 5.14 mm from any edge at the default 3 mm spacing. |
| `footprint-exceeds-build-volume` | chip larger than the plate in either orientation | 40 × 60 fits every profile. Above 143 × 89 you need an 8K or large-format machine. |
| `dead-end-channel` | a non-port node with exactly one edge | Every branch has to end at a port. |
| `disconnected-network` / one-port section | a component with fewer than two ports | Every independent network needs an inlet *and* an outlet. |
| `abrupt-taper` | width ratio between consecutive chain markers ≥ 2× (`caution` at ≥ 4×) | Spread a big size change over more distance, or accept it — a flow-focusing throat is meant to be abrupt. |
| `port-protrusion` | wall on a male fitting < 0.4 mm (`caution` under 0.8 mm) | `barb` and `female-luer-barb` with a 1.6 mm bore are fine; widening the bore eats the wall fast. |
| `enclosed-cavity` | `monolithic`, or `splitHeight` outside `0 < z < baseThickness` | Add vents, or use `two-piece`. |
| `port-under-slide`, `channel-outside-slide`, `round-channel-under-slide` | glass-slide chips only | Ports outside the pocket, channels inside it, and never `round` under flat glass. |

**Nothing here blocks.** OpenChip's first rule is that the user keeps final
control, so this skill reports warnings and writes the file anyway. Fix what is
an accident; explain what is deliberate. The counter-flow example ships with
eight cautions because the whole device is a 0.4 mm wall.

### Port footprints — what "near the edge" measures

Clearance is measured on the boss, not the bore. A 1.6 mm luer bore sits inside
a 4.27 mm cone.

| Fitting | Footprint | Minimum centre-to-edge at 3 mm spacing |
| --- | --- | --- |
| `luer-slip`, `female-luer-barb` | 4.27 mm | 5.14 mm |
| `luer-lock`, `male-luer-barb` | 7.7 mm | 6.85 mm |
| `barb` | 3.5 mm | 4.75 mm |
| `tubing-socket` | 4.7 mm | 5.35 mm |
| `syringe` | 1.6 mm | 3.8 mm |

A chamber's footprint is its `sizeMm`; a waypoint's is the default channel
width. In practice: **keep luer ports ≥ 6 mm from any edge and you never think
about it again**, and keep luer-lock ports ≥ 7 mm.

---

## 2. Picking the numbers

**Channel width.** 0.8 × 0.5 mm rectangular is the default for a reason: it is
4× the standard 4K printer's 0.2 mm feature size, so it survives washing and
curing with margin. Go narrower only with a reason and a finer printer.

- Standard 4K (35 µm pixels): 0.6–1.0 mm. Below 0.4 mm expect trouble.
- High-res 8K (20 µm): 0.3–0.8 mm. 0.25 mm is achievable with test prints.
- Large-format (46 µm): 0.8 mm and up.

Aspect ratio matters for the loft, not just the pressure drop: a channel much
wider than it is deep is a good optical window and a poor mixer; a square one is
the opposite. Height is limited by layer height — 0.5 mm is ten 50 µm layers.

**Chip footprint.** Size to the network plus 2 × `minEdgeSpacing`, then round up
to something the plate likes. 40 × 60 mm is the house default and fits every
printer profile. Do not make a chip larger than the design needs: resin cost and
print time both scale with it.

**Base thickness.** 4 mm for a two-piece chip (2 mm of channel-bearing base
under a 2 mm lid). 6 mm if a port boss needs the depth — a luer socket is 7.5 mm
of taper plus its boss, so it lives *above* the top face, not inside the block.

**Flow rate.** 10 µL/min per inlet is the default and a realistic syringe-pump
setting. Spiral and inertial devices want more (40+); droplet generators run the
dispersed phase slower than the continuous one, typically 1:3.

---

## 3. Which split type

| Split | When | Cost |
| --- | --- | --- |
| `two-piece` *(default)* | Almost always. Channels print as open grooves and a lid bonds on. | Two parts to align and bond; a bond line that can leak. |
| `glass-slide` | You need optical access, or a flat, chemically inert roof. | The chip has to be big enough for the slide (75 × 25 mm standard), ports must sit outside the pocket, and `round` channels cannot be roofed by flat glass. See `examples/slide-mixer.chip`. |
| `monolithic` | One sealed part, no bonding, no leak path. | Every channel is a trapped cavity. Uncured resin will set solid inside unless vents give it a path out. |

For `monolithic`, run the checker first and let it name the nodes: it flags each
local maximum of along-channel distance to an opening that exceeds 15 mm, which
is where resin has furthest to travel to escape and where a vent does the most
good. Put a 0.8 mm `vent` on each one and re-run — the warnings resolve. Dead
ends and unreachable sections always need one regardless of distance.

---

## 4. Layout recipes

Coordinates below assume the origin at bottom-left and the default 0.8 mm
channel. Every one of these is checked clean unless noted.

### Serpentine (diffusive mixer)

Two inlets → junction → a folded run → outlet. Length is the only lever.

```
rows at y = 43, 37, 31, 25, 19, 13   (6 mm pitch → 5.2 mm of wall)
x alternates between 7 and 33        (26 mm per pass)
```
Six passes in a 40 × 60 chip gives ~215 mm of channel. To double mixing, double
the number of passes, not the width — mixing length scales with the *square* of
channel width.

### T-junction

Opposed inlets meeting head-on, then a straight mixing leg. Compact and
unambiguous; the corner stretches the interface slightly, so it mixes a little
faster than a Y. Inlets at `(6,33)` and `(30,33)`, tee at `(18,33)`, leg down to
an outlet at `(18,6)` in a 36 × 40 chip.

### Y-junction

Curved arms so both streams arrive at the junction *parallel* and lie down side
by side. The gentlest merge available, and the slowest to mix. Use `via` handles
placed on the approach so the tangent at the junction is along the mixing leg:

```
path inletA -> junction via (9,33) (18,32)
path inletB -> junction via (27,33) (18,32)
```

Choose a Y over a T for cells, emulsions, or anything a head-on collision would
damage. Note that the Fluid tab reads the same wall shear for both — the
gentleness is in how the streams meet, which a 1-D model cannot see.

### Spiral (Dean-flow mixer)

An Archimedean spiral, outer radius to inner, with a port at the centre.
Sustained curvature drives counter-rotating secondary flows that stir the fluid
transversely; unlike diffusion, this gets *better* at higher flow rate. No
corners at all, so nothing to catch a bubble on.

Sample every 45° and connect with bezier handles scaled by the local speed:
`k = (4/3)·tan(Δθ/4)`, handles at `p ± k·(dP/dθ)` where
`dP/dθ = (r'·cos θ − r·sin θ, r'·sin θ + r·cos θ)`. Keep ≥ 2.8 mm between turns.
A 22 mm → 7 mm spiral over 2.5 turns gives 6 mm turn spacing and 257 mm of
channel in a 60 × 60 chip.

`examples/spiral-mixer.chip` is the whole thing worked out, generator formula
included. Two things it settles that the geometry alone does not:

- **Ports are not part of the spiral.** Place them outside its radius envelope
  (`centre ± outerR`), then check that envelope against the chip edge — a
  22 mm spiral centred on a 60 × 60 chip leaves 8 mm of rim, which is enough
  for a luer boss and its 5.14 mm clearance but not much more.
- **"No corners" is a claim about the mixing path, not the chip.** A spiral
  still needs a merge and an outlet stub. Keep both curved: put the merge
  *outside* the outer turn on its tangent line so the combined stream enters
  travelling along the spiral rather than turning into it, and reach the centre
  outlet with one last cubic that leaves the final sample along its own
  tangent. That is the same tangent hand-off used between every other pair of
  samples — a parametric curve joins anything smoothly if you keep using its
  own `dP/dθ` for the first handle.

### Planar herringbone (chaotic advection)

Chevron legs in staggered groups, each group biased to one side and the bias
reversing between groups. Folding the interface shrinks the diffusion distance
geometrically rather than linearly.

The coordinate scheme, so you can re-cut it to any chip — leg `k` (1…3) of a
group, working downward from that group's top `y`:

```
sign = -1 for odd k, +1 for even k
x    = cx + bias + sign · amplitude
y    = groupTopY - risePerLeg · k
```

with `cx` the chip centreline, `amplitude` 3.5 mm, `risePerLeg` 5 mm, and
`bias` cycling `−1.5, +1.5, −1.5` group to group. Three groups of three legs is
15 mm of rise each and gives `x ∈ {10, 13, 17, 20}` on a 30 mm-wide chip.
`examples/herringbone-mixer.chip` is that laid out in full.

Widen the swing by raising `amplitude`; fold harder by adding *groups*, not
legs — the reversal between groups is what does the work.

**Say so plainly:** the published staggered herringbone mixer works by ridges in
the channel *floor*, which a planar graph at a single Z cannot express. This is
the planar interpretation. Useful mixing, not the original device's numbers.

### Gradient generator (Christmas tree)

Two inlets → 3 streams → 4 streams, with a mixing serpentine between levels.
Each interior stream is fed by both parents and carries their average, so
concentration steps linearly across the outlets.

**Every branch must have identical hydraulic resistance.** Resistance scales
steeply with cross-section: scale a channel down in both dimensions and it goes
as `1/w⁴`; widen a 0.8 × 0.5 mm channel to 1.6 × 0.5 mm and it still carries
~2.6× the flow for the same pressure. Either way the linear series collapses.
Keep every channel in the tree the same width, the same section and the same
length — that symmetry *is* the device.

### Flow-focusing droplet generator

Dispersed phase from the top, continuous phase from both sides, all three
through a narrow throat. Build the throat from dimension markers on one segment,
not as a separate short channel — the loft interpolates a smooth neck:

```
path cross -> throat taper 0.6x0.4@0 0.35x0.3@0.45 0.9x0.5@1
```

Droplet size follows the orifice width and the flow-rate ratio, so both are the
first things to tune. A 0.35 mm throat is near the limit of a standard 4K
printer — say so, and suggest a test coupon.

### Counter-flow heat exchanger

Two independent networks running in opposite directions with a thin wall
between them. The wall *is* the device: at 1.2 mm centreline pitch and 0.8 mm
channels there is 0.4 mm of resin between the streams. Expect — and accept —
`channels-too-close` and `disconnected-network` cautions.

Resin conducts at about 0.2 W/m·K, two orders below metal, so a printed
exchanger works but is not efficient. Length and thinness are the only levers.

### When nothing matches: composing primitives

Most real requests are not one of the recipes above. Someone describing a
natural system — a gland, a gut, a capillary bed, an industrial process — is
describing a *sequence of operations on a fluid*, and the chip is that sequence
laid end to end. Work it in four steps.

**1. Write the sequence down as verbs, in order.** Not "a silk gland" but:
*store at high concentration → merge with a second stream → hold them together
for a long time while narrowing → deliver.* Strip the biology out until only
what happens to the fluid is left. If you cannot write the verbs, you do not yet
understand the request well enough to lay out a chip.

**2. Map each verb to a primitive.**

| What has to happen | Primitive |
| --- | --- |
| Bring two streams together gently | Y-junction with `via` arms |
| Bring two streams together compactly | T-junction |
| Give them time / length | Serpentine, or spiral if you want compactness and no corners |
| Fold the interface actively | Herringbone chevrons |
| Narrow the stream, raise shear | A taper built from dimension markers |
| Store, stall, or homogenise a volume | `chamber` node |
| Produce a graded concentration series | Gradient tree |
| Break a stream into droplets | Flow focusing |
| Move heat between two streams | Adjacent counter-flow channels |
| Hold one stream alongside another at set composition | Y-merge, then a long parallel run |

**3. Chain them through shared nodes.** The output node of one primitive is the
input node of the next — that is the whole of composition. Three things to watch
where they meet:

- **Flow adds at a merge.** Downstream of a Y carrying 5 and 20 µL/min, the
  channel runs at 25. Every Re, pressure drop and residence time downstream uses
  the sum.
- **A junction ends a loft chain.** Dimension markers interpolate along a chain
  of degree-2 nodes and stop at any node where three or more edges meet. A taper
  that must span a merge needs a marker on each side of it — the two will not
  talk to each other across the junction.
- **Resistance accumulates.** A long taper is a long run at the *narrow* end's
  resistance, not the average. Check the pressure the user's pump has to supply.

**4. Say what the chip cannot be.** This matters more than the layout, and it is
the part a plausible-looking design hides. A planar channel graph at a single Z
cannot express:

- **Anything sub-channel.** Floor ridges, wall texture, surface chemistry,
  coatings.
- **Any change in Z.** No crossings without a junction, no stacked layers, no
  vertical taper independent of the horizontal one.
- **Membranes, filters or selective barriers.** Two channels can share a thin
  wall and exchange heat; they cannot exchange solute through it.
- **True sheath or annular flow.** A Y-merge puts two streams side by side in
  one channel. It does not wrap one in the other, however the natural system
  does it.
- **Valves, pumps or any active control.** Everything is set by the geometry and
  whatever the syringe pumps do.
- **Chemistry and phase change.** The chip sets up contact, time and shear. It
  does not make a reaction go, and OpenChip's estimates model none of it — a
  chip that "spins a fibre" really provides the conditions under which the
  fluid may do that, downstream of the geometry and often outside the chip.

Name these against the specific request, not as a generic disclaimer. The app's
own template library does this in its `caveat` fields, and it is the house
style.

`examples/silk-spinning-duct.chip` is a worked composition: chamber → Y-merge →
one long tapering folded run, with the mapping and the limits written into the
file.

### Mixing chamber

A `chamber` node is an enlarged volume that stalls and folds the stream. Place
one at a junction or a turn, 3–6 mm across for a 0.8 mm channel. Larger than
~6× the channel width and it becomes a dead volume that traps bubbles and blurs
a concentration step rather than mixing anything.

---

## 5. Physics you should be able to state

**Everything is laminar.** Water at 10 µL/min in a 0.8 × 0.5 mm channel runs at
about 0.42 mm/s, with a hydraulic diameter of 0.62 mm and Re ≈ 0.26.
Turbulence needs Re > 2300 — around four orders of magnitude more flow than any
syringe pump on the bench will give you. There is no stirring; two streams run
side by side as clean laminae until diffusion or geometry does something.

**So mixing is diffusion, unless you fold.** Diffusion time goes as `w²/D`, so
halving the channel width quarters the mixing length. A small molecule
(D ≈ 10⁻⁹ m²/s) needs on the order of ten minutes to cross 0.8 mm — which at
0.42 mm/s is a few hundred mm of channel. That is why a serpentine is long, and
why chaotic advection (herringbone, spiral) buys so much.

**Pressure drop** is Hagen–Poiseuille generalised to non-circular ducts:
`ΔP = Po·μ·L·Q / (2·A·Dh²)`, where `Po = f·Re` depends only on the section shape
(64 for round, 56.9 for square, rising to 96 for a wide flat duct). Consequences
worth stating to a user:

- Scale a channel down in both dimensions and resistance goes as `1/w⁴`.
- Viscosity is linear: the 50% glycerol blend is 8.4× water's viscosity, so it
  costs 8.4× the pressure at the same flow.
- Doubling the length doubles the pressure. Doubling the flow doubles it too.

**Dean flow**, when you are claiming a curved channel mixes. The Dean number is
`De = Re·√(Dh/2R)`, with `R` the radius of curvature. It is the number that
justifies a spiral, and it is why a spiral wants to be run hard: `De` scales
linearly with `Re`, so quadrupling the flow quadruples it.

Work it through for the spiral recipe — 0.8 × 0.5 mm channel (`Dh` = 0.62 mm),
`R` ≈ 15 mm mid-spiral, water:

| Flow *in the spiral* | Re | De |
| --- | --- | --- |
| 20 µL/min (2 × 10 per inlet) | 0.51 | 0.07 |
| 80 µL/min (2 × 40 per inlet) | 2.1 | 0.30 |
| 800 µL/min (2 × 400 per inlet) | 21 | 3.0 |

Note whose flow that is: downstream of a merge the channel carries the **sum**
of its inlets, so a two-inlet spiral seeded at 40 µL/min each is running at 80.
Getting this wrong halves every Re and De you quote.

Secondary flow only becomes a real contributor somewhere above `De` ≈ 1, so be
honest with the user: at 40 µL/min a spiral is still mostly a long diffusive
channel that happens to be compact and free of corners. Its advantage over a
serpentine grows with flow rate, and at bench flow rates it is modest. Tightening
`R` helps as `1/√R`, which is far weaker than simply pushing more flow.

**Residence time** is `volume / flow`. A 200 mm run of 0.8 × 0.5 mm channel
holds 80 µL; at 20 µL/min that is 4 minutes of contact.

**Heat exchange** is limited by the wall, not the fluid. Laminar Nusselt number
is a constant ~3.66, so `h = 3.66·k/Dh` — about 3600 W/m²·K for water in a
0.8 × 0.5 mm channel. The 0.2 W/m·K resin wall is what actually sets the rate,
which is why a printed exchanger wants the thinnest wall you dare print.

---

## 6. Failure modes when generating a chip

Things that go wrong, in rough order of frequency:

1. **Ports too close to the edge.** You placed the centre 3 mm in, forgetting
   the boss is 4.27 mm wide. Use the table in §1.
2. **Parallel runs too close.** Any two channels that do not share a node need
   `max(wallThickness, 0.4)` of material between them — 2.8 mm centreline pitch
   at the defaults, not 1 mm.
3. **A branch that stops.** Every dangling waypoint is a dead end. Every
   independent network needs two ports.
4. **A taper that runs off a chain.** Markers hold constant outside the
   outermost one and interpolate across a whole chain, so a marker you put on
   one segment may be resizing five others.
5. **A monolithic chip with no vents.** Add them, or use `two-piece`.
6. **A glass slide that does not fit.** A standard 75 × 25 mm slide makes a
   75.4 × 25.4 mm pocket, the pocket needs `minEdgeSpacing` of rim round it, and
   every port has to sit *outside* the pocket while staying ≥ 5.14 mm from the
   chip edge. That takes about **96 × 32 mm** before a luer port has comfortable
   room on the rim — at 90 mm wide the window for a port centre is a third of a
   millimetre. Size the chip to the slide, never the other way round. Channels
   crossing the pocket wall on their way to a rim port are normal and draw a
   caution each; only a segment *entirely* outside the pocket is a real problem.
7. **Inventing fitting dimensions.** Copy `FITTINGS` from the skill's
   `scripts/openchip.mjs`. A taper wrong by a tenth of a millimetre is a leak
   the user chases for an afternoon.
8. **Two nodes on the same spot.** In the DSL, `(20,47)` written twice makes two
   separate nodes at one place, not one shared point — coordinates never join
   anything. The checker's *Authoring notes* section catches this; the design
   checks alone would only show it as a confusing dead end three inferences
   downstream.
