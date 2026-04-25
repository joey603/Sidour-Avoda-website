"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface NumberPickerProps {
  value: number;
  onChange: (value: number) => void;
  className?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  placeholder?: string;
}

/** Toutes tailles d’écran : champ + overlay (portail body) + liste haute + ביטול / שמור. */
export default function NumberPicker({
  value,
  onChange,
  className = "",
  min = 0,
  max = 100,
  disabled = false,
  placeholder = "0",
}: NumberPickerProps) {
  const [showPopup, setShowPopup] = useState(false);
  const [selectedValue, setSelectedValue] = useState(value.toString());
  const popupRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef<number>(0);
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);

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

  const handleSave = () => {
    const numValue = parseInt(selectedValue, 10);
    if (!isNaN(numValue)) {
      const clampedValue = Math.max(min, Math.min(max, numValue));
      onChange(clampedValue);
      setShowPopup(false);
    }
  };

  const handleOpen = () => {
    if (disabled) return;
    openedAtRef.current = Date.now();
    setShowPopup(true);
    setSelectedValue(value.toString());
  };

  const options = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  return (
    <>
      <input
        type="text"
        value={value || ""}
        readOnly
        disabled={disabled}
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
        className={`!text-base ${className} min-h-10 cursor-pointer touch-manipulation`}
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
                    className="h-64 w-32 rounded-md border border-zinc-300 bg-white px-3 text-center text-lg focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    size={Math.min(12, options.length)}
                  >
                    {options.map((opt) => (
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
