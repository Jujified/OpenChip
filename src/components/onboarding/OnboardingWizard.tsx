import * as RadixDialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowLeft, ArrowRight, Check, Sparkles, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import {
  CUSTOM_PROFILE_SEED,
  DEFAULT_PROJECT_NAME,
  PRINTER_PRESETS,
  type PrinterPreset,
} from '../../lib/defaults';
import type { PrinterProfile } from '../../types/project';
import { PrinterProfileFields } from '../PrinterProfileFields';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Field';

const STEPS = ['welcome', 'printer', 'name', 'done'] as const;
type Step = (typeof STEPS)[number];

export interface OnboardingResult {
  profile: PrinterProfile;
  projectName: string;
}

/**
 * First-run setup: welcome → printer → project name → done.
 *
 * This is the one flow in the app a user sees exactly once, which is precisely
 * where the animation budget belongs — everywhere else in OpenChip motion is
 * kept minimal because the actions repeat all day.
 */
export function OnboardingWizard({
  open,
  onComplete,
  onCancel,
}: {
  open: boolean;
  onComplete: (result: OnboardingResult) => void;
  /** Only offered when re-running setup — first run has nothing to go back to. */
  onCancel?: () => void;
}) {
  const [step, setStep] = useState<Step>('welcome');
  const [direction, setDirection] = useState<1 | -1>(1);
  const [presetId, setPresetId] = useState<string>(PRINTER_PRESETS[0].id);
  const [profile, setProfile] = useState<PrinterProfile>(PRINTER_PRESETS[0].profile);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [projectName, setProjectName] = useState('');

  const reduceMotion = useReducedMotion();
  const index = STEPS.indexOf(step);

  const go = (next: Step) => {
    setDirection(STEPS.indexOf(next) > index ? 1 : -1);
    setStep(next);
  };

  const choosePreset = (preset: PrinterPreset) => {
    setPresetId(preset.id);
    setProfile(preset.profile);
  };

  const chooseCustom = () => {
    setPresetId('custom');
    setProfile(CUSTOM_PROFILE_SEED);
    setShowAdvanced(true);
  };

  const finish = () =>
    onComplete({ profile, projectName: projectName.trim() || DEFAULT_PROJECT_NAME });

  // Movement is the part that causes motion sickness; the crossfade stays.
  const offset = reduceMotion ? 0 : 24;
  const variants = {
    enter: (dir: 1 | -1) => ({ opacity: 0, transform: `translateX(${dir * offset}px)` }),
    center: { opacity: 1, transform: 'translateX(0px)' },
    exit: (dir: 1 | -1) => ({ opacity: 0, transform: `translateX(${dir * -offset}px)` }),
  };

  return (
    <RadixDialog.Root open={open}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="oc-overlay-motion fixed inset-0 z-50 bg-app/85 backdrop-blur-md" />
        <RadixDialog.Content
          className={cn(
            'oc-dialog-motion fixed left-1/2 top-1/2 z-50 flex w-[min(calc(100vw-2rem),36rem)]',
            'max-h-[88vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl',
            'border border-line bg-elevated shadow-[var(--shadow-dialog)]',
          )}
          // A half-configured app has no printer profile, so the flow must be
          // finished rather than escaped.
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          aria-describedby={undefined}
        >
          <RadixDialog.Title className="sr-only">Set up OpenChip</RadixDialog.Title>

          {/* Expanding "adjust exact values" can outgrow a short window, so the
              steps scroll and the footer stays reachable. */}
          <div className="relative min-h-0 flex-1 overflow-y-auto">
            <AnimatePresence initial={false} mode="wait" custom={direction}>
              <motion.div
                key={step}
                custom={direction}
                variants={variants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                className="min-h-[24rem] px-7 pb-6 pt-8"
              >
                {step === 'welcome' ? <WelcomeStep /> : null}

                {step === 'printer' ? (
                  <PrinterStep
                    presetId={presetId}
                    profile={profile}
                    showAdvanced={showAdvanced}
                    onChoosePreset={choosePreset}
                    onChooseCustom={chooseCustom}
                    onToggleAdvanced={() => setShowAdvanced((v) => !v)}
                    onPatchProfile={(patch) => setProfile((p) => ({ ...p, ...patch }))}
                  />
                ) : null}

                {step === 'name' ? (
                  <NameStep
                    value={projectName}
                    onChange={setProjectName}
                    onSubmit={() => go('done')}
                  />
                ) : null}

                {step === 'done' ? <DoneStep profile={profile} projectName={projectName} /> : null}
              </motion.div>
            </AnimatePresence>
          </div>

          <footer className="flex items-center justify-between gap-4 border-t border-line bg-panel/60 px-7 py-4">
            <StepDots total={STEPS.length} activeIndex={index} />

            <div className="flex items-center gap-2">
              {index === 0 && onCancel ? (
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              ) : null}

              {index > 0 ? (
                <Button
                  variant="ghost"
                  icon={<ArrowLeft size={15} />}
                  onClick={() => go(STEPS[index - 1])}
                >
                  Back
                </Button>
              ) : null}

              {step === 'done' ? (
                <Button variant="primary" icon={<Check size={15} />} onClick={finish}>
                  Start designing
                </Button>
              ) : (
                <Button
                  variant="primary"
                  icon={<ArrowRight size={15} />}
                  onClick={() => go(STEPS[index + 1])}
                >
                  {step === 'welcome' ? 'Get started' : 'Continue'}
                </Button>
              )}
            </div>
          </footer>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

function WelcomeStep() {
  return (
    <div className="flex flex-col">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent-wash text-accent">
        <Sparkles size={20} strokeWidth={1.75} />
      </span>

      <h1 className="mt-5 text-2xl font-semibold tracking-tight text-ink">Welcome to OpenChip</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
        Design microfluidic mixing chips and export them for resin printing — drawing, 3D preview,
        printability checks and flow estimates, all on this machine.
      </p>

      <ul className="mt-6 flex flex-col gap-3">
        {[
          ['Draw the channel network', 'Lay out channels, ports and mixing chambers in 2D.'],
          ['Preview the solid in 3D', 'Watch the chip update live as you change dimensions.'],
          ['Export for your printer', 'STL, OpenSCAD and schematic images, ready to slice.'],
        ].map(([title, body], i) => (
          <li
            key={title}
            className="flex gap-3 opacity-0 [animation:oc-step-in_320ms_var(--ease-out)_forwards]"
            // Short stagger: enough to read as a cascade, not enough to wait on.
            style={{ animationDelay: `${80 + i * 55}ms` }}
          >
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sunken font-mono text-[11px] text-ink-muted">
              {i + 1}
            </span>
            <div>
              <p className="text-[13px] font-medium text-ink">{title}</p>
              <p className="text-[13px] leading-relaxed text-ink-muted">{body}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-6 text-xs text-ink-quiet">
        Nothing leaves your computer. OpenChip has no account and no server.
      </p>
    </div>
  );
}

function PrinterStep({
  presetId,
  profile,
  showAdvanced,
  onChoosePreset,
  onChooseCustom,
  onToggleAdvanced,
  onPatchProfile,
}: {
  presetId: string;
  profile: PrinterProfile;
  showAdvanced: boolean;
  onChoosePreset: (preset: PrinterPreset) => void;
  onChooseCustom: () => void;
  onToggleAdvanced: () => void;
  onPatchProfile: (patch: Partial<PrinterProfile>) => void;
}) {
  return (
    <div className="flex flex-col">
      <h1 className="text-xl font-semibold tracking-tight text-ink">Which printer will you use?</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
        This sets the resolution limits OpenChip checks your design against. You can change it at
        any time, and an approximate answer is fine to start.
      </p>

      <div className="mt-5 flex flex-col gap-2">
        {PRINTER_PRESETS.map((preset) => (
          <PresetCard
            key={preset.id}
            preset={preset}
            selected={presetId === preset.id}
            onSelect={() => onChoosePreset(preset)}
          />
        ))}

        <button
          type="button"
          onClick={onChooseCustom}
          aria-pressed={presetId === 'custom'}
          className={cn(
            'oc-pressable rounded-xl border px-4 py-3 text-left',
            presetId === 'custom'
              ? 'border-accent bg-accent-wash'
              : 'border-line bg-panel hover:border-line-strong',
          )}
        >
          <span className="text-[13px] font-medium text-ink">I&rsquo;ll enter my own values</span>
          <span className="mt-0.5 block text-xs text-ink-muted">
            Set resolution, feature size and build volume by hand.
          </span>
        </button>
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={onToggleAdvanced}
          className="oc-pressable inline-flex items-center gap-2 rounded-md text-[13px] font-medium text-ink-muted hover:text-ink"
        >
          <SlidersHorizontal size={14} />
          {showAdvanced ? 'Hide exact values' : 'Adjust exact values'}
        </button>

        {showAdvanced ? (
          <div className="mt-4 rounded-xl border border-line bg-panel p-4 [animation:oc-step-in_220ms_var(--ease-out)]">
            <PrinterProfileFields
              profile={profile}
              onChange={onPatchProfile}
              idPrefix="onboarding-printer"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PresetCard({
  preset,
  selected,
  onSelect,
}: {
  preset: PrinterPreset;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'oc-pressable rounded-xl border px-4 py-3 text-left',
        selected ? 'border-accent bg-accent-wash' : 'border-line bg-panel hover:border-line-strong',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-ink">{preset.headline}</span>
        <span className="shrink-0 font-mono text-[11px] text-ink-muted">
          {preset.profile.xyResolutionMicrons} µm XY · {preset.profile.layerHeightMicrons} µm layer
        </span>
      </div>
      <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{preset.blurb}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-quiet">e.g. {preset.examples}</p>
    </button>
  );
}

function NameStep({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-col">
      <h1 className="text-xl font-semibold tracking-tight text-ink">Name your first project</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
        This becomes the filename when you save. You can rename it whenever you like.
      </p>

      <form
        className="mt-6"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Field label="Project name" htmlFor="onboarding-project-name">
          <TextInput
            id="onboarding-project-name"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={DEFAULT_PROJECT_NAME}
            autoFocus
            maxLength={80}
          />
        </Field>
      </form>

      <p className="mt-3 text-xs text-ink-quiet">
        Leave it blank to use &ldquo;{DEFAULT_PROJECT_NAME}&rdquo;.
      </p>
    </div>
  );
}

function DoneStep({ profile, projectName }: { profile: PrinterProfile; projectName: string }) {
  const rows: [string, string][] = [
    ['Project', projectName.trim() || DEFAULT_PROJECT_NAME],
    ['Printer', profile.name],
    ['Resolution', `${profile.xyResolutionMicrons} µm XY · ${profile.layerHeightMicrons} µm layer`],
    ['Smallest feature', `${profile.minFeatureSizeMm} mm`],
    [
      'Build volume',
      `${profile.buildVolumeMm.x} × ${profile.buildVolumeMm.y} × ${profile.buildVolumeMm.z} mm`,
    ],
  ];

  return (
    <div className="flex flex-col">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent-wash text-accent">
        <Check size={20} strokeWidth={2} />
      </span>

      <h1 className="mt-5 text-xl font-semibold tracking-tight text-ink">You&rsquo;re set up</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
        Your printer becomes the default for every new project. Everything here stays editable from
        the settings menu.
      </p>

      <dl className="mt-5 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
            <dt className="text-[13px] text-ink-muted">{label}</dt>
            <dd className="text-right font-mono text-[12px] text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// progress
// ---------------------------------------------------------------------------

function StepDots({ total, activeIndex }: { total: number; activeIndex: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-1.5 rounded-full transition-all duration-300 [transition-timing-function:var(--ease-out)]',
            i === activeIndex ? 'w-5 bg-accent' : 'w-1.5 bg-line-strong',
          )}
        />
      ))}
    </div>
  );
}
