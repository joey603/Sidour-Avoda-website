"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";

interface NumberPickerProps {
  value: number;
  onChange: (value: number) => void;
  className?: string;
  min?: number;
  max?: number;
  /** Si défini, la liste du popup ne contient que ces valeurs (ex. alternatives générées). */
  allowedOptions?: number[];
  disabled?: boolean;
  placeholder?: string;
  inputAriaLabel?: string;
  title?: string;
}

function normalizeDiscrete(opts: number[]): number[] {
  return [...new Set(opts.filter((n) => Number.isFinite(n)).map((n) => Math.round(n)))].sort((a, b) => a - b);
}

/** Champ + overlay (portail body) + liste + ביטול / שמור — même UX desktop / mobile. */
export default function NumberPicker({
  value,
  onChange,
  className = "",
  min = 0,
  max = 100,
  allowedOptions,
  disabled = false,
  placeholder = "0",
  inputAriaLabel,
  title,
}: NumberPickerProps) {
  const [showPopup, setShowPopup] = useState(false);
  const [selectedValue, setSelectedValue] = useState(value.toString());
  const popupRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef<number>(0);
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);

  const discrete = useMemo(() => {
    if (!Array.isArray(allowedOptions) || allowedOptions.length === 0) return null;
    const n = normalizeDiscrete(allowedOptions);
    return n.length > 0 ? n : null;
  }, [allowedOptions]);

  const optionsList = useMemo(() => {
    if (discrete) return discrete;
    return Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i);
  }, [discrete, min, max]);

  useEffect(() => {
    setPortalEl(typeof document !== "undefined" ? document.body : null);
  }, []);

  useEffect(() => {
    setSelectedValue(value.toString());
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

  const snapToAllowed = (numValue: number): number => {
    if (!discrete || discrete.length === 0) {
      return Math.max(min, Math.min(max, numValue));
    }
    if (discrete.includes(numValue)) return numValue;
    let best = discrete[0];
    let bestDist = Math.abs(best - numValue);
    for (const x of discrete) {
      const d = Math.abs(x - numValue);
      if (d < bestDist || (d === bestDist && x < best)) {
        best = x;
        bestDist = d;
      }
    }
    return best;
  };

  const handleSave = () => {
    const numValue = parseInt(selectedValue, 10);
    if (!isNaN(numValue)) {
      onChange(snapToAllowed(numValue));
      setShowPopup(false);
    }
  };

  const handleOpen = () => {
    if (disabled) return;
    openedAtRef.current = Date.now();
    setShowPopup(true);
    const v = Number(value);
    if (discrete && discrete.length > 0) {
      setSelectedValue(String(discrete.includes(v) ? v : discrete[0]));
    } else {
      setSelectedValue(value.toString());
    }
  };

  const selectSize = Math.min(12, Math.max(3, optionsList.length));

  return (
    <>
      <input
        type="text"
        value={Number.isFinite(value) ? String(value) : ""}
        readOnly
        disabled={disabled}
        aria-label={inputAriaLabel}
        title={title}
        onClick={() => {
          if (disabled) return;
          handleOpen();
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleOpen();
          }
        }}
        className={`${className} min-h-10 cursor-pointer touch-manipulation`}
        inputMode="none"
        placeholder={placeholder}
      />
      {showPopup &&
        portalEl &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex min-h-[100dvh] items-center justify-center bg-black/50 p-4"
            onClick={(e) => {
              if (Date.now() - openedAtRef.current < 400) return;
              if (e.target === e.currentTarget) setShowPopup(false);
            }}
          >
            <div
              ref={popupRef}
              className="relative mx-auto w-full max-w-sm shrink-0 rounded-xl border bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
              onClick={(e) => e.stopPropagation()}
              dir="ltr"
            >
              <div className="border-b px-4 py-3 dark:border-zinc-800">
                <h3 className="text-lg font-semibold">בחר מספר</h3>
              </div>
              <div className="p-4">
                <div className="flex items-center justify-center">
                  <select
                    value={selectedValue}
                    onChange={(e) => setSelectedValue(e.target.value)}
                    className="max-h-64 min-h-[8rem] w-full max-w-[10rem] rounded-md border border-zinc-300 bg-white px-3 py-2 text-center text-lg focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 sm:w-32"
                    size={selectSize}
                  >
                    {optionsList.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
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
