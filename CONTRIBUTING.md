# Contributing to OpenChip

Thanks for taking a look. Bug reports, measurements and pull requests are all
welcome.

## Reporting a problem

[Open an issue](https://github.com/Jujified/OpenChip/issues/new/choose). The most
useful bug report contains:

- **The `.openchip` file.** It is plain JSON and it carries the printer profile,
  so it reproduces exactly what you were looking at. Drag it into the issue.
- **What you expected and what happened.**
- **Your browser and version**, if it is a rendering or a save issue.

For a **wrong number** — a pressure estimate, a warning threshold, a fluid
property — include what you measured and how. A measured contradiction is the
most valuable thing anyone can send this project.

## The ground rules

Four rules shape everything here. A change that breaks one of them won't be
merged, however good it is otherwise.

1. **Nothing ever blocks the user.** Design checks are warnings that say what was
   measured and what tends to go wrong, then leave the decision alone. There is
   no "valid" flag, and no check is connected to the export buttons.
2. **No network at runtime.** No backend, no database, no accounts, no fetch.
   The app works offline once loaded, and nothing a user draws leaves their
   machine. Templates and fluid properties are compiled in.
3. **Every parameter is editable somewhere.** Advanced controls can sit behind a
   disclosure; they can't be left out. A scientist with an edge case must be able
   to reach the number.
4. **Honest about limits.** Where a figure is a rule of thumb, the app says so.
   Where a model leaves something out, the app says so on the same screen.

## Working on the code

```sh
npm install
npm run dev
```

Before opening a pull request:

```sh
npm run build && npm test && npm run lint
```

`npm run build` runs `tsc -b` first, so a type error fails the build. The same
checks run on every pull request.

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the editor, the CAD engine, the
design checks and the flow model fit together. Read the section for the part you
are changing first.

### Things that will bite you

- **All measurements are millimetres**, internally and in the UI. The 3D
  coordinate system is +Z up, matching Three.js and manifold-3d.
- **`erasableSyntaxOnly` is on.** No TypeScript parameter properties
  (`constructor(private x: T)`), no enums.
- **Test files use relative imports.** An absolute path breaks on a clean clone.
- **Template node ids are deterministic**, not UUIDs. That is what lets a
  thumbnail render without touching the store and keeps the template cache safe.
- **No template may open with a `risk`-severity warning.** `presets.test.ts`
  enforces it: a starter chip that greets a new user with red teaches them to
  ignore the panel.

### Changing the file format

Additive changes only. New fields must be optional with a default, so a file
written by a newer build opens in an older one, and unknown fields must survive a
save round-trip. Every file in `examples/` is parsed by the test suite, so a
breaking change fails there first.

### Changing a design check or a threshold

Say in the pull request what the new number is based on: a measurement, a paper,
or a manufacturer's figure. New warning kinds also need an entry in
`src/lib/wikiLinks.ts`; the type system will remind you.

## Documentation and website

The [documentation site](https://wiki.openchip.tech) and
[openchip.tech](https://openchip.tech) are maintained separately from this
repository. If a page is wrong or missing, open an issue and say which page.

## Licence

By contributing, you agree that your contributions are released under the
[MIT License](LICENSE), the same as the rest of the project.

Please follow the [code of conduct](CODE_OF_CONDUCT.md).
