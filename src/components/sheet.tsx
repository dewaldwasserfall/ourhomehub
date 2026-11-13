/**
 * Bottom sheet, iOS style: slides up with a spring, dims the page, closes on
 * backdrop tap, Escape, or a downward drag on the grabber.
 *
 * On desktop the same sheet is a centred dialog: it fades and settles into
 * place instead of sliding up, and there is no grabber to drag.
 */
"use client";

import { AnimatePresence, motion, useDragControls } from "framer-motion";
import { useEffect, useRef, type ReactNode } from "react";
import { useIsDesktop } from "@/lib/use-is-desktop";

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
  const isDesktop = useIsDesktop();

  // Step 1: Escape closes; focus moves into the sheet when it opens.
  //         onClose is read through a ref so this runs only when the sheet
  //         opens or closes. (Depending on onClose itself re-ran it on every
  //         parent re-render, e.g. each keystroke in a field whose state lives
  //         in the page, moving focus away and closing the phone keyboard.)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    window.addEventListener("keydown", onKey);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Keep focus on a field that autofocused itself; otherwise focus the sheet.
    if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [open]);

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
            // Step 2: phones slide up from the bottom; desktop settles in place.
            initial={isDesktop ? { opacity: 0, y: 16, scale: 0.98 } : { y: "100%" }}
            animate={isDesktop ? { opacity: 1, y: 0, scale: 1 } : { y: 0 }}
            exit={isDesktop ? { opacity: 0, y: 12, scale: 0.98 } : { y: "100%" }}
            transition={isDesktop ? { duration: 0.2, ease: [0.22, 1, 0.36, 1] } : { type: "spring", stiffness: 420, damping: 40 }}
            // Step 3: drag down from the grabber to dismiss (phones only).
            drag={isDesktop ? false : "y"}
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 600) onClose();
            }}
          >
            {!isDesktop && (
              <div
                style={{ padding: "6px 0 2px", touchAction: "none", cursor: "grab" }}
                onPointerDown={(e) => dragControls.start(e)}
              >
                <div className="sheet__grabber" />
              </div>
            )}
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
