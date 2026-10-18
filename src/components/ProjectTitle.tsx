import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { useProjectStore } from '../store/projectStore';

/**
 * Click-to-rename project title, with the save state beside it.
 *
 * A rename is a one-keystroke operation in every design tool worth using, so
 * it does not get buried in a settings dialog.
 */
export function ProjectTitle() {
  const name = useProjectStore((state) => state.project.meta.name);
  const fileName = useProjectStore((state) => state.fileName);
  const isDirty = useProjectStore((state) => state.isDirty);
  const setProjectName = useProjectStore((state) => state.setProjectName);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== name) setProjectName(next);
    else setDraft(name);
    setEditing(false);
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          maxLength={80}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') {
              setDraft(name);
              setEditing(false);
            }
          }}
          className="h-7 min-w-0 max-w-[18rem] rounded-md border border-accent bg-panel px-2 text-[13px] font-medium text-ink outline-none"
          aria-label="Project name"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(name);
            setEditing(true);
          }}
          title="Click to rename"
          className="oc-pressable max-w-[18rem] truncate rounded-md px-2 py-1 text-[13px] font-medium text-ink hover:bg-sunken"
        >
          {name}
        </button>
      )}

      <SaveState isDirty={isDirty} fileName={fileName} />
    </div>
  );
}

function SaveState({ isDirty, fileName }: { isDirty: boolean; fileName: string | null }) {
  const label = isDirty ? 'Unsaved changes' : fileName ? `Saved to ${fileName}` : 'Not saved yet';

  return (
    <span
      className="flex items-center gap-1.5 text-[11px] text-ink-quiet"
      title={label}
      aria-live="polite"
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 rounded-full transition-colors duration-200',
          isDirty ? 'bg-caution' : fileName ? 'bg-success' : 'bg-line-strong',
        )}
      />
      <span className="hidden truncate sm:inline">{label}</span>
    </span>
  );
}
