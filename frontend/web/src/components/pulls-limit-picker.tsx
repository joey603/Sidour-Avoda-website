"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

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

interface PullsLimitPickerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}

/** Toutes tailles d’écran : champ + overlay (portail body) + liste haute + ביטול / שמור. */
export default function PullsLimitPicker({
  value,
  onChange,
  disabled = false,
  className = "",
  title = "מגבלת משיכות",
}: PullsLimitPickerProps) {
  const [showPopup, setShowPopup] = useState(false);
  const [selectedValue, setSelectedValue] = useState(value);
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
    setShowPopup(false);
  };

  const openPopup = () => {
    if (disabled) return;
    openedAtRef.current = Date.now();
    setShowPopup(true);
    setSelectedValue(value);
  };

  const listSize = PULLS_OPTIONS.length;

  return (
    <>
      <input
        type="text"
        value={labelForValue(value)}
        onPointerDown={(e) => {
          if (disabled) return;
          e.preventDefault();
          e.stopPropagation();
          openPopup();
        }}
        readOnly
        disabled={disabled}
        className={`${className} cursor-pointer`}
        inputMode="none"
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={showPopup}
      />
      {showPopup &&
        portalEl &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex min-h-[100dvh] items-center justify-center bg-black/50 p-4"
            onPointerDown={(e) => {
              e.preventDefault();
              if (Date.now() - openedAtRef.current < 400) return;
              setShowPopup(false);
            }}
          >
            <div
              ref={popupRef}
              className="relative mx-auto w-full max-w-sm shrink-0 rounded-xl border bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
              onPointerDown={(e) => e.stopPropagation()}
              dir="rtl"
            >
              <div className="border-b px-4 py-3 dark:border-zinc-800">
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">משיכות</h3>
              </div>
              <div className="px-4 pb-3 pt-2">
                <div className="flex items-center justify-center">
                  <select
                    value={selectedValue}
                    onChange={(e) => setSelectedValue(e.target.value)}
                    className="box-border w-full max-w-[11rem] rounded-md border border-zinc-300 bg-white px-2 py-0 text-center text-sm leading-6 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    style={{ height: `${listSize}lh`, maxHeight: `${listSize}lh` }}
                    size={listSize}
                  >
                    {PULLS_OPTIONS.map((o) => (
                      <option key={o.value === "" ? "empty" : o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 border-t px-4 py-3 dark:border-zinc-800">
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowPopup(false);
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowPopup(false);
                  }}
                  className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  ביטול
                </button>
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleSave();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleSave();
                  }}
                  className="rounded-md bg-[#00A8E0] px-4 py-2 text-sm font-medium text-white hover:bg-[#0090C0]"
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
