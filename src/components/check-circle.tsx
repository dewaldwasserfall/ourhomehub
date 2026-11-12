/**
 * Round tick-off control. The fill grows from the centre and the check draws
 * itself, so ticking an item feels physical.
 */
"use client";

import { AnimatePresence, motion } from "framer-motion";

interface CheckCircleProps {
  checked: boolean;
  onToggle: () => void;
  label: string;
}

export function CheckCircle({ checked, onToggle, label }: CheckCircleProps) {
  return (
    <button
      type="button"
      className="check"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        // A tiny haptic tick on Android (iOS Safari ignores this).
        if (!checked && "vibrate" in navigator) navigator.vibrate?.(8);
        onToggle();
      }}
    >
      <span className="check__ring" />
      <AnimatePresence initial={false}>
        {checked && (
          <motion.span
            key="fill"
            className="check__fill"
            initial={{ scale: 0.3, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.3, opacity: 0 }}
            transition={{ type: "spring", stiffness: 600, damping: 28 }}
          />
        )}
      </AnimatePresence>
      {checked && (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <motion.path
            d="M5.5 12.5l4.2 4.2L18.5 7.8"
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.22, delay: 0.06, ease: "easeOut" }}
          />
        </svg>
      )}
    </button>
  );
}
