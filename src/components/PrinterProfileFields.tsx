import { Field, NumberInput, TextInput } from './ui/Field';
import { WikiLink } from './ui/WikiLink';
import type { PrinterProfile } from '../types/project';

/**
 * Every field of a printer profile, editable.
 *
 * Shared by the onboarding wizard and the settings dialog so the two can never
 * drift — and so a preset is only ever a starting point, never a set of values
 * the user is locked out of (no parameter is ever permanently hidden).
 */
export function PrinterProfileFields({
  profile,
  onChange,
  idPrefix = 'printer',
}: {
  profile: PrinterProfile;
  onChange: (patch: Partial<PrinterProfile>) => void;
  idPrefix?: string;
}) {
  const id = (suffix: string) => `${idPrefix}-${suffix}`;

  return (
    <div className="flex flex-col gap-4">
      {/* Shown in both the wizard and Settings. Every manufacturability warning
          is measured against these numbers, so it is worth knowing where they
          come from — and how to measure your own rather than trusting a preset. */}
      <p className="text-[12px] leading-relaxed text-ink-muted">
        Every design check is measured against these.{' '}
        <WikiLink to="printerProfile">How to find the numbers for your machine</WikiLink>
      </p>

      <Field label="Profile name" htmlFor={id('name')}>
        <TextInput
          id={id('name')}
          value={profile.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="My printer"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="XY resolution"
          htmlFor={id('xy')}
          hint="Pixel pitch of the LCD, from the printer's spec sheet."
        >
          <NumberInput
            id={id('xy')}
            value={profile.xyResolutionMicrons}
            onChange={(xyResolutionMicrons) => onChange({ xyResolutionMicrons })}
            unit="µm"
            min={1}
            max={500}
            step={1}
            precision={1}
          />
        </Field>

        <Field label="Layer height" htmlFor={id('layer')} hint="Z step per exposure.">
          <NumberInput
            id={id('layer')}
            value={profile.layerHeightMicrons}
            onChange={(layerHeightMicrons) => onChange({ layerHeightMicrons })}
            unit="µm"
            min={1}
            max={500}
            step={5}
            precision={1}
          />
        </Field>
      </div>

      <Field
        label="Minimum feature size"
        htmlFor={id('minfeature')}
        hint="The smallest detail this printer resolves reliably. Channels below this get a warning — never a block."
      >
        <NumberInput
          id={id('minfeature')}
          value={profile.minFeatureSizeMm}
          onChange={(minFeatureSizeMm) => onChange({ minFeatureSizeMm })}
          unit="mm"
          min={0.01}
          max={10}
          step={0.01}
          precision={3}
        />
      </Field>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-[13px] font-medium text-ink">Build volume</legend>
        <div className="grid grid-cols-3 gap-3">
          <NumberInput
            value={profile.buildVolumeMm.x}
            onChange={(x) => onChange({ buildVolumeMm: { ...profile.buildVolumeMm, x } })}
            unit="mm"
            min={1}
            step={1}
            precision={1}
            aria-label="Build volume X"
          />
          <NumberInput
            value={profile.buildVolumeMm.y}
            onChange={(y) => onChange({ buildVolumeMm: { ...profile.buildVolumeMm, y } })}
            unit="mm"
            min={1}
            step={1}
            precision={1}
            aria-label="Build volume Y"
          />
          <NumberInput
            value={profile.buildVolumeMm.z}
            onChange={(z) => onChange({ buildVolumeMm: { ...profile.buildVolumeMm, z } })}
            unit="mm"
            min={1}
            step={1}
            precision={1}
            aria-label="Build volume Z"
          />
        </div>
        <p className="text-xs text-ink-muted">Width × depth × height of the build plate.</p>
      </fieldset>
    </div>
  );
}
