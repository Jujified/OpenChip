import { AlertTriangle, Check, ChevronDown, Download, Eye, FlaskConical, Trash2, Upload } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';
import type { DfmCompensation } from '../../hooks/useDfmCompensation';
import { downloadBlob } from '../../lib/download';
import {
  DFM_PROFILE_EXTENSION,
  DFM_PROFILE_MIME,
  dfmProfileFileName,
  parseDfmProfile,
  serializeDfmProfile,
} from '../../lib/dfm/profile';
import { selectedDfmEntry, useDfmStore } from '../../store/dfmStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../ui/Button';
import { MenuContent, MenuItem, MenuLabel, MenuRoot, MenuSeparator, MenuTrigger } from '../ui/Menu';
import { WikiLink } from '../ui/WikiLink';

const NONE_LABEL = 'None (uncompensated)';

/**
 * The print-correction profile selector in the export block.
 *
 * It always starts on "None (uncompensated)", and on None it is the only thing
 * this feature adds to the screen: no hint, no prompt, no badge. Everything
 * else — the offsets, the conflict list, the preview toggle — appears only once
 * a profile is chosen.
 */
export function DfmProfileSelect() {
  const profiles = useDfmStore((s) => s.profiles);
  const selected = useDfmStore(selectedDfmEntry);
  const select = useDfmStore((s) => s.select);
  const addProfile = useDfmStore((s) => s.addProfile);
  const removeProfile = useDfmStore((s) => s.removeProfile);
  const setCalibrationOpen = useDfmStore((s) => s.setCalibrationOpen);
  const lastUsed = useProjectStore((s) => s.project.dfmProfileRef);
  const input = useRef<HTMLInputElement | null>(null);

  const load = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseDfmProfile(await file.text());
    if (!parsed.ok) {
      toast.error(parsed.message, { description: parsed.details.join(' ') || undefined });
      return;
    }
    const entry = await addProfile(parsed.profile);
    select(entry.sha256);
    toast.success(`Loaded ${entry.profile.meta.name}`, {
      description: 'Exports now use this profile. Choose None to export the design as drawn.',
    });
  };

  // The project remembers what it was last exported with, but never selects it
  // on its own: a compensated export is something chosen each session.
  const remembered = lastUsed ? profiles.find((entry) => entry.sha256 === lastUsed.sha256) : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="dfm-profile" className="text-[11px] font-medium text-ink-muted">
        Print correction
      </label>

      <MenuRoot>
        <MenuTrigger asChild>
          <Button id="dfm-profile" size="sm" className="justify-between">
            <span className="truncate">{selected ? selected.profile.meta.name : NONE_LABEL}</span>
            <ChevronDown size={13} className="shrink-0 opacity-60" />
          </Button>
        </MenuTrigger>
        <MenuContent className="w-[17rem]">
          <MenuItem
            icon={selected ? <span className="block w-[15px]" /> : <Check size={15} />}
            onSelect={() => select(null)}
          >
            {NONE_LABEL}
          </MenuItem>

          {profiles.length > 0 ? <MenuLabel>Loaded profiles</MenuLabel> : null}
          {profiles.map((entry) => (
            <MenuItem
              key={entry.sha256}
              icon={
                entry.sha256 === selected?.sha256 ? <Check size={15} /> : <span className="block w-[15px]" />
              }
              onSelect={() => select(entry.sha256)}
            >
              {entry.profile.meta.name}
            </MenuItem>
          ))}

          <MenuSeparator />
          <MenuItem icon={<Upload size={15} />} onSelect={() => input.current?.click()}>
            Load a profile…
          </MenuItem>
          <MenuItem icon={<FlaskConical size={15} />} onSelect={() => setCalibrationOpen(true)}>
            Calibrate a printer…
          </MenuItem>

          {selected ? (
            <>
              <MenuSeparator />
              <MenuItem
                icon={<Download size={15} />}
                onSelect={() =>
                  downloadBlob(
                    serializeDfmProfile(selected.profile),
                    dfmProfileFileName(selected.profile.meta.name),
                    DFM_PROFILE_MIME,
                  )
                }
              >
                Download this profile
              </MenuItem>
              <MenuItem
                icon={<Trash2 size={15} />}
                destructive
                onSelect={() => removeProfile(selected.sha256)}
              >
                Remove from this browser
              </MenuItem>
            </>
          ) : null}
        </MenuContent>
      </MenuRoot>

      <input
        ref={input}
        type="file"
        // `.ocdfm` has no registered type, so JSON is accepted too or some
        // browsers grey the file out.
        accept={`${DFM_PROFILE_EXTENSION},application/json,.json`}
        className="hidden"
        onChange={(event) => {
          void load(event.target.files?.[0]);
          event.target.value = '';
        }}
      />

      {!selected && lastUsed ? (
        <p className="text-[11px] leading-relaxed text-ink-muted">
          Last exported with “{lastUsed.name}”
          {remembered ? (
            <>
              .{' '}
              <button
                type="button"
                className="text-accent underline decoration-accent/35 underline-offset-2 hover:decoration-accent"
                onClick={() => select(remembered.sha256)}
              >
                Use it
              </button>
            </>
          ) : (
            ', which is not loaded in this browser.'
          )}
        </p>
      ) : null}
    </div>
  );
}

const mm = (value: number): string => value.toFixed(3);

/**
 * What the selected profile does to this design: the offsets, and any
 * conflicts. Rendered only while a profile is selected.
 *
 * Conflicts are a caution box, never a gate. The export buttons stay live, and
 * the uncompensated export is one menu choice away.
 */
export function DfmSummary({ dfm }: { dfm: DfmCompensation }) {
  const { applied, conflicts } = dfm.compensated;
  const perSide = { min: applied.widthIncreaseMm.min / 2, max: applied.widthIncreaseMm.max / 2 };
  const varies = perSide.max - perSide.min > 0.0005;

  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-[11px] leading-relaxed text-ink-quiet">
        Δxy {varies ? `${mm(perSide.min)}–${mm(perSide.max)}` : mm(applied.deltaXyMm)} mm per side · Δz{' '}
        {applied.deltaZMm > 0 ? `${mm(applied.deltaZMm)} mm` : 'not applied'}
      </p>

      {conflicts.length > 0 ? (
        <div className="flex gap-2 rounded-lg border border-caution/40 bg-caution-wash px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-caution" />
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-ink">
              {conflicts.length === 1
                ? 'Compensation causes 1 conflict'
                : `Compensation causes ${conflicts.length} conflicts`}
            </p>
            <ul className="mt-1 flex flex-col gap-1">
              {conflicts.slice(0, 4).map((conflict) => (
                <li key={conflict.id} className="text-[11px] leading-relaxed text-ink">
                  {conflict.message}
                </li>
              ))}
            </ul>
            {conflicts.length > 4 ? (
              <p className="mt-1 text-[11px] text-ink-muted">…and {conflicts.length - 4} more.</p>
            ) : null}
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
              You can still export. Give the features more room, or choose {NONE_LABEL} to export
              the design as drawn.
            </p>
          </div>
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-ink-muted">
        Exports are enlarged to print at the drawn size. The design itself is not changed.{' '}
        <WikiLink to="printCorrection">How print correction works</WikiLink>
      </p>
    </div>
  );
}

/** Beside the STL button. Only rendered while a profile is selected. */
export function DfmPreviewToggle() {
  const previewOpen = useDfmStore((s) => s.previewOpen);
  const setPreviewOpen = useDfmStore((s) => s.setPreviewOpen);

  return (
    <Button
      size="sm"
      icon={<Eye size={14} />}
      aria-pressed={previewOpen}
      title="Show the compensated geometry over the design as drawn"
      className={previewOpen ? 'border-accent bg-accent-wash text-accent hover:bg-accent-wash' : undefined}
      onClick={() => setPreviewOpen(!previewOpen)}
    >
      Preview DFM
    </Button>
  );
}
