import { cn } from '../../lib/cn';
import { contextHelpUrl, type ContextLink } from '../../lib/wikiLinks';

/**
 * A quiet inline link into the wiki.
 *
 * Deliberately not a button and deliberately not animated. These sit next to
 * controls a user touches constantly, and the frequency gate is explicit: motion
 * on a high-frequency surface stops being feedback and becomes a tax. A colour
 * transition on hover is the whole treatment.
 *
 * Always opens in a new tab. Someone part-way through a design should not lose
 * their canvas — and unlike a documentation site, the thing behind this link is
 * something you read *while* working.
 *
 * The destination comes from `wikiLinks.ts` by name, never as a URL. That is
 * what lets `npm run wiki:audit` prove every one of these resolves.
 */
export function WikiLink({
  to,
  children = 'Learn more',
  className,
}: {
  to: ContextLink;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={contextHelpUrl(to)}
      target="_blank"
      rel="noopener"
      className={cn(
        'text-accent underline decoration-accent/35 underline-offset-2',
        'transition-colors hover:decoration-accent',
        className,
      )}
    >
      {children}
    </a>
  );
}
