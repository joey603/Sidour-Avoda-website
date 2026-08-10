"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useIntentionalPress } from "./use-intentional-press";
import { ModalOverlay } from "@/components/ui/modal-scroll-lock";

interface NumberPickerProps {
  value: number;
  onChange: (value: number) => void;
  className?: string;
  min?: number;
  max?: number;
  /** Pas entre options (ex. 0.5, 0.25). Défaut 1. */
  step?: number;
  /**
   * list = sélection dans une liste (défaut)
   * type = l’utilisateur saisit le nombre dans un champ
   */
  mode?: "list" | "type";
  /** Si défini, la liste du popup ne contient que ces valeurs (ex. alternatives générées). */
  allowedOptions?: number[];
  disabled?: boolean;
  placeholder?: string;
  inputAriaLabel?: string;
  title?: string;
  /** Titre du popup (sinon « בחר מספר » / « הזן מספר » selon mode). */
  popupTitle?: string;
}

function stepDecimals(step: number): number {
  const s = String(step);
  if (!s.includes(".")) return 0;
  return s.split(".")[1]?.length || 0;
}

function roundToStep(n: number, step: number): number {
  const d = stepDecimals(step);
  const s = step > 0 ? step : 1;
  const rounded = Math.round(n / s) * s;
  return Number(rounded.toFixed(d));
}

function normalizeDiscrete(opts: number[], step: number): number[] {
  const d = stepDecimals(step);
  return [
    ...new Set(
      opts
        .filter((n) => Number.isFinite(n))
        .map((n) => Number(n.toFixed(Math.max(d, 0)))),
    ),
  ].sort((a, b) => a - b);
}

function buildSteppedOptions(min: number, max: number, step: number): number[] {
  const s = step > 0 ? step : 1;
  const d = stepDecimals(s);
  const out: number[] = [];
  const start = Number(min.toFixed(d));
  const end = Number(max.toFixed(d));
  for (let v = start; v <= end + s / 1000; v = Number((v + s).toFixed(d))) {
    out.push(v);
    if (out.length > 2000) break;
  }
  return out;
}

/** Champ + overlay (portail body) + liste + ביטול / שמור — même UX desktop / mobile. */
export default function NumberPicker({
  value,
  onChange,
  className = "",
  min = 0,
  max = 100,
  step = 1,
  mode = "list",
  allowedOptions,
  disabled = false,
  placeholder = "0",
  inputAriaLabel,
  title,
  popupTitle,
}: NumberPickerProps) {
  const [showPopup, setShowPopup] = useState(false);
  const [selectedValue, setSelectedValue] = useState(
    Number.isFinite(value) ? String(value) : "",
  );
  const popupRef = useRef<HTMLDivElement>(null);
  const typeInputRef = useRef<HTMLInputElement>(null);
  const openedAtRef = useRef<number>(0);
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
  const isTypeMode = mode === "type";

  const discrete = useMemo(() => {
    if (!Array.isArray(allowedOptions) || allowedOptions.length === 0) return null;
    const n = normalizeDiscrete(allowedOptions, step);
    return n.length > 0 ? n : null;
  }, [allowedOptions, step]);

  const optionsList = useMemo(() => {
    if (discrete) return discrete;
    const base = buildSteppedOptions(min, max, step);
    if (Number.isFinite(value) && !base.includes(roundToStep(value, step))) {
      return normalizeDiscrete([...base, value], step);
    }
    return base;
  }, [discrete, min, max, step, value]);

  useEffect(() => {
    setPortalEl(typeof document !== "undefined" ? document.body : null);
  }, []);

  useEffect(() => {
    setSelectedValue(Number.isFinite(value) ? String(value) : "");
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

  const snapToAllowed = useCallback(
    (numValue: number): number => {
      if (discrete && discrete.length > 0) {
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
      }
      const clamped = Math.max(min, Math.min(max, numValue));
      if (isTypeMode) {
        const d = stepDecimals(step > 0 ? step : 0.01);
        return Number(clamped.toFixed(Math.max(d, 2)));
      }
      return roundToStep(clamped, step);
    },
    [discrete, min, max, isTypeMode, step],
  );

  const handleSave = () => {
    const normalized = String(selectedValue || "").trim().replace(",", ".");
    const numValue = Number(normalized);
    if (!isNaN(numValue) && Number.isFinite(numValue)) {
      onChange(snapToAllowed(numValue));
      setShowPopup(false);
    }
  };

  const handleOpen = useCallback(() => {
    if (disabled) return;
    openedAtRef.current = Date.now();
    setShowPopup(true);
    const v = Number(value);
    if (isTypeMode) {
      setSelectedValue(Number.isFinite(v) && v > 0 ? String(v) : "");
      return;
    }
    if (discrete && discrete.length > 0) {
      setSelectedValue(String(discrete.includes(v) ? v : discrete[0]));
    } else if (Number.isFinite(v)) {
      setSelectedValue(String(snapToAllowed(v)));
    } else {
      setSelectedValue(String(min));
    }
  }, [disabled, value, isTypeMode, discrete, min, snapToAllowed]);

  const press = useIntentionalPress(handleOpen, disabled);

  useEffect(() => {
    if (!showPopup || !isTypeMode) return;
    const t = window.setTimeout(() => {
      typeInputRef.current?.focus();
      typeInputRef.current?.select();
    }, 50);
    return () => window.clearTimeout(t);
  }, [showPopup, isTypeMode]);

  const selectSize = Math.min(12, Math.max(3, optionsList.length));
  const displayValue = Number.isFinite(value) ? String(value) : "";

  return (
    <>
      <input
        type="text"
        value={displayValue}
        readOnly
        disabled={disabled}
        aria-label={inputAriaLabel}
        title={title}
        {...press}
        className={`${className} min-h-10 cursor-pointer touch-manipulation`}
        inputMode="none"
        placeholder={placeholder}
      />
      {showPopup &&
        portalEl &&
        createPortal(
          <ModalOverlay
            className="z-[11000] flex min-h-[100dvh] items-center justify-center bg-black/50 p-4"
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
                <h3 className="text-lg font-semibold">
                  {popupTitle || (isTypeMode ? "הזן מספר" : "בחר מספר")}
                </h3>
              </div>
              <div className="p-4">
                {isTypeMode ? (
                  <div className="flex flex-col items-center gap-2" dir="rtl">
                    <input
                      ref={typeInputRef}
                      type="text"
                      inputMode="decimal"
                      value={selectedValue}
                      onChange={(e) => {
                        const raw = e.target.value.replace(/[^\d.,]/g, "");
                        setSelectedValue(raw);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleSave();
                        }
                      }}
                      placeholder={placeholder}
                      className="w-full max-w-[12rem] rounded-md border border-zinc-300 bg-white px-3 py-3 text-center text-2xl tabular-nums focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                      aria-label={inputAriaLabel || "הזן מספר"}
                    />
                    <p className="text-xs text-zinc-500">הקלד את הסכום הרצוי ואשר ב־שמור</p>
                  </div>
                ) : (
                  <div className="flex items-center justify-center">
                    <select
                      value={selectedValue}
                      onChange={(e) => setSelectedValue(e.target.value)}
                      className="max-h-64 min-h-[8rem] w-full max-w-[10rem] rounded-md border border-zinc-300 bg-white px-3 py-2 text-center text-lg focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 sm:w-32"
                      size={selectSize}
                    >
                      {optionsList.map((opt) => (
                        <option key={String(opt)} value={String(opt)}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
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
          </ModalOverlay>,
          portalEl,
        )}
    </>
  );
}
