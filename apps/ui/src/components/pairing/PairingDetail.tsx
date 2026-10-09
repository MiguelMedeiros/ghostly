import { useId, useState } from "react";
import { InfoButton } from "../layout/Section";

/**
 * The engine's detail of a pairing (lib/pairingProgress.ts `pairingDetail`) behind an ⓘ, after the words it explains:
 * its English only once asked for, the way a notice's details are (components/ui/Notice.tsx).
 */
export function PairingDetail({ detail, testId, className = "" }: { detail?: string; testId: string; className?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!detail) return null;
  return <>
    <span className="ms-1 inline-block align-middle"><InfoButton open={open} onToggle={() => setOpen(!open)} controls={id} testId={`${testId}-info`} /></span>
    {open && <p id={id} dir="ltr" lang="en" data-testid={testId} className={`break-words font-mono text-[11px] leading-4 ${className}`}>{detail}</p>}
  </>;
}
