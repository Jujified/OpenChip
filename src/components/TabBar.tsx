import { Box, LibraryBig, PenLine, Waves } from 'lucide-react';
import { NavLink } from 'react-router';
import { cn } from '../lib/cn';

const TABS = [
  { to: '/draw', label: 'Draw', icon: PenLine },
  { to: '/cad', label: 'CAD Preview', icon: Box },
  { to: '/fluid', label: 'Fluid Dynamics', icon: Waves },
  { to: '/library', label: 'Library', icon: LibraryBig },
] as const;

/**
 * Primary navigation.
 *
 * Deliberately unanimated beyond a colour fade: switching tabs is among the
 * most-repeated actions in the app, and a sliding indicator that delights on
 * the first use is friction on the two-hundredth.
 */
export function TabBar() {
  return (
    <nav aria-label="Workspace sections" className="flex items-center gap-0.5">
      {TABS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          data-tour={to === '/library' ? 'library-tab' : undefined}
          className={({ isActive }) =>
            cn(
              'oc-pressable flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] font-medium',
              isActive ? 'bg-sunken text-ink' : 'text-ink-muted hover:text-ink',
            )
          }
        >
          {({ isActive }) => (
            <>
              <Icon size={15} strokeWidth={2} className={isActive ? 'text-accent' : undefined} />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
