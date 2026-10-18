---
name: openchip-design
description: Design a microfluidic chip from a plain-English description and export it as a ready-to-open .openchip project file. Use whenever someone describes a chip they want — "a serpentine mixer for two dyes", "a droplet generator", "a gradient generator for a dose-response", "something that works like a spider's silk gland", "a chip with four inlets that mixes and splits" — or asks to build, generate, lay out, sketch or export an OpenChip design, a channel network, a mixer, a heat exchanger, or a .openchip file. Also use when editing or extending an existing .openchip project. Not for changing the OpenChip app's own source code.
---

# Designing an OpenChip chip

Turn a description of what a chip should *do* into a channel network that will
actually print, and hand back a `.openchip` file the user can open in OpenChip
and take straight to the 3D preview.

The user is a scientist, not a CAD professional. They will describe a function
("mix two dyes gently", "make 50 µm droplets", "four concentrations from two
syringes"), not a geometry. Turning that into coordinates is the job.

**OpenChip never hard-blocks anything, and neither does this skill.** Design
checks produce warnings that explain a risk; they never refuse to write a file.
Where a warning is the point of the device — a heat exchanger *is* a thin wall —
say so and keep the geometry.

---

## Step 1 — ask which mode, before anything else

This is not optional and it comes first, before any design work. Ask the user,
with your environment's question tool if it has one:

> **How should I write this chip?**
>
> - **DSL (recommended)** — I write a short, readable `.chip` file and compile
>   it. Easiest to review and to tweak afterwards; you get both files.
> - **Raw graph** — I write the `.openchip` JSON directly: every node, edge and
>   dimension marker by hand. Choose this if you want to hand-edit the JSON, or
>   are extending a `.openchip` file you already have.

Both modes produce the same `.openchip` file and go through the same checks.
Only the authoring surface differs. If the user has already said which they want
("just give me the JSON", "use the DSL"), take them at their word and skip the
question. If you cannot ask — running as a subagent, a scheduled job, or any
other context with no one to answer — default to DSL, and say in your report
that you chose it without asking.

While you have their attention, ask anything genuinely load-bearing in the same
question — printer (standard 4K / 8K / large-format), and whether they want
`two-piece`, `glass-slide` or `monolithic` — but only if the request leaves it
open. A request sent from OpenChip's **Design with AI** dialog already carries
the user's printer profile; use it rather than asking. Do not interrogate them: sensible defaults exist for everything, and
"a serpentine mixer" is a complete brief.

---

## Step 2 — read what you need

Paths below are relative to this skill's own directory — wherever your agent
installed it. Commands write it as `<skill dir>`.

| Read | When |
| --- | --- |
| `references/DESIGN-RULES.md` | **Always.** Thresholds, port footprints, layout recipes, the physics. |
| `references/DSL.md` | DSL mode. |
| `references/SCHEMA.md` | Raw mode, or when extending an existing file. |
| `examples/*.chip` | Always worth a look — the closest example to the request is usually 80% of the answer. |

The examples are all checked clean (or deliberately not — `counter-flow-exchanger.chip`
ships with eight cautions and explains why):

| Example | Shows |
| --- | --- |
| `serpentine-mixer.chip` | The house pattern: two inlets, a folded run, continuation lines |
| `y-junction-mixer.chip` | Bezier arms via `via`, co-flow merging |
| `herringbone-mixer.chip` | Staggered chevron groups, with the coordinate scheme spelled out |
| `spiral-mixer.chip` | A parametric curve: sampling, tangent handles, and the stubs at each end |
| `droplet-generator.chip` | A lofted throat built from dimension markers |
| `gradient-generator.chip` | A branching tree where every branch must match |
| `counter-flow-exchanger.chip` | Two independent networks, temperatures, accepted warnings |
| `slide-mixer.chip` | A glass-slide chip: sized to the slide, ports on the rim |
| `silk-spinning-duct.chip` | Composing primitives for a system with no recipe, and naming the limits |
| `chamber-mixer.chip` + `.openchip` | A chamber, a monolithic chip, a drainage vent — and the same chip in both modes, side by side |

---

## Step 3 — design it

Work out the *function* first, then the geometry:

1. **What has to happen to the fluid?** Contact two streams? Fold them? Split
   them into a series? Pinch off droplets? Exchange heat? That decides the
   topology, and §4 of `DESIGN-RULES.md` has a recipe for each.
2. **How many ports, and what plugs into them?** Every independent network needs
   an inlet and an outlet. Default to `luer-slip` unless the line is pressurised
   (then `luer-lock`) or the user names tubing (then `barb` or `tubing-socket`).
3. **What size are the channels?** 0.8 × 0.5 mm `rect` unless there is a reason.
   Check the reason against the printer's minimum feature size.
4. **How big is the chip?** The network plus 2 × `minEdgeSpacing`, rounded up.
   40 × 60 mm fits every printer profile.
5. **Lay out the coordinates.** Keep ≥ 2.8 mm centreline pitch between channels
   that do not share a node, and keep luer ports ≥ 6 mm from any edge.
6. **Assign every port** a role, a fluid and a flow rate. Unassigned ports make
   the app guess, and a confident estimate of the wrong device is worse than no
   estimate.

Reach for a named geometry when the user's words point at one — a Y for gentle
co-flow, a T for a compact contactor, a spiral for something that mixes better
the harder you push it, a Christmas tree for a concentration series, flow
focusing for droplets.

**Most real requests match no recipe.** A natural system — a gland, a gut, an
industrial process — is a *sequence of operations on a fluid*, and the chip is
that sequence laid end to end. "When nothing matches: composing primitives" in
`DESIGN-RULES.md` §4 is the method: write the sequence down as verbs, map each
verb to a primitive, chain them through shared nodes, and then say what the chip
cannot be. That last step is the one that matters most and the one a
plausible-looking layout hides — a planar graph at a single Z has no membranes,
no valves, no sheath flow, no sub-channel texture, and no chemistry.
`examples/silk-spinning-duct.chip` is a full composition worked through.

---

## Step 4 — compile and check

DSL mode:

```bash
node <skill dir>/scripts/openchip.mjs build chip.chip -o chip.openchip
```

Raw mode — write the JSON, then:

```bash
node <skill dir>/scripts/openchip.mjs check chip.openchip
```

The script is a single file with no dependencies and needs only Node. **If you
cannot run Node at all**, use raw mode, write the JSON carefully against
`references/SCHEMA.md`, and tell the user the file is unchecked — OpenChip runs
the same design checks the moment it is opened.

The checker is a faithful port of the app's own design checks: same
thresholds, same loft-chain arithmetic, same warning kinds. It reports:

- **Structural errors** — duplicate ids, dangling edges, a bad `t`. These stop
  the file opening at all. **Always fix these.**
- **`risk` warnings** — the design will probably not work as drawn: a channel
  below the printer's resolution, a port outside the chip, a section with no
  port. Fix them unless the user has said otherwise.
- **`caution` / `info`** — judgement calls. Fix accidents; keep and explain
  anything deliberate.
- **Authoring notes** — not OpenChip checks, but the mistakes that produce a
  *structurally valid* wrong graph: two nodes sitting on the same coordinates
  (writing `(20,47)` twice never joins anything), and nodes no path mentions.
  These name a cause the design checks can only show you as a symptom, so read
  them first.

Iterate until the report says what you intend it to say. A clean report on a
chip that does the wrong thing is not success — re-read the geometry against
what the user asked for.

---

## Step 5 — hand it over

Give the user:

1. **The file(s).** The `.openchip` always; the `.chip` source too in DSL mode,
   since that is what they will edit next.
2. **What it does, in three or four sentences** — the topology, the principle it
   works on, and the numbers that matter (channel size, total channel length,
   flow rate, footprint).
3. **The check report, in plain words.** Every warning you left in, and why.
4. **What to tune first.** Usually one or two parameters: passes on a
   serpentine, throat width and flow ratio on a droplet generator, wall
   thickness on an exchanger.
5. **How to open it** — drop it into step 3 of OpenChip's **Design with AI**
   dialog, or use Project → Open Project.

Be honest about what a planar channel graph at a single Z cannot express. The
staggered herringbone's floor ridges, true 3-D crossings, valves, membranes and
anything sub-channel are all out of reach. Say so rather than shipping something
that looks right and behaves differently — the app's own template library does
exactly this in its `caveat` fields, and it is the house style.

---

## Rules

- **Ask DSL or raw first.** Every time, unless the user already said.
- **Never block an export.** Report, explain, write the file.
- **Never invent fitting dimensions.** Copy the `FITTINGS` table from
  `scripts/openchip.mjs`. A taper wrong by a tenth of a millimetre is a leak the
  user chases for an afternoon.
- **Never quietly move geometry to silence a warning.** Fix it deliberately and
  say what you changed, or leave it and say why.
- **Millimetres, always**, origin at the chip's bottom-left, `+y` up.
- **Every parameter stays editable.** Do not bake a decision into a shape the
  user cannot get back out of — that is the same promise the app makes.
