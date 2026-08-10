"use client";

import { useEffect, useState } from "react";

/** Overlay plein écran « תצוגת מסך מלא » : reveal, Escape, lock scroll body. */
export function usePlanningV2FullscreenViz() {
  const [visualizationOpen, setVisualizationOpen] = useState(false);
  const [fullscreenReveal, setFullscreenReveal] = useState(false);

  useEffect(() => {
    if (!visualizationOpen) {
      setFullscreenReveal(false);
      return;
    }
    const id = requestAnimationFrame(() => setFullscreenReveal(true));
    const prevOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setVisualizationOpen(false);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(id);
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [visualizationOpen]);

  return {
    visualizationOpen,
    setVisualizationOpen,
    fullscreenReveal,
  };
}
