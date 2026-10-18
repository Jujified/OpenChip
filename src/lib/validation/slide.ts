/**
 * Checks that only apply to a chip capped with a glass slide.
 *
 * A slide chip is the one configuration where the *lid* is not printed, and
 * that changes what can go wrong. The pocket has to fit on the chip, the glass
 * has to actually cover the channels it is meant to close, and anything the
 * glass lands on top of — a port, a boss — stops being reachable.
 *
 * All advisory, like every other check here. A chip with a port under the glass
 * is a chip you can still export; it is just one you probably meant to draw
 * differently.
 */

import { nodeFootprintMm } from '../graphOps';
import { getLoft } from '../loft';
import { insidePocket, overlapsPocket, slidePocket } from '../cad/slide';
import type { Point2 } from '../../types/project';
import type { ValidationInput, Warning } from './types';

const mm = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Does the pocket fit on the chip, with the user's own edge spacing left round
 * it?
 *
 * The standard 75 × 25 mm slide does not fit the 40 × 60 mm default chip, so
 * this fires the moment someone switches modes without changing anything. That
 * is the intended first experience: the numbers say what to do about it, and
 * the panel offers to resize the chip in one click.
 */
export function checkSlideFits(input: ValidationInput): Warning[] {
  const { chipParams } = input;
  const pocket = slidePocket(chipParams);
  if (!pocket) return [];

  const warnings: Warning[] = [];
  const margin = chipParams.minEdgeSpacing;

  const overhangX = Math.max(
    margin - pocket.pocket.x,
    pocket.pocket.x + pocket.pocket.width - (chipParams.width - margin),
  );
  const overhangY = Math.max(
    margin - pocket.pocket.y,
    pocket.pocket.y + pocket.pocket.length - (chipParams.length - margin),
  );
  const worst = Math.max(overhangX, overhangY);

  if (worst > 1e-6) {
    const offChip =
      pocket.pocket.x < 0 ||
      pocket.pocket.y < 0 ||
      pocket.pocket.x + pocket.pocket.width > chipParams.width ||
      pocket.pocket.y + pocket.pocket.length > chipParams.length;

    warnings.push({
      id: 'slide:fit',
      kind: 'slide-does-not-fit',
      severity: offChip ? 'risk' : 'caution',
      title: offChip
        ? `The slide pocket runs ${mm(worst)} mm off the chip`
        : `The slide pocket leaves only a ${mm(margin - worst)} mm rim`,
      detail: offChip
        ? `A ${chipParams.slide.widthMm} × ${chipParams.slide.lengthMm} mm slide needs a chip of at least ` +
          `${mm(chipParams.slide.widthMm + chipParams.slide.clearanceMm * 2 + margin * 2)} × ` +
          `${mm(chipParams.slide.lengthMm + chipParams.slide.clearanceMm * 2 + margin * 2)} mm. ` +
          'Enlarge the chip, swap the slide’s width and length to turn it, or fit a smaller slide.'
        : `Your minimum edge spacing is ${margin} mm, and the pocket wall is thinner than that. A thin rim around a pocket cracks easily when the part is released.`,
      measurement: { value: worst, limit: 0, unit: 'mm' },
      target: { nodeIds: [], edgeIds: [] },
    });
  }

  // Depth: a pocket deeper than the block leaves nothing to hold the channels.
  if (pocket.floorZ <= 0) {
    warnings.push({
      id: 'slide:depth',
      kind: 'slide-does-not-fit',
      severity: 'risk',
      title: `The pocket is deeper than the ${chipParams.baseThickness} mm chip`,
      detail:
        `A ${chipParams.slide.thicknessMm} mm slide with a ${chipParams.slide.bondGapMm} mm bond gap cuts ` +
        `${mm(pocket.depthMm)} mm off the top, which is the whole block. Make the chip thicker so there is ` +
        'floor left under the channels.',
      measurement: { value: pocket.depthMm, limit: chipParams.baseThickness, unit: 'mm' },
      target: { nodeIds: [], edgeIds: [] },
    });
  }

  return warnings;
}

/**
 * Ports the glass will sit on top of.
 *
 * Sockets are bored from the top face, so a port inside the pocket comes out in
 * the pocket floor and the slide seals it shut. The fix is to move the port
 * onto the rim outside the pocket — which the check names, rather than the app
 * quietly moving the geometry.
 */
export function checkPortsUnderSlide(input: ValidationInput): Warning[] {
  const { graph, chipParams } = input;
  const pocket = slidePocket(chipParams);
  if (!pocket) return [];

  const warnings: Warning[] = [];

  for (const node of graph.nodes) {
    if (node.type !== 'port' && node.type !== 'chamber') continue;

    const radius = nodeFootprintMm(node, chipParams) / 2;
    if (!overlapsPocket(pocket.pocket, node.x, node.y, radius)) continue;
    // A chamber under the glass is fine — it is part of the fluid path. Only a
    // port, which has to be reachable from outside, is a problem.
    if (node.type !== 'port') continue;

    warnings.push({
      id: `slide-port:${node.id}`,
      kind: 'port-under-slide',
      severity: 'risk',
      title: `The glass covers this ${node.portType} port`,
      detail:
        'The socket is bored down from the top face, into the pocket floor, so the slide bonds straight over it ' +
        'and nothing can be connected. Move the port outside the pocket, onto the rim, or make the slide smaller.',
      target: { nodeIds: [node.id], edgeIds: [], focus: { x: node.x, y: node.y } },
    });
  }

  return warnings;
}

/**
 * Channel that runs out from under the glass.
 *
 * The pocket is what opens the channels; outside it the block is still full
 * height, so the same channel prints as a closed tunnel with a roof on. That is
 * not a mistake in itself — it is how a channel reaches a port on the rim — but
 * it is a resin trap, and the user should know which parts of the network are
 * one.
 */
export function checkChannelsUnderSlide(input: ValidationInput): Warning[] {
  const { graph, chipParams } = input;
  const pocket = slidePocket(chipParams);
  if (!pocket) return [];

  const loft = getLoft(graph, chipParams);
  const warnings: Warning[] = [];

  for (const edge of graph.edges) {
    const solved = loft.edges.get(edge.id);
    if (!solved) continue;

    let outside = 0;
    let where: Point2 | null = null;
    for (const sample of solved.samples) {
      if (insidePocket(pocket.pocket, sample.point.x, sample.point.y, sample.widthMm / 2)) continue;
      outside += 1;
      if (!where) where = { x: sample.point.x, y: sample.point.y };
    }

    if (outside === 0 || !where) continue;

    const whole = outside === solved.samples.length;
    warnings.push({
      id: `slide-channel:${edge.id}`,
      kind: 'channel-outside-slide',
      severity: whole ? 'risk' : 'caution',
      title: whole
        ? 'This segment runs entirely outside the slide pocket'
        : 'This segment runs out from under the slide',
      detail: whole
        ? 'Nothing opens it, so it prints as a closed tunnel that has to drain through its ends. Move it under ' +
          'the pocket, or enlarge the slide, unless it is a deliberate run out to a port on the rim.'
        : 'The part beyond the pocket keeps its roof, so it prints as a closed tunnel rather than an open groove. ' +
          'That is how a channel reaches a port on the rim — just make sure the resin in it can drain.',
      measurement: {
        value: Math.round((outside / solved.samples.length) * 100),
        limit: 0,
        unit: '%',
      },
      target: { nodeIds: [], edgeIds: [edge.id], focus: where },
    });
  }

  return warnings;
}

/**
 * Round channels, which cannot survive contact with a flat lid.
 *
 * A round channel is centred on the plane, so half of it is above the pocket
 * floor and gets cut away: what prints is a half-round groove, and the glass
 * closes it flat. The shape is right — a full circle would be a roofed tunnel —
 * but it holds half the fluid the Fluid Dynamics tab thinks it does, and that
 * is worth saying out loud rather than leaving in a doc nobody opens.
 */
export function checkRoundChannelsUnderSlide(input: ValidationInput): Warning[] {
  const { graph, chipParams } = input;
  const pocket = slidePocket(chipParams);
  if (!pocket) return [];

  const round = graph.edges.filter((edge) => edge.crossSection === 'round');
  if (round.length === 0) return [];

  return [
    {
      id: 'slide:round',
      kind: 'round-channel-under-slide',
      severity: 'caution',
      title:
        round.length === 1
          ? 'A round channel prints as a half-round groove here'
          : `${round.length} round channels print as half-round grooves here`,
      detail:
        'A round section is centred on the open face, so the pocket cuts the top half off and the flat glass ' +
        'closes what is left. The printed channel is a semicircle with about half the area, and the flow ' +
        'estimates assume the full circle. Switch these segments to rect for numbers that match the part.',
      measurement: { value: round.length, limit: 0, unit: 'segments' },
      target: { nodeIds: [], edgeIds: round.map((edge) => edge.id) },
    },
  ];
}
