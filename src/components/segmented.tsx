/**
 * iOS-style segmented control with a sliding thumb.
 */
"use client";

import { motion } from "framer-motion";
import { useId } from "react";

interface SegmentedProps<T extends string> {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}

export function Segmented<T extends string>({ value, options, onChange, label }: SegmentedProps<T>) {
  // Unique layoutId so two controls on one screen don't share a thumb.
  const thumbId = useId();

  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className="segmented__option"
            onClick={() => onChange(option.value)}
          >
            {selected && (
              <motion.span
                layoutId={thumbId}
                className="segmented__thumb"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            <span className="segmented__label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
