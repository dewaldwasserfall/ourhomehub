/**
 * True when the screen is wide enough for the desktop layout (sidebar,
 * multi-column pages, dialogs instead of bottom sheets).
 *
 * The breakpoint matches the CSS (section 17 in globals.css). Starts false
 * on the server and the first render, so phones never flash the desktop UI.
 */
"use client";

import { useEffect, useState } from "react";

export const DESKTOP_QUERY = "(min-width: 1024px)";

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    // Step 1: read the current width, then follow resizes and rotations.
    const query = window.matchMedia(DESKTOP_QUERY);
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isDesktop;
}
