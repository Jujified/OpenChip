import { Check, Copy, Download, ExternalLink } from 'lucide-react';
import { useState, type DragEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useProjectActions } from '../hooks/useProjectActions';
import { cn } from '../lib/cn';
import {
  DESCRIPTION_PLACEHOLDER,
  SKILL_INSTALL_COMMAND,
  buildDesignPrompt,
  buildSkillZip,
  claudeUrl,
} from '../lib/designWithAi';
import { downloadBlob } from '../lib/download';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Segmented } from './ui/Field';

type Route = 'claude' | 'agent';

/**
 * "Design with AI": describe a chip, hand it to an assistant that has the
 * openchip-design skill, and open the file it sends back.
 *
 * OpenChip itself sends nothing anywhere. Every control here copies text,
 * downloads a file built from data compiled into the app, or opens a link the
 * user chose to follow.
 */
export function DesignWithAiDialog() {
  const open = useUiStore((s) => s.designWithAiOpen);
  const setOpen = useUiStore((s) => s.setDesignWithAiOpen);
  const printer = useProjectStore((s) => s.project.printerProfile);
  const { open: pickFile, openFile } = useProjectActions();
  const navigate = useNavigate();

  // Kept here rather than in the dialog body so a description survives closing
  // the dialog to go and check something.
  const [description, setDescription] = useState('');
  const [route, setRoute] = useState<Route>('claude');

  const prompt = buildDesignPrompt(description, printer);

  const afterOpen = (status: string | undefined) => {
    if (status !== 'opened') return;
    setOpen(false);
    void navigate('/draw');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Design with AI"
      description="An assistant with the OpenChip skill lays out the chip; you open the file here."
      className="w-[min(calc(100vw-2rem),36rem)]"
    >
      <div className="flex flex-col gap-5 pb-2">
        <Step number={1} title="Describe the chip">
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={DESCRIPTION_PLACEHOLDER}
            aria-label="Describe the chip"
            rows={3}
            className={cn(
              'w-full resize-y rounded-lg border border-line-strong bg-panel px-3 py-2.5',
              'text-[13px] leading-relaxed text-ink placeholder:text-ink-faint',
              'focus:border-accent focus:outline-none',
            )}
          />
          <p className="text-[12px] leading-relaxed text-ink-muted">
            Say what it should <i>do</i>. The assistant asks about anything it needs, and your
            printer profile ({printer.name}) is added to the prompt.
          </p>
        </Step>

        <Step number={2} title="Send it to your assistant">
          <Segmented
            value={route}
            onChange={setRoute}
            options={[
              { value: 'claude' as const, label: 'Claude app' },
              { value: 'agent' as const, label: 'Coding agent' },
            ]}
            className="self-start"
          />
          {route === 'claude' ? <ClaudeRoute prompt={prompt} /> : <AgentRoute prompt={prompt} />}
        </Step>

        <Step number={3} title="Bring the chip back">
          <DropZone
            onFile={async (file) => afterOpen((await openFile(file))?.status)}
            onPick={async () => afterOpen((await pickFile())?.status)}
          />
        </Step>

        <p className="border-t border-line pt-3 text-[12px] leading-relaxed text-ink-muted">
          OpenChip sends nothing. Your description goes only to the assistant you open, under its
          own terms.
        </p>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <section className="grid grid-cols-[1.5rem_1fr] gap-3">
      <span
        aria-hidden
        className="grid h-[22px] w-[22px] place-items-center rounded-full bg-accent-wash font-mono text-[11px] font-semibold text-accent"
      >
        {number}
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        {children}
      </div>
    </section>
  );
}

function SubSteps({ children, start = 1 }: { children: ReactNode; start?: number }) {
  return (
    <ol
      start={start}
      className="flex list-decimal flex-col gap-2 pl-5 text-[13px] text-ink marker:text-ink-faint"
    >
      {children}
    </ol>
  );
}

function SubStep({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <li className="pl-0.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">{children}</span>
        {action ? <span className="flex shrink-0 gap-1.5">{action}</span> : null}
      </div>
    </li>
  );
}

/** A button that copies text and briefly says so. */
function CopyButton({
  text,
  label,
  variant = 'secondary',
}: {
  text: string;
  label: string;
  variant?: 'primary' | 'secondary';
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant={variant}
      icon={copied ? <Check size={13} /> : <Copy size={13} />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Couldn't copy to the clipboard", {
            description: 'Your browser blocked it. Select the text and copy it by hand.',
          });
        }
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

function ClaudeRoute({ prompt }: { prompt: string }) {
  const [building, setBuilding] = useState(false);

  const downloadSkill = async () => {
    setBuilding(true);
    try {
      downloadBlob(await buildSkillZip(), 'openchip-design.zip', 'application/zip');
    } finally {
      setBuilding(false);
    }
  };

  return (
    <SubSteps>
      <SubStep
        action={
          <Button
            size="sm"
            icon={<Download size={13} />}
            disabled={building}
            onClick={() => void downloadSkill()}
          >
            Download skill (.zip)
          </Button>
        }
      >
        Add the OpenChip skill to Claude — once.
      </SubStep>
      <SubStep>
        <span className="text-ink-muted">
          In Claude, upload it under <b className="font-semibold">Settings → Skills</b>.
        </span>
      </SubStep>
      <SubStep
        action={
          <>
            <CopyButton text={prompt} label="Copy prompt" />
            <a
              href={claudeUrl(prompt)}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'oc-pressable inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium',
                'border border-transparent bg-accent text-accent-ink hover:bg-accent-hover',
              )}
            >
              Open in Claude <ExternalLink size={13} />
            </a>
          </>
        }
      >
        Open Claude with your description filled in.
      </SubStep>
    </SubSteps>
  );
}

function AgentRoute({ prompt }: { prompt: string }) {
  return (
    <>
      <p className="text-[12px] text-ink-muted">
        Claude Code, Codex, Cursor, Gemini CLI, or any agent that supports skills.
      </p>
      <SubSteps>
        <SubStep>Install the skill — once, in a terminal.</SubStep>
      </SubSteps>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-sunken py-1.5 pl-3 pr-1.5">
        <code className="min-w-0 truncate font-mono text-[12.5px] text-ink">
          {SKILL_INSTALL_COMMAND}
        </code>
        <CopyButton text={SKILL_INSTALL_COMMAND} label="Copy" />
      </div>
      <SubSteps start={2}>
        <SubStep action={<CopyButton text={prompt} label="Copy prompt" variant="primary" />}>
          Paste your description into the agent.
        </SubStep>
        <SubStep>
          <span className="text-ink-muted">
            The agent writes a <code className="font-mono text-[12px]">.openchip</code> file —
            drop it into step 3.
          </span>
        </SubStep>
      </SubSteps>
    </>
  );
}

function DropZone({ onFile, onPick }: { onFile: (file: File) => void; onPick: () => void }) {
  const [over, setOver] = useState(false);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'flex flex-col items-center gap-0.5 rounded-xl border-[1.5px] border-dashed px-4 py-5 text-center',
        'transition-[border-color,background-color] duration-150',
        over ? 'border-accent bg-accent-wash' : 'border-line-strong bg-panel',
      )}
    >
      <p className="text-[13px] font-semibold text-ink">Drop the .openchip file here</p>
      <p className="text-[12px] text-ink-muted">
        or{' '}
        <button type="button" onClick={onPick} className="text-accent underline underline-offset-2">
          choose a file…
        </button>{' '}
        It opens as a new project.
      </p>
    </div>
  );
}
