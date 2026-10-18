/**
 * The first-run guided tour.
 *
 * Five things a new user cannot discover by looking: what the dimension tool
 * actually does, that ports are cut for real catalogue fittings, that the split
 * plane is draggable, that the warnings never block anything, and that there is
 * a template library. Everything else in the app explains itself by being
 * visible.
 *
 * **The tour opens a template first.** On a genuine first run the project is
 * empty, so the CAD tab shows its empty state and neither the split control nor
 * the warnings panel exists to point at — a tour that gestures at absent
 * controls is worse than none. The first card says plainly that it will load
 * the serpentine mixer, and it only offers to when there is nothing to lose.
 */

export interface TourStep {
  id: string;
  /** `data-tour` attribute of the element to spotlight. Null centers the card. */
  target: string | null;
  /** Route the step needs, navigated to before the target is looked for. */
  route?: string;
  title: string;
  body: string;
  /** Preferred side of the target. Flipped when there is no room. */
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    target: null,
    route: '/draw',
    title: 'A two-minute tour',
    body:
      'Five things worth knowing before you draw your first chip. You can leave at any point with ' +
      'Escape, and pick it up again from Settings.',
  },
  {
    id: 'draw-tool',
    target: 'draw-tools',
    route: '/draw',
    placement: 'bottom',
    title: 'Draw the channel network',
    body:
      'Press P and click to lay down channel segments; press V to go back to selecting and ' +
      'dragging. Endpoint snapping is what joins two paths into one — turn it off and they will ' +
      'sit on top of each other without connecting.',
  },
  {
    id: 'dimension',
    target: 'dimension-tool',
    route: '/draw',
    placement: 'bottom',
    title: 'Dimension markers set the width — and the taper',
    body:
      'Press D and click a channel to pin its width at that point. A marker’s influence does not ' +
      'stop at its own segment: widths interpolate between consecutive markers along the whole ' +
      'connected path, so two markers make a smooth taper across every segment between them. ' +
      'That is the loft, and the 3D model is built from it.',
  },
  {
    id: 'ports',
    target: 'inspector',
    route: '/draw',
    placement: 'left',
    title: 'Ports are cut for real fittings',
    body:
      'Select the node at the end of a path and make it a Port. The catalogue row offers ' +
      'Norm-Ject Luer slip and Luer lock sockets and a direct push-fit for 1/8" PVC tubing — each ' +
      'says which part it accepts. Every dimension underneath stays editable if your fitting ' +
      'differs.',
  },
  {
    id: 'split',
    target: 'split-height',
    route: '/cad',
    placement: 'left',
    title: 'The split plane is a slider',
    body:
      'A two-piece chip is cut into a channel plate and a flat lid, which is what lets you wash ' +
      'the uncured resin out. Drag the split height and the model rebuilds live; Explode in the ' +
      'toolbar separates the halves so you can inspect the bonding faces.',
  },
  {
    id: 'warnings',
    target: 'warnings',
    route: '/cad',
    placement: 'top',
    title: 'Design checks advise, never block',
    body:
      'Channels below your printer’s resolution, walls too thin, anything hanging outside the ' +
      'build volume, resin with no way out. Click a warning to jump to the part of the chip it ' +
      'is about. Nothing here will ever stop an export — the call is always yours.',
  },
  {
    id: 'library',
    target: 'library-tab',
    route: '/cad',
    placement: 'bottom',
    title: 'Start from a known geometry',
    body:
      'Seven mixer and gradient templates, each editable exactly as if you had drawn it. When the ' +
      'chip is ready, Present bundles the drawing, the 3D view and the flow estimate into one ' +
      'download. Press ? at any time for the keyboard shortcuts.',
  },
];
