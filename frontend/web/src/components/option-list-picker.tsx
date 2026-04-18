"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface OptionListItem {
  value: string;
  label: string;
  description?: string;
}

interface OptionListPickerProps {
  options: OptionListItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  popupTitle?: string;
  /** Texte affiché quand aucune option ne correspond (ne devrait pas arriver) */
  placeholder?: string;
}

/** Champ lecture seule + overlay (portail) + liste + ביטול / שמור — même UX que TimePicker / NumberPicker. */
export default function OptionListPicker({
  options,
  value,
  onChange,
  className = "",
  disabled = false,
  popupTitle = "בחר",
  placeholder = "—",
}: OptionListPickerProps) {
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

  const displayLabel = options.find((o) => o.value === value)?.label ?? placeholder;

  const handleSave = () => {
    onChange(selectedValue);
    setShowPopup(false);
  };

  const openPopup = () => {
    if (disabled) return;
    openedAtRef.current = Date.now();
    setSelectedValue(value);
    setShowPopup(true);
  };

  return (
    <>
      <input
        type="text"
        value={displayLabel}
        readOnly
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          openPopup();
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPopup();
          }
        }}
        className={`${className} cursor-pointer touch-manipulation`}
        inputMode="none"
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
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{popupTitle}</h3>
              </div>
              <div className="max-h-[min(70dvh,28rem)] overflow-y-auto px-4 py-3">
                <div className="mx-auto flex w-full flex-col gap-1.5">
                  {options.map((o) => {
                    const isSelected = selectedValue === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedValue(o.value);
                        }}
                        className={
                          "rounded-md border px-3 py-2.5 text-right text-sm font-medium transition-colors " +
                          (isSelected
                            ? "border-[#00A8E0] bg-sky-50 text-[#0077a3] dark:border-sky-500 dark:bg-sky-950/40 dark:text-sky-300"
                            : "border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700")
                        }
                        aria-pressed={isSelected}
                      >
                        <div>{o.label}</div>
                        {o.description ? (
                          <div className="mt-1 text-xs font-normal text-zinc-500 dark:text-zinc-400">{o.description}</div>
                        ) : null}
                      </button>
                    );
                  })}
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
