"use client";

import { useState, useEffect, useRef } from "react";

interface NumberPickerProps {
  value: number;
  onChange: (value: number) => void;
  className?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  placeholder?: string;
}

export default function NumberPicker({ 
  value, 
  onChange, 
  className = "", 
  min = 0, 
  max = 100, 
  disabled = false,
  placeholder = "0"
}: NumberPickerProps) {
  const computeIsTouchUi = () => {
    if (typeof window === "undefined") return false;
    const isTouchDevice =
      "ontouchstart" in window ||
      (typeof navigator !== "undefined" && (navigator.maxTouchPoints || 0) > 0) ||
      (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);
    const isSmallScreen = window.innerWidth < 768;
    return isTouchDevice || isSmallScreen;
  };

  const [isMobile, setIsMobile] = useState<boolean>(() => computeIsTouchUi());
  const [showPopup, setShowPopup] = useState(false);
  const [selectedValue, setSelectedValue] = useState(value.toString());
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

  // Initialiser la valeur depuis le prop value
  useEffect(() => {
    setSelectedValue(value.toString());
  }, [value]);

  // Fermer la popup si on clique en dehors
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

  const handleInputClick = () => {
    if (isMobile && !disabled) {
      openedAtRef.current = Date.now();
      setShowPopup(true);
      setSelectedValue(value.toString());
    }
  };

  // Générer les options pour le sélecteur (de min à max)
  const options = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  // Sur desktop, utiliser l'input number natif
  if (!isMobile) {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const numValue = parseInt(e.target.value, 10);
          if (!isNaN(numValue)) {
            onChange(Math.max(min, Math.min(max, numValue)));
          }
        }}
        className={className}
        min={min}
        max={max}
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
        onPointerDown={(e) => {
          if (disabled) return;
          e.preventDefault();
          e.stopPropagation();
          handleInputClick();
        }}
        readOnly
        disabled={disabled}
        className={`${className} cursor-pointer`}
        inputMode="none"
        placeholder={placeholder}
      />
      {showPopup && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          onPointerDown={(e) => {
            e.preventDefault();
            if (Date.now() - openedAtRef.current < 400) return;
            setShowPopup(false);
          }}
        >
          <div
            ref={popupRef}
            className="w-full max-w-sm rounded-xl border bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900 z-[101]"
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
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
