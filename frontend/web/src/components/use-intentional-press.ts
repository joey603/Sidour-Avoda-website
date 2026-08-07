"use client";

import { useCallback, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

const MOVE_CANCEL_PX = 12;

type PressStart = { x: number; y: number; pointerId: number };

/**
 * Ouvre un contrôle seulement sur un vrai tap/clic — pas pendant un scroll.
 * Ne pas appeler preventDefault sur pointerdown (sinon le scroll est bloqué).
 */
export function useIntentionalPress(onPress: () => void, disabled = false) {
  const startRef = useRef<PressStart | null>(null);
  const openedByPointerRef = useRef(false);

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      if (disabled) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      openedByPointerRef.current = false;
      startRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    },
    [disabled],
  );

  const onPointerMove = useCallback((e: PointerEvent) => {
    const s = startRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_CANCEL_PX) {
      startRef.current = null;
    }
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const s = startRef.current;
      startRef.current = null;
      if (disabled || !s || s.pointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_CANCEL_PX) return;
      openedByPointerRef.current = true;
      onPress();
    },
    [disabled, onPress],
  );

  const onPointerCancel = useCallback(() => {
    startRef.current = null;
  }, []);

  /** Ignore le click synthétique après un pointerup déjà traité. */
  const onClick = useCallback(
    (e: MouseEvent) => {
      if (disabled) return;
      if (openedByPointerRef.current) {
        openedByPointerRef.current = false;
        e.preventDefault();
        return;
      }
      onPress();
    },
    [disabled, onPress],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onPress();
      }
    },
    [disabled, onPress],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick, onKeyDown };
}
