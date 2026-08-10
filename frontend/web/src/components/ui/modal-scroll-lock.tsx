"use client";

import {
  useEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/** Compteur global : plusieurs modales empilées gardent le body bloqué jusqu’à la dernière. */
let bodyLockCount = 0;
let savedBodyOverflow = "";
let savedHtmlOverflow = "";
let savedBodyPaddingRight = "";

function acquireBodyScrollLock() {
  if (typeof document === "undefined") return;
  if (bodyLockCount === 0) {
    const scrollbarGap = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    savedBodyOverflow = document.body.style.overflow;
    savedHtmlOverflow = document.documentElement.style.overflow;
    savedBodyPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (scrollbarGap > 0) {
      document.body.style.paddingRight = `${scrollbarGap}px`;
    }
  }
  bodyLockCount += 1;
}

function releaseBodyScrollLock() {
  if (typeof document === "undefined") return;
  bodyLockCount = Math.max(0, bodyLockCount - 1);
  if (bodyLockCount === 0) {
    document.body.style.overflow = savedBodyOverflow;
    document.documentElement.style.overflow = savedHtmlOverflow;
    document.body.style.paddingRight = savedBodyPaddingRight;
  }
}

/** Bloque le scroll de la page tant que `locked` est true (empilable). */
export function useLockBodyScroll(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    acquireBodyScrollLock();
    return () => releaseBodyScrollLock();
  }, [locked]);
}

function canScrollElement(el: HTMLElement, deltaY: number) {
  const style = window.getComputedStyle(el);
  const overflowY = style.overflowY;
  const scrollableY = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
  if (!scrollableY) return false;
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  if (deltaY < 0) return el.scrollTop > 0;
  if (deltaY > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  return true;
}

function findScrollableAncestor(start: EventTarget | null, boundary: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = start instanceof HTMLElement ? start : null;
  while (node) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      return node;
    }
    if (node === boundary) break;
    node = node.parentElement;
  }
  return null;
}

type ModalOverlayProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  /** Verrou body (défaut true). Mettre false si un parent verrouille déjà. */
  lockBody?: boolean;
};

/**
 * Fond de modale : bloque le scroll page + empêche le chaînage vers l’arrière-plan
 * (ou une autre modale derrière) quand on est en bout de scroll.
 */
export function ModalOverlay({
  children,
  className,
  lockBody = true,
  ...rest
}: ModalOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useLockBodyScroll(lockBody);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onWheel = (event: WheelEvent) => {
      const scrollable = findScrollableAncestor(event.target, root);
      if (!scrollable || !canScrollElement(scrollable, event.deltaY)) {
        event.preventDefault();
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      const scrollable = findScrollableAncestor(event.target, root);
      if (!scrollable) {
        event.preventDefault();
      }
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={cn("fixed inset-0 overscroll-none", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/** À ajouter sur la zone interne scrollable d’une modale. */
export const modalScrollAreaClassName = "overscroll-y-contain overscroll-contain";
