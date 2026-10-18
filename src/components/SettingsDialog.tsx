import { Check, Printer } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '../lib/cn';
import { PRINTER_PRESETS } from '../lib/defaults';
import { useChipResize } from '../hooks/useChipResize';
import { useProjectStore } from '../store/projectStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { PrinterProfileFields } from './PrinterProfileFields';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Field, NumberInput, Segmented, TextInput } from './ui/Field';

type Section = 'project' | 'chip' | 'printer';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'project', label: 'Project' },
  { id: 'chip', label: 'Chip' },
  { id: 'printer', label: 'Printer' },
];

/**
 * Everything in the data model that a user can change, reachable in one place.
 *
 * The CAD view has its own live parameter panel, but these values are editable
 * here too, from any view: no parameter may be unreachable.
 */
export function SettingsDialog() {
  const open = useUiStore((state) => state.settingsOpen);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  const [section, setSection] = useState<Section>('project');

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Settings"
      description="Applies to the project you have open. Printer changes can also become the default for new projects."
      className="w-[min(calc(100vw-2rem),40rem)]"
      footer={
        <Button variant="primary" onClick={() => setOpen(false)}>
          Done
        </Button>
      }
    >
      <div className="mb-5 flex gap-0.5 rounded-lg bg-sunken p-0.5">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSection(item.id)}
            className={cn(
              'oc-pressable flex-1 rounded-[6px] px-3 py-1.5 text-[13px] font-medium',
              section === item.id ? 'bg-panel text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {section === 'project' ? <ProjectSection /> : null}
      {section === 'chip' ? <ChipSection /> : null}
      {section === 'printer' ? <PrinterSection /> : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

function ProjectSection() {
  const meta = useProjectStore((state) => state.project.meta);
  const fileName = useProjectStore((state) => state.fileName);
  const setProjectName = useProjectStore((state) => state.setProjectName);

  const format = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-4 pb-4">
      <Field label="Project name" htmlFor="settings-project-name">
        <TextInput
          id="settings-project-name"
          value={meta.name}
          maxLength={80}
          onChange={(event) => setProjectName(event.target.value)}
        />
      </Field>

      <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
        {[
          ['File', fileName ?? 'Not saved to a file yet'],
          ['Created', format(meta.createdAt)],
          ['Last modified', format(meta.modifiedAt)],
          ['Units', 'Millimetres (mm)'],
        ].map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
            <dt className="text-[13px] text-ink-muted">{label}</dt>
            <dd className="truncate text-right font-mono text-[12px] text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ChipSection() {
  const chipParams = useProjectStore((state) => state.project.chipParams);
  const update = useProjectStore((state) => state.updateChipParams);
  const resize = useChipResize();

  return (
    <div className="flex flex-col gap-4 pb-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Width" htmlFor="chip-width" hint="Chip footprint along X.">
          <NumberInput
            id="chip-width"
            value={chipParams.width}
            onChange={(width) => resize({ width })}
            unit="mm"
            min={1}
            step={1}
          />
        </Field>
        <Field label="Length" htmlFor="chip-length" hint="Chip footprint along Y.">
          <NumberInput
            id="chip-length"
            value={chipParams.length}
            onChange={(length) => resize({ length })}
            unit="mm"
            min={1}
            step={1}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Base thickness" htmlFor="chip-base" hint="Total block height.">
          <NumberInput
            id="chip-base"
            value={chipParams.baseThickness}
            onChange={(baseThickness) => update({ baseThickness })}
            unit="mm"
            min={0.1}
            step={0.5}
          />
        </Field>
        <Field
          label="Wall thickness"
          htmlFor="chip-wall"
          hint="Minimum material between a channel and anything else."
        >
          <NumberInput
            id="chip-wall"
            value={chipParams.wallThickness}
            onChange={(wallThickness) => update({ wallThickness })}
            unit="mm"
            min={0.1}
            step={0.1}
          />
        </Field>
      </div>

      <Field
        label="Minimum edge spacing"
        htmlFor="chip-edge"
        hint="Channels closer than this to the chip boundary get flagged — never blocked."
      >
        <NumberInput
          id="chip-edge"
          value={chipParams.minEdgeSpacing}
          onChange={(minEdgeSpacing) => update({ minEdgeSpacing })}
          unit="mm"
          min={0}
          step={0.5}
        />
      </Field>

      <Field
        label="Split type"
        hint={
          chipParams.splitType === 'monolithic'
            ? 'A single sealed block. Trapped resin is hard to clear — add drainage holes from the CAD view.'
            : chipParams.splitType === 'glass-slide'
              ? 'Prints open-faced, with a pocket for a glass slide to close the channels. Sized on the CAD Preview tab.'
              : 'Cut into an open-channel piece and a flat lid that bond together.'
        }
      >
        <Segmented
          value={chipParams.splitType}
          onChange={(splitType) => update({ splitType })}
          options={[
            { value: 'two-piece', label: 'Two-piece' },
            { value: 'monolithic', label: 'Monolithic' },
            { value: 'glass-slide', label: 'Glass slide' },
          ]}
        />
      </Field>

      <Field
        label="Split height"
        htmlFor="chip-split"
        hint={
          chipParams.splitType === 'glass-slide'
            ? 'Not used by a glass-slide chip: the channels open onto the pocket floor instead.'
            : 'Z height of the cut plane. Only used by the two-piece split.'
        }
      >
        <NumberInput
          id="chip-split"
          value={chipParams.splitHeight}
          onChange={(splitHeight) => update({ splitHeight })}
          unit="mm"
          min={0}
          max={chipParams.baseThickness}
          step={0.1}
          disabled={chipParams.splitType !== 'two-piece'}
        />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PrinterSection() {
  const profile = useProjectStore((state) => state.project.printerProfile);
  const update = useProjectStore((state) => state.updatePrinterProfile);
  const defaultProfile = useSettingsStore((state) => state.defaultPrinterProfile);
  const setDefaultProfile = useSettingsStore((state) => state.setDefaultPrinterProfile);

  const isDefault = JSON.stringify(profile) === JSON.stringify(defaultProfile);

  return (
    <div className="flex flex-col gap-4 pb-4">
      <div className="flex flex-wrap gap-2">
        {PRINTER_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => update(preset.profile)}
            className="oc-pressable rounded-lg border border-line bg-panel px-3 py-1.5 text-[12px] font-medium text-ink-muted hover:border-line-strong hover:text-ink"
          >
            {preset.headline}
          </button>
        ))}
      </div>

      <PrinterProfileFields profile={profile} onChange={update} idPrefix="settings-printer" />

      <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-panel px-4 py-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">Use for new projects</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            {isDefault
              ? 'This profile is already the default.'
              : `New projects currently start with “${defaultProfile.name}”.`}
          </p>
        </div>
        <Button
          size="sm"
          disabled={isDefault}
          icon={isDefault ? <Check size={14} /> : <Printer size={14} />}
          onClick={() => {
            setDefaultProfile(profile);
            toast.success('Default printer updated', {
              description: `New projects will start with “${profile.name}”.`,
            });
          }}
        >
          {isDefault ? 'Default' : 'Set as default'}
        </Button>
      </div>
    </div>
  );
}
