"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface TimePickerProps {
  value: string; // Format HH:MM
  onChange: (value: string) => void;
  className?: string;
  dir?: "ltr" | "rtl";
  disabled?: boolean;
}

/** Toutes tailles d’écran : champ + overlay (portail body) + listes heure/minute + ביטול / שמור. */
export default function TimePicker({ value, onChange, className = "", dir = "ltr", disabled = false }: TimePickerProps) {
  const [showPopup, setShowPopup] = useState(false);
  const [selectedHour, setSelectedHour] = useState("00");
  const [selectedMinute, setSelectedMinute] = useState("00");
  const popupRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef<number>(0);
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalEl(typeof document !== "undefined" ? document.body : null);
  }, []);

  useEffect(() => {
    if (value) {
      const [hour, minute] = value.split(":");
      if (hour && minute) {
        setSelectedHour(hour);
        setSelectedMinute(minute);
      }
    }
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
    const newValue = `${selectedHour.padStart(2, "0")}:${selectedMinute.padStart(2, "0")}`;
    onChange(newValue);
    setShowPopup(false);
  };

  const openPopup = () => {
    if (disabled) return;
    openedAtRef.current = Date.now();
    if (value) {
      const [hour, minute] = value.split(":");
      if (hour && minute) {
        setSelectedHour(hour);
        setSelectedMinute(minute);
      }
    }
    setShowPopup(true);
  };

  const hours = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, "0"));
  const minutes = Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, "0"));

  return (
    <>
      <input
        type="text"
        value={value || ""}
        onPointerDown={(e) => {
          if (disabled) return;
          e.preventDefault();
          e.stopPropagation();
          openPopup();
        }}
        readOnly
        disabled={disabled}
        className={`${className} cursor-pointer`}
        dir={dir}
        inputMode="none"
        placeholder="HH:MM"
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
              dir="ltr"
            >
              <div className="border-b px-4 py-3 dark:border-zinc-800">
                <h3 className="text-lg font-semibold">בחר שעה</h3>
              </div>
              <div className="p-4">
                <div className="flex items-center justify-center gap-4">
                  <div className="flex flex-col items-center">
                    <label className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">שעה</label>
                    <select
                      value={selectedHour}
                      onChange={(e) => setSelectedHour(e.target.value)}
                      className="h-32 w-20 rounded-md border border-zinc-300 bg-white px-2 text-center text-lg focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                      size={8}
                    >
                      {hours.map((hour) => (
                        <option key={hour} value={hour}>
                          {hour}
                        </option>
                      ))}
                    </select>
                  </div>
                  <span className="text-2xl font-bold">:</span>
                  <div className="flex flex-col items-center">
                    <label className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">דקה</label>
                    <select
                      value={selectedMinute}
                      onChange={(e) => setSelectedMinute(e.target.value)}
                      className="h-32 w-20 rounded-md border border-zinc-300 bg-white px-2 text-center text-lg focus:outline-none focus:ring-2 focus:ring-[#00A8E0] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                      size={8}
                    >
                      {minutes.map((minute) => (
                        <option key={minute} value={minute}>
                          {minute}
                        </option>
                      ))}
                    </select>
                  </div>
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
