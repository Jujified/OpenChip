import { cn } from '../../lib/cn';
import { REGIME_TONE } from '../../lib/fluids/heatmap';
import { REGIME_LABEL } from '../../lib/fluids/hydraulics';
import type { SimulationResult } from '../../lib/fluids/simulate';
import { useFluidStore } from '../../store/fluidStore';

const num = (value: number, places = 2): string => {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 100_000) return value.toExponential(1);
  if (abs >= 1000) return Math.round(value).toLocaleString();
  return value.toFixed(places);
};

/**
 * The per-segment numbers.
 *
 * Also the table view the heatmap's colour encoding leans on — the pale end of
 * a sequential ramp sits below 3:1 against the surface by design, and the
 * accessible answer to that is that every value is also readable as text.
 */
export function ResultsTable({ result }: { result: SimulationResult }) {
  const focusedEdgeId = useFluidStore((s) => s.focusedEdgeId);
  const setFocusedEdgeId = useFluidStore((s) => s.setFocusedEdgeId);

  if (result.segments.length === 0) return null;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-panel">
          <tr className="border-b border-line text-left text-ink-muted">
            <Th>Segment</Th>
            <Th>Fluid</Th>
            <Th align="right">Length</Th>
            <Th align="right">W × H</Th>
            <Th align="right">Volume</Th>
            <Th align="right">τ</Th>
            <Th align="right">Flow</Th>
            <Th align="right">Velocity</Th>
            <Th align="right">ΔP</Th>
            <Th align="right">τ_w</Th>
            <Th align="right">Re</Th>
            <Th>Regime</Th>
            <Th align="right">T in → out</Th>
            <Th align="right">Heat</Th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {result.segments.map((segment, index) => (
            <tr
              key={segment.edgeId}
              onMouseEnter={() => setFocusedEdgeId(segment.edgeId)}
              onMouseLeave={() => setFocusedEdgeId(null)}
              className={cn(
                'border-b border-line/60 transition-colors',
                focusedEdgeId === segment.edgeId ? 'bg-accent-wash' : 'hover:bg-sunken',
              )}
            >
              <Td className="text-ink-muted">{index + 1}</Td>
              <Td className="max-w-[9rem] truncate font-sans text-ink">{segment.fluidName}</Td>
              <Td align="right">{num(segment.lengthMm, 2)} mm</Td>
              <Td align="right">
                {num(segment.meanWidthMm, 3)} × {num(segment.meanHeightMm, 3)}
              </Td>
              <Td align="right">{num(segment.volumeUl, 3)} µL</Td>
              <Td
                align="right"
                className={Number.isFinite(segment.residenceTimeS) ? undefined : 'text-ink-quiet'}
              >
                {/* A stalled segment holds its fluid for ever. An em dash says
                    that; a very large number would read as a measurement. */}
                {Number.isFinite(segment.residenceTimeS)
                  ? `${num(segment.residenceTimeS, 2)} s`
                  : '—'}
              </Td>
              <Td align="right">{num(Math.abs(segment.flowUlPerMin), 3)} µL/min</Td>
              <Td align="right">{num(Math.abs(segment.velocityMmPerS), 2)} mm/s</Td>
              <Td align="right">{num(segment.pressureDropPa, 1)} Pa</Td>
              <Td align="right">{num(segment.wallShearPa, 3)} Pa</Td>
              <Td align="right">{num(segment.reynolds, segment.reynolds < 10 ? 3 : 1)}</Td>
              <Td>
                {/* Always shown, even when it is the unremarkable answer — a
                    user designing for turbulence needs to watch it move. */}
                <span className={cn('font-sans', REGIME_TONE[segment.regime])}>
                  {REGIME_LABEL[segment.regime]}
                </span>
              </Td>
              <Td align="right">
                {num(segment.temperatureInC, 1)} → {num(segment.temperatureOutC, 1)} °C
              </Td>
              <Td align="right" className={segment.heatFlowW === 0 ? 'text-ink-quiet' : undefined}>
                {segment.heatFlowW === 0 ? '—' : `${num(segment.heatFlowW * 1000, 2)} mW`}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>

      {result.pairs.length > 0 ? <ExchangeTable result={result} /> : null}
    </div>
  );
}

function ExchangeTable({ result }: { result: SimulationResult }) {
  const setFocusedEdgeId = useFluidStore((s) => s.setFocusedEdgeId);
  const index = new Map(result.segments.map((s, i) => [s.edgeId, i + 1]));

  const meaningful = result.pairs.filter((p) => Math.abs(p.heatFlowW) > 1e-9);
  if (meaningful.length === 0) return null;

  return (
    <div className="border-t-2 border-line">
      <p className="bg-panel px-2 py-1.5 text-[11px] font-medium text-ink">
        Heat exchange between neighbouring channels
      </p>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-line text-left text-ink-muted">
            <Th>Pair</Th>
            <Th align="right">Wall</Th>
            <Th align="right">Contact</Th>
            <Th align="right">U</Th>
            <Th align="right">Flux</Th>
            <Th align="right">Heat</Th>
            <Th align="right">NTU</Th>
            <Th align="right">ε</Th>
            <Th align="right">Approach</Th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {meaningful.map((pair) => (
            <tr
              key={`${pair.edgeAId}-${pair.edgeBId}`}
              onMouseEnter={() => setFocusedEdgeId(pair.edgeAId)}
              onMouseLeave={() => setFocusedEdgeId(null)}
              className="border-b border-line/60 hover:bg-sunken"
            >
              <Td>
                {index.get(pair.edgeAId)} ↔ {index.get(pair.edgeBId)}
              </Td>
              <Td align="right">{num(pair.wallThicknessMm, 3)} mm</Td>
              <Td align="right">{num(pair.contactLengthMm, 2)} mm</Td>
              <Td align="right">{num(pair.overallUWm2K, 1)} W/m²K</Td>
              <Td align="right">{num(pair.wallFluxWm2, 1)} W/m²</Td>
              <Td align="right">{num(pair.heatFlowW * 1000, 3)} mW</Td>
              <Td align="right">{num(pair.ntu, 3)}</Td>
              <Td align="right">{num(pair.effectiveness, 3)}</Td>
              <Td align="right">{num(pair.approachC, 2)} °C</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap px-2 py-1.5 font-medium',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={cn(
        'whitespace-nowrap px-2 py-1 text-ink',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  );
}
