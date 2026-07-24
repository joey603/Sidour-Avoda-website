"use client";

import { cn } from "@/lib/utils";

type FormSwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
};

/** Toggle compact (h-5 w-9), aligné sur les switches directeur / sites. */
export default function FormSwitch({
  checked,
  onCheckedChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: FormSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onCheckedChange(!checked);
      }}
      className={cn(
        "flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00A8E0]/80 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-900",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        checked ? "justify-end bg-[#00A8E0]" : "justify-start bg-zinc-300 dark:bg-zinc-600",
        className,
      )}
    >
      <span
        className="pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm ring-1 ring-black/5 dark:ring-white/10"
        aria-hidden
      />
    </button>
  );
}
