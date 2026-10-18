import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { TOUR_STEPS, type TourStep } from '../../lib/tour';
import { cn } from '../../lib/cn';
import { useTourStore } from '../../store/tourStore';
import { Button } from '../ui/Button';

/** Breathing room around the spotlit element, px. */
const PAD = 8;
const CARD_WIDTH = 340;
const CARD_GAP = 14;
const VIEWPORT_MARGIN = 12;
/** Used for the very first paint, before the card has been measured. */
const FALLBACK_CARD_HEIGHT = 260;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function TourOverlay() {
  const active = useTourStore((s) => s.active);
  const stepIndex = useTourStore((s) => s.stepIndex);
  const next = useTourStore((s) => s.next);
  const previous = useTourStore((s) => s.previous);
  const stop = useTourStore((s) => s.stop);

  const step = TOUR_STEPS[stepIndex] as TourStep | undefined;
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // The step's route is taken before its target is looked for, or the very
  // first lookup on a cross-tab step would always miss.
  useEffect(() => {
    if (!active || !step?.route || pathname === step.route) return;
    void navigate(step.route);
  }, [active, navigate, pathname, step?.route]);

  const target = useTargetBox(step?.target ?? null, active, stepIndex);

  // The cards differ in length by a hundred pixels or more, and on a short
  // window guessing wrong is the difference between a readable card and one
  // with its buttons off the bottom edge. So it is measured after layout.
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(FALLBACK_CARD_HEIGHT);

  useLayoutEffect(() => {
    if (!active) return;
    const measured = cardRef.current?.offsetHeight;
    if (measured && measured !== cardHeight) setCardHeight(measured);
  }, [active, stepIndex, cardHeight, target]);

  useEffect(() => {
    if (!active) return;

    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          stop();
          break;
        case 'ArrowRight':
        case 'Enter':
          event.preventDefault();
          next();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          previous();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active, next, previous, stop]);

  if (!active || !step) return null;

  const isLast = stepIndex === TOUR_STEPS.length - 1;
  const card = cardPosition(target, step.placement, cardHeight);

  return (
    <div className="fixed inset-0 z-[1000000000]" role="dialog" aria-modal="true" aria-label="Guided tour">
      {/* The scrim is a huge spread shadow around the cut-out rather than an SVG
          mask or four separate panels: one element, one paint, and it stays
          exact at any target size. When there is no target it degrades to a
          plain full-screen scrim instead of breaking.

          The accent edge is an `outline`, not Tailwind's `ring`: `ring` is
          itself a box-shadow, so the inline scrim below would silently replace
          it and the spotlight would have no visible edge at all. */}
      {target ? (
        <div
          className="pointer-events-none absolute rounded-xl outline outline-2 outline-accent transition-[top,left,width,height] duration-300 ease-[var(--ease-in-out)]"
          style={{
            top: target.top - PAD,
            left: target.left - PAD,
            width: target.width + PAD * 2,
            height: target.height + PAD * 2,
            boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.55)',
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}

      {/* Catches clicks anywhere outside the spotlight so the tour is not
          fighting the UI underneath it, without swallowing the cut-out. */}
      <button
        type="button"
        aria-label="Leave the tour"
        tabIndex={-1}
        className="absolute inset-0 cursor-default"
        onClick={stop}
      />

      <div
        className={cn(
          'absolute w-[min(21.25rem,calc(100vw-1.5rem))] rounded-2xl border border-line',
          'bg-elevated p-5 shadow-[var(--shadow-dialog)]',
          'motion-safe:animate-[oc-step-in_260ms_var(--ease-out)]',
        )}
        // Keyed by step so each card genuinely enters. Without it React reuses
        // the element, the keyframe plays once on mount, and every step after
        // the first appears with no transition at all.
        key={step.id}
        ref={cardRef}
        style={{ top: card.top, left: card.left }}
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-quiet">
          Step {stepIndex + 1} of {TOUR_STEPS.length}
        </p>
        <h2 className="mt-2 text-[15px] font-semibold tracking-tight text-ink">{step.title}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{step.body}</p>

        <div className="mt-4 flex items-center gap-2">
          <div className="flex gap-1" aria-hidden>
            {TOUR_STEPS.map((each, index) => (
              <span
                key={each.id}
                className={cn(
                  'h-1.5 rounded-full transition-[width,background-color] duration-300 ease-[var(--ease-out)]',
                  index === stepIndex ? 'w-4 bg-accent' : 'w-1.5 bg-line-strong',
                )}
              />
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {stepIndex === 0 ? (
              <Button variant="ghost" size="sm" onClick={stop}>
                Not now
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={previous}>
                Back
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={next}>
              {isLast ? 'Done' : stepIndex === 0 ? 'Show me' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Where the spotlit element is, tracked continuously while a step is active.
 *
 * Measuring at discrete moments — on mount, on resize, on scroll — looks
 * cheaper and is wrong: a step that changes tab asks for an element the
 * previous render has not mounted, and one that scrolls a panel measures the
 * target mid-scroll and leaves the ring stranded where the element used to be.
 * Every one of those is a separate race with its own fix.
 *
 * A frame loop for the length of a tour step collapses them into one mechanism
 * that is correct by construction. It costs a `getBoundingClientRect` per frame
 * on a modal overlay the user is reading, and it re-renders only when the box
 * actually moves.
 */
function useTargetBox(targetId: string | null, active: boolean, stepIndex: number): Box | null {
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    setBox(null);
    if (!active || !targetId) return;

    let frame = 0;
    let revealed = false;
    let current: Box | null = null;

    const moved = (a: Box, b: Box) =>
      Math.abs(a.top - b.top) > 0.5 ||
      Math.abs(a.left - b.left) > 0.5 ||
      Math.abs(a.width - b.width) > 0.5 ||
      Math.abs(a.height - b.height) > 0.5;

    const tick = () => {
      const element = document.querySelector(`[data-tour="${targetId}"]`);

      if (element) {
        // The split-height control lives near the bottom of a scrolling panel,
        // so on a short window it starts below the fold. A ring drawn around
        // something the user cannot see is worse than no ring — it reads as the
        // tour pointing at nothing.
        if (!revealed) {
          revealed = true;
          element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }

        const rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          const next = {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          };
          if (!current || moved(current, next)) {
            current = next;
            setBox(next);
          }
        }
      }

      frame = requestAnimationFrame(tick);
    };

    tick();
    return () => cancelAnimationFrame(frame);
  }, [active, targetId, stepIndex]);

  return box;
}

/** Puts the card beside the target, flipping and clamping to stay on screen. */
function cardPosition(
  target: Box | null,
  placement: TourStep['placement'],
  cardHeight: number,
): { top: number; left: number } {
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  if (!target) {
    return {
      top: Math.max(VIEWPORT_MARGIN, (viewportHeight - cardHeight) / 2),
      left: Math.max(VIEWPORT_MARGIN, (viewportWidth - CARD_WIDTH) / 2),
    };
  }

  const clampX = (value: number) =>
    Math.min(Math.max(value, VIEWPORT_MARGIN), viewportWidth - CARD_WIDTH - VIEWPORT_MARGIN);
  const clampY = (value: number) =>
    Math.min(Math.max(value, VIEWPORT_MARGIN), viewportHeight - cardHeight - VIEWPORT_MARGIN);

  const below = target.top + target.height + PAD + CARD_GAP;
  const above = target.top - PAD - CARD_GAP - cardHeight;
  const rightOf = target.left + target.width + PAD + CARD_GAP;
  const leftOf = target.left - PAD - CARD_GAP - CARD_WIDTH;

  const centerX = clampX(target.left + target.width / 2 - CARD_WIDTH / 2);
  const centerY = clampY(target.top + target.height / 2 - cardHeight / 2);

  switch (placement) {
    case 'top':
      return above >= VIEWPORT_MARGIN
        ? { top: above, left: centerX }
        : { top: clampY(below), left: centerX };

    case 'left':
      return leftOf >= VIEWPORT_MARGIN
        ? { top: centerY, left: leftOf }
        : { top: centerY, left: clampX(rightOf) };

    case 'right':
      return rightOf + CARD_WIDTH <= viewportWidth - VIEWPORT_MARGIN
        ? { top: centerY, left: rightOf }
        : { top: centerY, left: clampX(leftOf) };

    default:
      return below + cardHeight <= viewportHeight - VIEWPORT_MARGIN
        ? { top: below, left: centerX }
        : { top: clampY(above), left: centerX };
  }
}
