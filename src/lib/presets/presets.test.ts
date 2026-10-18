import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { DEFAULT_CHIP_PARAMS, FALLBACK_PRINTER_PROFILE, createProject } from '../defaults';
import { runValidation } from '../validation';
import { totalChannelLengthMm } from '../graphOps';
import { portFootprintMm } from '../ports';
import { CHIP_PRESETS, presetBuild, projectOptionsFromPreset } from './index';
import type { ChipParams } from '../../types/project';

const paramsFor = (overrides: Partial<ChipParams>): ChipParams => ({
  ...DEFAULT_CHIP_PARAMS,
  ...overrides,
});

describe('starter templates', () => {
  it('ships the six classic geometries, plus a droplet generator', () => {
    const ids = CHIP_PRESETS.map((p) => p.id);
    for (const required of [
      'serpentine-mixer',
      't-junction-mixer',
      'y-junction-mixer',
      'herringbone-mixer',
      'spiral-mixer',
      'gradient-generator',
    ]) {
      assert.ok(ids.includes(required), `missing template: ${required}`);
    }
    assert.equal(new Set(ids).size, ids.length, 'template ids must be unique');
  });

  for (const preset of CHIP_PRESETS) {
    describe(preset.name, () => {
      const build = presetBuild(preset);
      const chipParams = paramsFor(preset.chipParams);

      it('builds a structurally sound graph', () => {
        const ids = new Set(build.graph.nodes.map((n) => n.id));
        assert.equal(ids.size, build.graph.nodes.length, 'node ids must be unique');

        const edgeIds = new Set(build.graph.edges.map((e) => e.id));
        assert.equal(edgeIds.size, build.graph.edges.length, 'edge ids must be unique');

        for (const edge of build.graph.edges) {
          assert.ok(ids.has(edge.fromNodeId), `dangling from-node on ${edge.id}`);
          assert.ok(ids.has(edge.toNodeId), `dangling to-node on ${edge.id}`);
          assert.notEqual(edge.fromNodeId, edge.toNodeId, `self-loop on ${edge.id}`);
        }

        assert.ok(totalChannelLengthMm(build.graph) > 10, 'template should carry real channel');
      });

      it('is one connected network with no islands', () => {
        const adjacency = new Map<string, string[]>();
        for (const node of build.graph.nodes) adjacency.set(node.id, []);
        for (const edge of build.graph.edges) {
          adjacency.get(edge.fromNodeId)?.push(edge.toNodeId);
          adjacency.get(edge.toNodeId)?.push(edge.fromNodeId);
        }

        const seen = new Set<string>([build.graph.nodes[0].id]);
        const queue = [build.graph.nodes[0].id];
        while (queue.length > 0) {
          for (const next of adjacency.get(queue.pop() as string) ?? []) {
            if (seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
          }
        }

        assert.equal(seen.size, build.graph.nodes.length, 'template has a disconnected island');
      });

      it('declares inlets and outlets that are really ports', () => {
        const ports = new Map(
          build.graph.nodes.filter((n) => n.type === 'port').map((n) => [n.id, n]),
        );
        const declared = [...build.inletPortIds, ...build.outletPortIds];

        for (const id of declared) assert.ok(ports.has(id), `${id} is declared but is not a port`);
        assert.equal(declared.length, ports.size, 'every port must be an inlet or an outlet');
        assert.ok(build.inletPortIds.length >= 1, 'a template needs at least one inlet');
        assert.ok(build.outletPortIds.length >= 1, 'a template needs at least one outlet');
      });

      it('keeps every port footprint inside the chip boundary', () => {
        for (const node of build.graph.nodes) {
          if (node.type !== 'port') continue;
          const radius = portFootprintMm(node.portType, node.customSpec) / 2;
          const clearance = Math.min(
            node.x - radius,
            node.y - radius,
            chipParams.width - node.x - radius,
            chipParams.length - node.y - radius,
          );
          assert.ok(
            clearance >= chipParams.minEdgeSpacing - 1e-6,
            `${preset.id}: port at (${node.x}, ${node.y}) is ${clearance.toFixed(2)} mm from the ` +
              `edge, under the ${chipParams.minEdgeSpacing} mm minimum`,
          );
        }
      });

      /**
       * The bar a shipped template has to clear.
       *
       * A starter chip that opens with a red warning on it teaches the user to
       * ignore the warnings panel, which is the one thing that must not happen
       * in an app whose safety model is entirely advisory. Cautions are fine and
       * sometimes deliberate — the droplet generator's throat is genuinely tight.
       */
      it('raises no risk-level warnings on the default printer', () => {
        const { warnings } = runValidation({
          graph: build.graph,
          chipParams,
          printerProfile: FALLBACK_PRINTER_PROFILE,
        });

        const risks = warnings.filter((w) => w.severity === 'risk');
        assert.deepEqual(
          risks.map((w) => `${w.kind}: ${w.title}`),
          [],
          `${preset.id} opens with risk-level warnings`,
        );
      });

      it('fits the default build volume', () => {
        const volume = FALLBACK_PRINTER_PROFILE.buildVolumeMm;
        assert.ok(chipParams.width <= volume.x, 'wider than the default build plate');
        assert.ok(chipParams.length <= volume.y, 'longer than the default build plate');
        assert.ok(chipParams.baseThickness <= volume.z, 'taller than the default build height');
      });

      it('opens as an ordinary project with a runnable fluid setup', () => {
        const project = createProject(projectOptionsFromPreset(preset, build));

        assert.equal(project.presetLibraryRef, preset.id);
        assert.equal(project.channelGraph.edges.length, build.graph.edges.length);
        assert.ok(project.fluidProfiles.length > 0, 'fluid library should be seeded');

        const inlets = project.fluidSetup.assignments.filter((a) => a.role === 'inlet');
        assert.equal(inlets.length, build.inletPortIds.length);
        for (const inlet of inlets) {
          assert.ok(inlet.flowRateUlPerMin > 0, 'a seeded inlet needs a flow rate');
          assert.ok(inlet.fluidProfileId, 'a seeded inlet needs a fluid');
        }
      });

      it('is deterministic — two builds are identical', () => {
        assert.deepEqual(preset.build().graph, preset.build().graph);
      });
    });
  }
});

describe('template references', () => {
  it('credits the paper behind each template that descends from one', () => {
    for (const id of ['herringbone-mixer', 'spiral-mixer', 'gradient-generator', 'droplet-generator']) {
      const preset = CHIP_PRESETS.find((p) => p.id === id);
      assert.ok(preset?.references?.length, `${id} names no source`);
    }
  });

  it('writes every reference as a full citation with a well-formed DOI', () => {
    for (const preset of CHIP_PRESETS) {
      for (const reference of preset.references ?? []) {
        // Authors, a year in brackets, and journal pages: enough to find it.
        assert.match(reference.citation, /\(\d{4}\)\..+\d+–\d+\.$/, preset.id);
        if (reference.doi) assert.match(reference.doi, /^10\.\d{4,}\/\S+$/, preset.id);
      }
    }
  });
});
