/**
 * Bottom sheet, iOS style: slides up with a spring, dims the page, closes on
 * backdrop tap, Escape, or a downward drag on the grabber.
 */
"use client";

import { AnimatePresence, motion, useDragControls } from "framer-motion";
import { useEffect, useRef, type ReactNode } from "react";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Left button in the sheet bar (usually Cancel). */
  leading?: ReactNode;
  /** Right button in the sheet bar (usually Done / Save). */
  trailing?: ReactNode;
  children: ReactNode;
}

export function Sheet({ open, onClose, title, leading, trailing, children }: SheetProps) {
  const dragControls = useDragControls();
  const panelRef = useRef<HTMLDivElement>(null);

  // Step 1: Escape closes; focus moves into the sheet when it opens.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="sheet-backdrop"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          <motion.div
            ref={panelRef}
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 420, damping: 40 }}
            // Step 2: drag down from the grabber to dismiss.
            drag="y"
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 600) onClose();
            }}
          >
            <div
              style={{ padding: "6px 0 2px", touchAction: "none", cursor: "grab" }}
              onPointerDown={(e) => dragControls.start(e)}
            >
              <div className="sheet__grabber" />
            </div>
            <div className="sheet__bar">
              <div>{leading}</div>
              <div className="sheet__title">{title}</div>
              <div>{trailing}</div>
            </div>
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
