import { LibraryBig, PenLine } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../components/ui/Button';

/**
 * The empty state a tab shows when there is nothing yet to work on.
 *
 * It explains what will appear here and — the part that matters — offers the
 * two ways forward: draw something, or start from a template. An empty state
 * that only describes the emptiness leaves the user to find the exit
 * themselves, which on a first run is exactly when they are least equipped to.
 */
export function Placeholder({
  icon,
  eyebrow,
  title,
  description,
  bullets,
}: {
  icon: ReactNode;
  /** A short label above the title. */
  eyebrow: string;
  title: string;
  description: string;
  bullets: string[];
}) {
  const navigate = useNavigate();

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md text-center">
        <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-panel text-ink-faint">
          {icon}
        </span>

        <p className="mt-5 font-mono text-[11px] uppercase tracking-widest text-ink-quiet">
          {eyebrow}
        </p>
        <h2 className="mt-2 text-lg font-semibold tracking-tight text-ink">{title}</h2>
        <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-ink-muted">
          {description}
        </p>

        <div className="mt-5 flex items-center justify-center gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<LibraryBig size={14} />}
            onClick={() => void navigate('/library')}
          >
            Browse templates
          </Button>
          <Button size="sm" icon={<PenLine size={14} />} onClick={() => void navigate('/draw')}>
            Draw one
          </Button>
        </div>

        <ul className="mx-auto mt-6 flex max-w-sm flex-col gap-2 text-left">
          {bullets.map((bullet) => (
            <li
              key={bullet}
              className="rounded-lg border border-line bg-panel px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-muted"
            >
              {bullet}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
