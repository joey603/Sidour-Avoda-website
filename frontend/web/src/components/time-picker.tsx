"use client";

import { useState, useEffect, useRef } from "react";

interface TimePickerProps {
  value: string; // Format HH:MM
  onChange: (value: string) => void;
  className?: string;
  dir?: "ltr" | "rtl";
  disabled?: boolean;
}

export default function TimePicker({ value, onChange, className = "", dir = "ltr", disabled = false }: TimePickerProps) {
  const computeIsTouchUi = () => {
    if (typeof window === "undefined") return false;
    const isTouchDevice =
      "ontouchstart" in window ||
      (typeof navigator !== "undefined" && (navigator.maxTouchPoints || 0) > 0) ||
      (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);
    const isSmallScreen = window.innerWidth < 768;
    return isTouchDevice || isSmallScreen;
  };

  // IMPORTANT: init à partir de window pour éviter le 1er rendu en <input type="time"> sur mobile
  const [isMobile, setIsMobile] = useState<boolean>(() => computeIsTouchUi());
  const [showPopup, setShowPopup] = useState(false);
  const [selectedHour, setSelectedHour] = useState("00");
  const [selectedMinute, setSelectedMinute] = useState("00");
  const popupRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef<number>(0);

  // Détecter si c'est un écran tactile
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(computeIsTouchUi());
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Initialiser les valeurs depuis le prop value
  useEffect(() => {
    if (value) {
      const [hour, minute] = value.split(":");
      if (hour && minute) {
        setSelectedHour(hour);
        setSelectedMinute(minute);
      }
    }
  }, [value]);

  // Fermer la popup si on clique en dehors
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // Eviter fermeture immédiate sur mobile (tap -> open -> click sur overlay)
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
    if (isMobile && !disabled) {
      openedAtRef.current = Date.now();
      setShowPopup(true);
    }
  };

  // Générer les options pour les heures (00-23)
  const hours = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, "0"));
  // Générer les options pour les minutes (00-59)
  const minutes = Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, "0"));

  // Sur desktop, utiliser l'input time natif
  if (!isMobile) {
    return (
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className}
        dir={dir}
        disabled={disabled}
      />
    );
  }

  // Sur mobile, afficher un input avec popup
  return (
    <>
      <input
        type="text"
        value={value || ""}
        // Pointer events: plus fiable sur iOS/Android que click/touch séparés
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
      {showPopup && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          onPointerDown={(e) => {
            // fermer si on tape sur l'overlay
            e.preventDefault();
            // Eviter fermeture immédiate sur mobile (tap -> open -> overlay)
            if (Date.now() - openedAtRef.current < 400) return;
            setShowPopup(false);
          }}
        >
          <div
            ref={popupRef}
            className="w-full max-w-sm rounded-xl border bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900 z-[101]"
            onPointerDown={(e) => {
              // empêcher la propagation vers l'overlay (et la popup משיכות derrière)
              e.stopPropagation();
            }}
            dir="ltr"
          >
            <div className="border-b px-4 py-3 dark:border-zinc-800">
              <h3 className="text-lg font-semibold">בחר שעה</h3>
            </div>
            <div className="p-4">
              <div className="flex items-center justify-center gap-4">
                {/* Sélecteur d'heures */}
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
                {/* Sélecteur de minutes */}
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
        </div>
      )}
    </>
  );
}
