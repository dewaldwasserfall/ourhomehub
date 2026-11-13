/**
 * "Your theme" on the Household screen: everyone picks their own accent
 * colour and Light / Dark / Automatic.
 *
 * The change shows immediately on this device, is saved on the member row
 * (so it follows them to their other devices), and is mirrored in a cookie so
 * the next page load renders in it straight away.
 */
"use client";

import { useState } from "react";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { ACCENTS, applyTheme, personAccentStyle, type ThemeMode } from "@/lib/themes";
import { useHousehold } from "./household-context";
import { CheckIcon } from "./icons";
import { Segmented } from "./segmented";

export function ThemePicker() {
  const supabase = getSupabaseBrowserClient();
  const { me, updateMe } = useHousehold();
  const [error, setError] = useState<string | null>(null);

  // Step 1: apply at once, then save; put it back if saving fails.
  async function save(accent: string, mode: ThemeMode) {
    const previous = { theme_accent: me.theme_accent, theme_mode: me.theme_mode };
    applyTheme(accent, mode);
    updateMe({ theme_accent: accent, theme_mode: mode });
    const { error: updateError } = await supabase
      .from("members")
      .update({ theme_accent: accent, theme_mode: mode })
      .eq("id", me.id);
    if (updateError) {
      applyTheme(previous.theme_accent, previous.theme_mode);
      updateMe(previous);
      setError(friendlyError(updateError));
      return;
    }
    setError(null);
  }

  return (
    <section className="section">
      <div className="section__header">
        <span className="section__header-title">Your theme</span>
      </div>
      <div className="group theme-picker">
        {/* Step 2: accent swatches */}
        <div className="swatches" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => {
            const selected = me.theme_accent === a.id;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={a.label}
                title={a.label}
                className="swatch"
                style={personAccentStyle(a.id)}
                onClick={() => save(a.id, me.theme_mode)}
              >
                {selected && <CheckIcon size={18} strokeWidth={3} />}
              </button>
            );
          })}
        </div>

        {/* Step 3: light, dark or follow the phone */}
        <Segmented
          label="Appearance"
          value={me.theme_mode}
          onChange={(mode) => save(me.theme_accent, mode)}
          options={[
            { value: "system", label: "Automatic" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </div>
      <p className="section__footer">
        {error ?? "Only changes HomeHub for you. Your colour also marks the things that are yours."}
      </p>
    </section>
  );
}
