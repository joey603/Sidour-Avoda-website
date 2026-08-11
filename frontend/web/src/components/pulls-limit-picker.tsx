"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  EMPTY_PULLS_SHIFT_PREFS,
  type PullsShiftKind,
  type PullsShiftPrefs,
} from "@/components/planning-v2/lib/planning-v2-pulls-match";

const PULLS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "ללא" },
  ...Array.from({ length: 10 }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  })),
  { value: "unlimited", label: "מקסימום" },
];

function labelForValue(v: string): string {
  return PULLS_OPTIONS.find((o) => o.value === v)?.label ?? "ללא";
}

const PREFER_OPTIONS: { kind: PullsShiftKind; label: string }[] = [
  { kind: "morning", label: "בוקר" },
  { kind: "noon", label: "צהריים" },
  { kind: "night", label: "לילה" },
];

interface PullsLimitPickerProps {
  value: string;
  onChange: (value: string) => void;
  prefer?: PullsShiftPrefs;
  onPreferChange?: (prefer: PullsShiftPrefs) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}

/** Toutes tailles d’écran : champ + overlay (portail body) + liste haute + ביטול / שמור. */
export default function PullsLimitPicker({
  value,
  onChange,
  prefer = EMPTY_PULLS_SHIFT_PREFS,
  onPreferChange,
  disabled = false,
  className = "",
  title = "מגבלת משיכות",
}: PullsLimitPickerProps) {
  const [showPopup, setShowPopup] = useState(false);
  const [selectedValue, setSelectedValue] = useState(value);
  const [selectedPrefer, setSelectedPrefer] = useState<PullsShiftPrefs>(prefer);
  const popupRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef<number>(0);
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalEl(typeof document !== "undefined" ? document.body : null);
  }, []);

  useEffect(() => {
    setSelectedValue(value);
  }, [value]);

  useEffect(() => {
    setSelectedPrefer(prefer);
  }, [prefer]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (Date.now() - openedAtRef.current < 400) return;
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
        setShowPopup(false);
      }
    };
    if (showPopup) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showPopup]);

  const handleSave = () => {
    onChange(selectedValue);
    onPreferChange?.(selectedPrefer);
    setShowPopup(false);
  };

  const openPopup = () => {
    if (disabled) return;
    openedAtRef.current = Date.now();
    setShowPopup(true);
    setSelectedValue(value);
    setSelectedPrefer(prefer);
  };

  const togglePrefer = (kind: PullsShiftKind) => {
    setSelectedPrefer((prev) => ({ ...prev, [kind]: !prev[kind] }));
  };

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          if (disabled) return;
          e.preventDefault();
          e.stopPropagation();
          openPopup();
        }}
        disabled={disabled}
        data-pulls-picker-trigger="1"
        className={`${className} inline-flex items-center justify-center gap-1 cursor-pointer`}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={showPopup}
      >
        <span>{labelForValue(value)}</span>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden>
          <path d="M12 7 19 17H5l7-10Z" />
        </svg>
      </button>
      {showPopup &&
        portalEl &&
        createPortal(
          <div
            className="fixed inset-0 z-[11000] flex min-h-[100dvh] items-center justify-center bg-black/50 p-4"
            onClick={(e) => {
              if (Date.now() - openedAtRef.current < 400) return;
              if (e.target === e.currentTarget) setShowPopup(false);
            }}
          >
            <div
              ref={popupRef}
              className="relative mx-auto w-full max-w-sm shrink-0 rounded-xl border bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
              onClick={(e) => e.stopPropagation()}
              dir="rtl"
            >
              <div className="border-b px-4 py-3 dark:border-zinc-800">
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">משיכות</h3>
              </div>
              <div className="px-4 pb-3 pt-2">
                <div className="mb-3">
                  <div className="mb-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">העדפת משיכות</div>
                  <div className="mb-2 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                    רק מיקום המשיכות — לא שיבוץ המשמרות. אם לא נבחר כלום: שילוב.
                  </div>
                  <div className="flex gap-1">
                    {PREFER_OPTIONS.map((o) => {
                      const isOn = selectedPrefer[o.kind];
                      return (
                        <button
                          key={o.kind}
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            togglePrefer(o.kind);
                          }}
                          className={
                            "flex-1 touch-manipulation rounded-md border px-2 py-2 text-center text-sm font-medium transition-colors " +
                            (isOn
                              ? "border-orange-500 bg-orange-50 text-orange-800 dark:border-orange-400 dark:bg-orange-950/40 dark:text-orange-200"
                              : "border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700")
                          }
                          aria-pressed={isOn}
                        >
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="mb-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">כמות</div>
                <div className="mx-auto flex w-full max-w-[11rem] flex-col gap-1">
                  {PULLS_OPTIONS.map((o) => {
                    const isSelected = selectedValue === o.value;
                    return (
                      <button
                        key={o.value === "" ? "empty" : o.value}
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedValue(o.value);
                        }}
                        className={
                          "touch-manipulation rounded-md border px-3 py-2 text-center text-sm font-medium transition-colors " +
                          (isSelected
                            ? "border-[#00A8E0] bg-sky-50 text-[#0077a3] dark:border-sky-500 dark:bg-sky-950/40 dark:text-sky-300"
                            : "border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700")
                        }
                        aria-pressed={isSelected}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 border-t px-4 py-3 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowPopup(false);
                  }}
                  className="touch-manipulation rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  ביטול
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleSave();
                  }}
                  className="touch-manipulation rounded-md bg-[#00A8E0] px-4 py-2 text-sm font-medium text-white hover:bg-[#0090C0]"
                >
                  שמור
                </button>
              </div>
            </div>
          </div>,
          portalEl,
        )}
    </>
  );
}
