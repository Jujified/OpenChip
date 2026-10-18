/**
 * The catalogue drawings.
 *
 * Both views are generated from `fittingProfile()`, which reads the fitting's
 * own dimensions — so the picture beside a part's name is the part, and a
 * dimension callout cannot drift away from the geometry that gets exported.
 * That is also why these are SVG rather than captured renders: a committed PNG
 * goes stale the moment a number changes, silently.
 *
 * Two views, because they answer different questions. The **section** says how
 * big it is and where it seals. The **solid** says what it looks like in the
 * hand, which is what tells you at a glance whether the chip grows a spigot or
 * a hole.
 */

import { useId } from 'react';
import type { PortType } from '../../types/project';
import { fittingProfile, type Dimension } from '../../lib/cad/fittingProfile';

export type FittingView = 'section' | 'solid';

/** Foreshortening of a circle seen from slightly above. */
const TILT = 0.3;

interface Props {
  portType: PortType;
  boreMm: number;
  spec?: Record<string, number | string>;
  view: FittingView;
  className?: string;
}

export function FittingDrawing({ portType, boreMm, spec = {}, view, className }: Props) {
  const profile = fittingProfile(portType, boreMm, spec);
  const gradientId = useId();

  // Asymmetric on purpose: the length callout and its label live off the right
  // edge, and nothing but a centered diameter label needs room on the left. A
  // symmetric margin would letterbox the part down to nothing in a square well.
  const padLeft = view === 'section' ? 1.4 : 1.2;
  const padRight = view === 'section' ? 6.2 : 1.2;
  const padY = view === 'section' ? 1.8 : profile.maxRadius * TILT + 1.2;
  const left = -profile.maxRadius - padLeft;
  const width = profile.maxRadius * 2 + padLeft + padRight;
  const height = profile.zMax - profile.zMin + padY * 2;

  // z runs up, SVG y runs down.
  const viewBox = `${left} ${-profile.zMax - padY} ${width} ${height}`;

  return (
    <svg
      viewBox={viewBox}
      className={className}
      role="img"
      aria-label={
        view === 'section'
          ? 'Dimensioned cross-section of the fitting'
          : 'Solid view of the fitting'
      }
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--color-ink-muted)" stopOpacity="0.42" />
          <stop offset="38%" stopColor="var(--color-ink-muted)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--color-ink)" stopOpacity="0.34" />
        </linearGradient>
      </defs>
      {view === 'section' ? (
        <Section profile={profile} />
      ) : (
        <Solid profile={profile} fill={`url(#${gradientId})`} />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// section
// ---------------------------------------------------------------------------

type Profile = ReturnType<typeof fittingProfile>;

/**
 * Material is everything between the void and the outside, so the section is
 * that band — drawn on the right and mirrored, the way a half-section is
 * conventionally laid out.
 */
function Section({ profile }: { profile: Profile }) {
  const band = [
    ...profile.outer.map((p) => `${p.r},${-p.z}`),
    ...[...profile.inner].reverse().map((p) => `${p.r},${-p.z}`),
  ].join(' ');

  return (
    <>
      <g>
        <polygon
          points={band}
          fill="var(--color-ink)"
          fillOpacity="0.14"
          stroke="var(--color-ink)"
          strokeOpacity="0.75"
          strokeWidth="0.18"
          strokeLinejoin="round"
        />
        <polygon
          points={band}
          transform="scale(-1,1)"
          fill="var(--color-ink)"
          fillOpacity="0.14"
          stroke="var(--color-ink)"
          strokeOpacity="0.75"
          strokeWidth="0.18"
          strokeLinejoin="round"
        />
      </g>

      {/* Centerline — the axis every diameter is measured across. */}
      <line
        x1="0"
        y1={-profile.zMax - 1.2}
        x2="0"
        y2={-profile.zMin + 1.2}
        stroke="var(--color-accent)"
        strokeOpacity="0.55"
        strokeWidth="0.12"
        strokeDasharray="1.4 0.6 0.35 0.6"
      />

      {placeLabels(profile.dimensions).map(({ dim, below }, i) => (
        <Callout key={i} dim={dim} below={below} maxRadius={profile.maxRadius} />
      ))}
    </>
  );
}

/**
 * Decides which side of its line each diameter label sits on.
 *
 * Diameters are all measured across the same axis, so two taken at nearby
 * heights put their labels in the same place — a luer-lock's collar and the
 * small end of its taper are 1.6 mm apart and overlapped into mush. Flipping
 * every label that crowds its neighbour to the underside separates them
 * without moving either dimension line.
 */
function placeLabels(dimensions: Dimension[]) {
  const MIN_GAP = 2.2;
  const diameters = dimensions.filter((d) => d.kind === 'diameter');

  return dimensions.map((dim) => {
    if (dim.kind !== 'diameter') return { dim, below: false };

    // The *lower* of a crowded pair is the one that drops. Sending it up would
    // push it toward its neighbour rather than away — which is the bug this
    // replaced.
    const crowdedFromAbove = diameters.some(
      (other) => other !== dim && other.z > dim.z && other.z - dim.z < MIN_GAP,
    );
    return { dim, below: crowdedFromAbove };
  });
}

function Callout({
  dim,
  below,
  maxRadius,
}: {
  dim: Dimension;
  below: boolean;
  maxRadius: number;
}) {
  const stroke = 'var(--color-accent)';
  const tick = 0.32;

  if (dim.kind === 'diameter') {
    const y = -dim.z;
    return (
      <g fill="none" stroke={stroke} strokeWidth="0.12" strokeOpacity="0.9">
        <line x1={-dim.r} y1={y} x2={dim.r} y2={y} />
        {[-dim.r, dim.r].map((x) => (
          <line key={x} x1={x} y1={y - tick} x2={x} y2={y + tick} />
        ))}
        <text
          x="0"
          y={below ? y + 1.5 : y - 0.6}
          textAnchor="middle"
          fill="var(--color-accent)"
          stroke="none"
          fontSize="1.35"
          fontFamily="var(--font-mono)"
        >
          {dim.label}
        </text>
      </g>
    );
  }

  // Lengths sit outside the part, clear of the silhouette.
  const x = maxRadius + 2.4;
  return (
    <g fill="none" stroke={stroke} strokeWidth="0.12" strokeOpacity="0.9">
      <line x1={x} y1={-dim.z0} x2={x} y2={-dim.z1} />
      {[dim.z0, dim.z1].map((z) => (
        <g key={z}>
          <line x1={x - tick} y1={-z} x2={x + tick} y2={-z} />
          <line
            x1={dim.r}
            y1={-z}
            x2={x - tick}
            y2={-z}
            strokeOpacity="0.3"
            strokeDasharray="0.4 0.35"
          />
        </g>
      ))}
      <text
        x={x + 0.75}
        y={-(dim.z0 + dim.z1) / 2 + 0.45}
        fill="var(--color-accent)"
        stroke="none"
        fontSize="1.35"
        fontFamily="var(--font-mono)"
      >
        {dim.label}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// solid
// ---------------------------------------------------------------------------

/**
 * The same profile revolved.
 *
 * A circle of radius `r` at height `z` seen from slightly above projects to an
 * ellipse, so the silhouette is the profile itself and the roundness comes
 * from the rings drawn at each break in it. Cheap, and it reads correctly.
 */
function Solid({ profile, fill }: { profile: Profile; fill: string }) {
  const body = [
    ...profile.outer.map((p) => `${-p.r},${-p.z}`),
    ...[...profile.outer].reverse().map((p) => `${p.r},${-p.z}`),
  ].join(' ');

  const top = profile.outer[profile.outer.length - 1];
  const mouth = profile.inner[profile.inner.length - 1];

  // Every break in the silhouette is a visible edge running round the part.
  const rings = profile.outer.filter(
    (p, i) => i > 0 && i < profile.outer.length - 1 && p.r > 0.05,
  );

  return (
    <>
      <polygon
        points={body}
        fill={fill}
        stroke="var(--color-ink)"
        strokeOpacity="0.7"
        strokeWidth="0.16"
        strokeLinejoin="round"
      />

      {rings.map((p, i) => (
        <path
          key={i}
          d={`M ${-p.r} ${-p.z} A ${p.r} ${p.r * TILT} 0 0 0 ${p.r} ${-p.z}`}
          fill="none"
          stroke="var(--color-ink)"
          strokeOpacity="0.28"
          strokeWidth="0.11"
        />
      ))}

      {/* The top face, and the opening through it. */}
      <ellipse
        cx="0"
        cy={-top.z}
        rx={top.r}
        ry={top.r * TILT}
        fill="var(--color-panel)"
        stroke="var(--color-ink)"
        strokeOpacity="0.7"
        strokeWidth="0.16"
      />
      {mouth.r > 0.05 ? (
        <ellipse
          cx="0"
          cy={-mouth.z}
          rx={mouth.r}
          ry={mouth.r * TILT}
          fill="var(--color-ink)"
          fillOpacity="0.55"
          stroke="var(--color-ink)"
          strokeOpacity="0.7"
          strokeWidth="0.13"
        />
      ) : null}
    </>
  );
}
