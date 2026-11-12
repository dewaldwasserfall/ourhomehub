/**
 * A single transient message floating above the composer, with an optional
 * action (e.g. Undo). Usage: const toast = useToast(); toast.show("Saved").
 */
"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

interface ToastMessage {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function useToast() {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback((text: string, action?: { label: string; onAction: () => void }) => {
    clearTimeout(timer.current);
    setMessage({ id: Date.now(), text, actionLabel: action?.label, onAction: action?.onAction });
    timer.current = setTimeout(() => setMessage(null), action ? 5000 : 3500);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const node = (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        left: 16,
        right: 16,
        bottom: "calc(var(--tabbar-h) + var(--composer-h) + var(--safe-bottom) + 18px)",
        zIndex: 50,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <AnimatePresence>
        {message && (
          <motion.div
            key={message.id}
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 500, damping: 36 }}
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "center",
              gap: 16,
              maxWidth: 560,
              padding: "12px 18px",
              borderRadius: 16,
              background: "var(--ink)",
              color: "var(--canvas)",
              fontSize: 15,
              boxShadow: "var(--float-shadow)",
            }}
          >
            <span>{message.text}</span>
            {message.actionLabel && (
              <button
                type="button"
                style={{ color: "inherit", fontWeight: 700, opacity: 0.92 }}
                onClick={() => {
                  message.onAction?.();
                  setMessage(null);
                }}
              >
                {message.actionLabel}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  return { show, node };
}
