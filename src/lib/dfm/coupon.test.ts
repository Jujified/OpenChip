/**
 * Calibration coupon tests: it is a valid project, it builds, every channel is
 * open at both ends, and its measurement sheet reads back.
 */

import assert from 'node:assert/strict';
import { beforeAll, describe, it } from 'vitest';
import Module from 'manifold-3d';
import { buildChip, type ManifoldApi } from '../cad/buildChip';
import { exportScad } from '../cad/scadExport';
import { exportStl, stlTriangleCount } from '../cad/stlExport';
import { FALLBACK_PRINTER_PROFILE, PRINTER_PRESETS } from '../defaults';
import { parseProject, serializeProject } from '../projectFile';
import { runValidation } from '../validation';
import { compensateDesign } from './compensate';
import {
  COUPON_VERSION,
  blankMeasurements,
  buildCouponProject,
  couponLayout,
  defaultCouponSpec,
  measurementSheetCsv,
  parseMeasurementSheet,
} from './coupon';
import { makeProfile } from './testFixtures';

let api: ManifoldApi;

beforeAll(async () => {
  const raw = await Module();
  raw.setup();
  api = { Manifold: raw.Manifold, Mesh: raw.Mesh } as unknown as ManifoldApi;
}, 60_000);

const spec = defaultCouponSpec(FALLBACK_PRINTER_PROFILE);

describe('the default coupon', () => {
  it('spans sizes below and above the printer minimum feature', () => {
    const feature = FALLBACK_PRINTER_PROFILE.minFeatureSizeMm;
    assert.ok(Math.min(...spec.widthsMm) < feature, 'something should be expected to close');
    assert.ok(Math.max(...spec.widthsMm) >= feature * 2.5, 'something should be expected to stay open');
    assert.ok(Math.min(...spec.heightsMm) < feature);
    assert.ok(Math.max(...spec.heightsMm) >= feature * 2);
    assert.equal(spec.version, COUPON_VERSION);
  });

  it('uses heights the printer can actually stack', () => {
    const layerMm = FALLBACK_PRINTER_PROFILE.layerHeightMicrons / 1000;
    for (const height of spec.heightsMm) {
      assert.ok(Math.abs(height / layerMm - Math.round(height / layerMm)) < 1e-6, `${height}`);
    }
  });

  it('fits every printer preset the app ships', () => {
    for (const preset of PRINTER_PRESETS) {
      const { chip } = couponLayout(defaultCouponSpec(preset.profile));
      const volume = preset.profile.buildVolumeMm;
      assert.ok(chip.width <= volume.x && chip.length <= volume.y, `${preset.id}: ${chip.length} mm`);
    }
  });

  it('has one channel per width × height, labelled group.index', () => {
    const layout = couponLayout(spec);
    assert.equal(layout.channels.length, spec.widthsMm.length * spec.heightsMm.length);
    assert.equal(new Set(layout.channels.map((c) => c.id)).size, layout.channels.length);

    const first = layout.channels[0];
    assert.equal(first.id, '1.1');
    assert.equal(first.widthMm, Math.max(...spec.widthsMm), 'channel 1 is the widest');
    assert.equal(first.heightMm, Math.min(...spec.heightsMm), 'group 1 is the lowest');
  });

  it('labels each group with that many tally dots', () => {
    const layout = couponLayout(spec);
    spec.heightsMm.forEach((_, g) => {
      assert.equal(layout.dots.filter((d) => d.group === g + 1).length, g + 1);
    });
  });

  it('keeps a full gap of solid material between neighbours', () => {
    const layout = couponLayout(spec);
    const spans = [
      ...layout.channels.map((c) => ({ lo: c.yMm - c.widthMm / 2, hi: c.yMm + c.widthMm / 2 })),
      ...layout.dots.map((d) => ({ lo: d.y - spec.dotDiameterMm / 2, hi: d.y + spec.dotDiameterMm / 2 })),
    ].sort((a, b) => a.lo - b.lo);
    for (let i = 1; i < spans.length; i += 1) {
      const gap = spans[i].lo - spans[i - 1].hi;
      // Dots of one group share a row, so they overlap in y; everything else
      // is a gap apart.
      assert.ok(gap >= spec.gapMm - 1e-6 || gap < 0, `gap ${gap}`);
    }
  });
});

describe('the coupon as a project', () => {
  const { project, layout } = buildCouponProject(spec, FALLBACK_PRINTER_PROFILE);

  it('is a valid .openchip file that round-trips', () => {
    const parsed = parseProject(serializeProject(project));
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.details.join(' '));
    if (!parsed.ok) return;
    assert.deepEqual(parsed.project, project);
    assert.deepEqual(parsed.warnings, []);
  });

  it('is monolithic, so its channels have printed ceilings', () => {
    assert.equal(project.chipParams.splitType, 'monolithic');
    assert.ok(project.chipParams.baseThickness > project.chipParams.splitHeight);
  });

  it('goes through the design checks without throwing, and they cannot block it', () => {
    const result = runValidation({
      graph: project.channelGraph,
      chipParams: project.chipParams,
      printerProfile: project.printerProfile,
      drainageVents: project.drainageVents,
    });
    assert.deepEqual(Object.keys(result).sort(), ['counts', 'warnings']);
  });

  it('builds one non-empty solid through the normal pipeline', () => {
    const built = buildChip(api, project.channelGraph, project.chipParams, {
      quality: 2,
      drainageVents: project.drainageVents,
    });
    assert.deepEqual(built.warnings, []);
    assert.deepEqual(built.pieces.map((p) => p.id), ['solid']);
    assert.equal(built.stats.ventCount, layout.dots.length);

    const stl = exportStl(built.pieces, 'coupon');
    assert.ok(stlTriangleCount(stl) > 100);
  });

  it('opens every channel at both ends', () => {
    const built = buildChip(api, project.channelGraph, project.chipParams, {
      quality: 2,
      drainageVents: project.drainageVents,
    });
    const { positions } = built.pieces[0];
    const { width, splitHeight } = layout.chip;

    // A channel cut clean through the side wall leaves its rectangular mouth
    // in that wall: four mesh vertices on the face, at the channel's corners.
    const hasVertex = (x: number, y: number, z: number) => {
      for (let i = 0; i < positions.length; i += 3) {
        if (
          Math.abs(positions[i] - x) < 1e-4 &&
          Math.abs(positions[i + 1] - y) < 1e-4 &&
          Math.abs(positions[i + 2] - z) < 1e-4
        ) {
          return true;
        }
      }
      return false;
    };

    for (const channel of layout.channels) {
      for (const x of [0, width]) {
        for (const y of [channel.yMm - channel.widthMm / 2, channel.yMm + channel.widthMm / 2]) {
          for (const z of [splitHeight, splitHeight - channel.heightMm]) {
            assert.ok(hasVertex(x, y, z), `channel ${channel.id} mouth corner at x=${x}`);
          }
        }
      }
    }

    // And the material removed is exactly a through-prism per channel, plus
    // the dots: nothing is left as a skin over a mouth.
    const block = width * layout.chip.length * layout.chip.baseThickness;
    const channels = layout.channels.reduce((sum, c) => sum + c.widthMm * c.heightMm * width, 0);
    const removed = block - built.stats.chipVolumeMm3;
    const dotCeiling =
      layout.dots.length * Math.PI * (spec.dotDiameterMm / 2) ** 2 * (spec.roofMm + 0.01);
    assert.ok(removed > channels + dotCeiling * 0.9, `removed ${removed}, channels ${channels}`);
    assert.ok(removed < channels + dotCeiling * 1.001, `removed ${removed}, channels ${channels}`);
  });

  it('gives the tally dots as blind holes that stop at the channel plane', () => {
    const built = buildChip(api, project.channelGraph, project.chipParams, {
      includeChannelSolid: true,
      drainageVents: project.drainageVents,
    });
    const z = Array.from(built.channelSolid?.positions ?? []).filter((_, i) => i % 3 === 2);
    // Nothing in the cavity goes below the deepest channel floor.
    assert.ok(Math.min(...z) >= spec.floorMm - 1e-4);
  });

  it('exports as OpenSCAD too', () => {
    const scad = exportScad(project.channelGraph, project.chipParams, {
      drainageVents: project.drainageVents,
    });
    assert.equal((scad.match(/{/g) ?? []).length, (scad.match(/}/g) ?? []).length);
  });

  it('can itself be compensated without its open ends counting as conflicts', () => {
    const out = compensateDesign(
      {
        graph: project.channelGraph,
        chipParams: project.chipParams,
        drainageVents: project.drainageVents,
        printerProfile: project.printerProfile,
      },
      makeProfile({ deltaXyMm: 0.03, deltaZMm: 0.05 }),
    );
    assert.deepEqual(out.conflicts.filter((c) => c.kind === 'edge-clearance'), []);
  });
});

describe('the measurement sheet', () => {
  const layout = couponLayout(spec);

  it('lists every channel with its nominal size and blank results', () => {
    const csv = measurementSheetCsv(blankMeasurements(layout));
    const lines = csv.trim().split('\n');
    assert.equal(lines.length, layout.channels.length + 1);
    assert.match(lines[0], /^channel,group_dots,position_in_group,nominal_width_mm/);
    const first = layout.channels[0];
    assert.equal(lines[1], `1.1,1,1,${first.widthMm},${first.heightMm},,,`);
  });

  it('reads a filled-in sheet back', () => {
    const filled = blankMeasurements(layout);
    filled[0] = { ...filled[0], result: 'open', measuredWidthMm: 0.52, measuredHeightMm: 0.07 };
    filled[1] = { ...filled[1], result: 'closed' };
    const parsed = parseMeasurementSheet(measurementSheetCsv(filled));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.measurements, filled);
  });

  it('accepts what a spreadsheet does to a CSV', () => {
    const csv =
      'Channel;group_dots;position_in_group;nominal_width_mm;nominal_height_mm;result_open_partial_closed;measured_width_mm;measured_height_mm\r\n' +
      '"1.1";1;1;0.6;0.1;Open;0,52;\r\n' +
      '1.2;1;2;0.4;0.1;P;;\r\n';
    const parsed = parseMeasurementSheet(csv);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.details.join(' '));
    if (!parsed.ok) return;
    assert.deepEqual(parsed.measurements, [
      { id: '1.1', nominalWidthMm: 0.6, nominalHeightMm: 0.1, result: 'open', measuredWidthMm: 0.52 },
      { id: '1.2', nominalWidthMm: 0.4, nominalHeightMm: 0.1, result: 'partial' },
    ]);
  });

  it('names the row it could not read, and imports nothing', () => {
    const csv = `${measurementSheetCsv(blankMeasurements(layout)).trim()}\n9.9,9,9,0.3,0.3,sort of,,\n`;
    const parsed = parseMeasurementSheet(csv);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.ok(parsed.details.some((d) => /Row \d+: result "sort of"/.test(d)));
  });

  it('rejects a file that is not a sheet', () => {
    const parsed = parseMeasurementSheet('a,b\n1,2\n');
    assert.equal(parsed.ok, false);
  });
});
