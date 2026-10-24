# OpenChip

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23461556.svg)](https://doi.org/10.5281/zenodo.23461556)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

OpenChip is a browser-based tool for designing microfluidic chips and exporting
them as STL files for desktop resin (mSLA) printers, made for researchers who
need a chip and do not use CAD.

![Starting from the serpentine mixer template: the two-inlet channel network opens in the Draw tab, the Fluid Dynamics tab shows pressure and residence-time heatmaps, and the CAD Preview shows the chip in X-ray, exploded into channel plate and lid, before exporting the STL.](docs/demo.gif)

**[Try it now at app.openchip.tech](https://app.openchip.tech)**. It runs in the
browser with no account and no install, and nothing you draw is uploaded.

## What you can do

- **Start from a template or draw your own.** Seven editable starters
  (serpentine, T-junction, Y-junction, herringbone and spiral mixers, a gradient
  generator and a flow-focusing droplet generator), or draw straight and curved
  channels and set widths that taper along a path. Ports come from a catalogue
  of Luer slip and Luer-lock sockets, male Luer cones, hose barbs and syringe
  sockets, or your own dimensions.
- **Check it against your printer.** Warnings for channels below the printer's
  minimum feature size, walls too thin between channels, features too close to
  the edge, trapped resin, unsupported overhangs and designs larger than the
  build volume. Every check is a warning; none blocks an export.
- **Preview and export the solid.** A 3D model built in the browser with
  [manifold-3d](https://github.com/elalish/manifold), printed as two pieces (a
  channel plate and a lid), one sealed block, or an open plate capped with a
  glass slide. Export STL for printing, editable OpenSCAD source, SVG
  schematics, PNG snapshots and a presentation bundle.
- **Estimate the flow.** A one-dimensional network model gives pressure drop,
  Reynolds number, wall shear, residence time, heat exchange between
  neighbouring channels, and reagent use, with heatmaps.
- **Save and share `.openchip` files**, plain JSON you can version alongside a
  paper, or describe a chip in plain English to an AI assistant with the
  [`openchip-design` skill](skills/openchip-design/SKILL.md) and open the file
  it returns (`npx skills add Jujified/OpenChip`). OpenChip itself sends
  nothing anywhere.

## Documentation

The full documentation is at **[wiki.openchip.tech](https://wiki.openchip.tech)**.
Good places to start:

- [Your first chip](https://wiki.openchip.tech/start/your-first-chip/)
- [Templates](https://wiki.openchip.tech/guide/templates/)
- [Design checks](https://wiki.openchip.tech/reference/design-checks/)
- [Export formats](https://wiki.openchip.tech/reference/export-formats/)
- [3D printing microfluidic chips](https://wiki.openchip.tech/printing/3d-printing-microfluidic-chips/)

## First steps

Open the **Library** tab and pick a template, or open
[`examples/counter-flow-exchanger.openchip`](examples/counter-flow-exchanger.openchip)
with **Project → Open Project**. Press `?` anywhere for keyboard shortcuts, or
take the guided tour from **Settings → Take the tour**.

Your working design is kept in browser storage as a safety net. To keep a design
or move it between machines, save it as a `.openchip` file.

## Run it locally

Requires Node 20.19 or newer.

```bash
git clone https://github.com/Jujified/OpenChip.git
cd OpenChip
npm install
npm run dev
```

| Script | Does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Typecheck, then build static files into `dist/` |
| `npm test` | Run the test suite |
| `npm run lint` | Lint with oxlint |
| `npm run typecheck` | Typecheck without emitting |

The build is plain static files, so any static host works. See
[ARCHITECTURE.md](ARCHITECTURE.md) for how the editor, CAD engine, design checks
and flow model are put together.

## What it does not do

OpenChip is a design tool, not a guarantee. The design checks are geometric
rules of thumb against a printer profile you enter, and resin, exposure and
post-curing all move the result. **Print a small test coupon before committing
to a full chip.** The flow estimates assume fully developed laminar flow and
perfect mixing at junctions; they size a chip and catch an unusable design, but
they are not a CFD simulation. Printed Luer fittings follow nominal ISO
80369-7 dimensions and are not certified connectors; do not use them in
anything clinical.

## Citing OpenChip

If OpenChip designed a device that appears in your work, please cite the
software and the version you used. The DOI is
[10.5281/zenodo.23461556](https://doi.org/10.5281/zenodo.23461556), and GitHub's
**Cite this repository** button gives the details from
[`CITATION.cff`](CITATION.cff).

```bibtex
@software{openchip,
  title   = {OpenChip: browser-based microfluidic chip design for resin printing},
  author  = {Cimoca, Julian},
  year    = {2026},
  version = {1.0.0},
  doi     = {10.5281/zenodo.23461556},
  url     = {https://openchip.tech}
}
```

## Related software

- **[Flui3d](https://github.com/TUM-EDA/Flui3d)** (Zhang et al.,
  *Communications Engineering*, 2024) is the closest relative: a web-based
  design platform for 3D-printed microfluidic chips. It builds devices from a
  parameterised component library, supports multi-layer designs, and corrects
  geometry for light penetration during printing. OpenChip instead draws
  freeform channel networks and focuses on printability checks, flow estimates
  and standard fittings, entirely client-side.
- **[3DμF](https://github.com/CIDARLAB/3DuF)** is an interactive design
  environment for continuous-flow microfluidic devices.

## Contributing

Bug reports, ideas and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md). The documentation site and the website are
maintained separately from this repository.

## About

Created by Julian Cimoca
([ORCID 0009-0009-8978-5337](https://orcid.org/0009-0009-8978-5337)).
Developed with AI coding assistance (Claude); design, direction and validation
by the author.

## Acknowledgements

The author collaborated with, and received advice from, mentor Walker MacSwain
([ORCID 0000-0002-2671-2546](https://orcid.org/0000-0002-2671-2546)), who also
helped validate the software.

## License

Released under the [MIT License](LICENSE).
