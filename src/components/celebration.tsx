/**
 * The "you earned it!" moment.
 *
 *   * Full screen: the child's avatar, large, "Lennon earned Screen time!",
 *     and confetti in their own colour (plus gold). Stays about 6 seconds or
 *     until someone taps it.
 *   * Several at once (both kids) show one after another.
 *   * With "reduce motion" on, no confetti: the message fades in instead.
 *   * The board can add a chime (a per-board switch; see chime.ts).
 *
 * Use <CelebrationLayer> on any screen that shows rewards: it watches the
 * plans and their progress and celebrates each earned reward once per
 * period on this device (see celebrate.ts).
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { dueCelebrations, loadSeen, rememberSeen, type Celebration } from "@/lib/celebrate";
import { playChime } from "@/lib/chime";
import type { RewardPlan, RewardProgress } from "@/lib/rewards";
import { ACCENTS } from "@/lib/themes";

/** How long a celebration stays without a tap. */
const SHOW_MS = 6000;
const GOLD = ["#ffc53d", "#ffb800", "#ffe08a"];

export function CelebrationLayer({
  plans,
  progress,
  sound = false,
}: {
  plans: RewardPlan[];
  progress: Record<string, RewardProgress | undefined>;
  sound?: boolean;
}) {
  // Step 1: the queue. Each one is remembered as soon as it shows, so a
  //         refresh halfway through doesn't repeat it.
  const [current, setCurrent] = useState<Celebration | null>(null);
  const due = useMemo(() => (current ? [] : dueCelebrations(plans, progress, loadSeen())), [plans, progress, current]);
  useEffect(() => {
    if (current || due.length === 0) return;
    const next = due[0];
    rememberSeen(next.key);
    setCurrent(next);
    if (sound) playChime();
  }, [due, current, sound]);

  if (!current) return null;
  return <CelebrationScreen key={current.key} plan={current.plan} onDone={() => setCurrent(null)} />;
}

function CelebrationScreen({ plan, onDone }: { plan: RewardPlan; onDone: () => void }) {
  const { memberById } = useHousehold();
  const child = memberById(plan.member_id);
  const canvas = useRef<HTMLCanvasElement>(null);

  // Step 2: close by itself after a while.
  useEffect(() => {
    const timer = setTimeout(onDone, SHOW_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  // Step 3: confetti (skipped with "reduce motion").
  useEffect(() => {
    const el = canvas.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const accent = ACCENTS.find((a) => a.id === child?.theme_accent) ?? ACCENTS[0];
    return runConfetti(el, [accent.light, accent.dark, ...GOLD, "#ffffff"]);
  }, [child?.theme_accent]);

  const name = child?.display_name.split(" ")[0] ?? "Someone";
  return (
    <button type="button" className="celebrate" onClick={onDone} aria-label={`${name} earned ${plan.title}. Tap to close.`}>
      <canvas ref={canvas} className="celebrate__confetti" aria-hidden="true" />
      <span className="celebrate__card" role="status">
        <span className="celebrate__avatar">
          <Avatar member={child} />
        </span>
        <span className="celebrate__who">{name} earned</span>
        <span className="celebrate__what">{plan.title}!</span>
        <span className="celebrate__hint">Tap to close</span>
      </span>
    </button>
  );
}

/**
 * Step 4: a burst of confetti from the top, falling with a little drift and
 * spin. Returns a stop function.
 */
function runConfetti(el: HTMLCanvasElement, colours: string[]): () => void {
  const ctx = el.getContext("2d");
  if (!ctx) return () => {};
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    el.width = el.clientWidth * dpr;
    el.height = el.clientHeight * dpr;
  };
  resize();
  window.addEventListener("resize", resize);

  // 4a. The pieces: start above the screen, fan out, fall.
  const w = () => el.width;
  const h = () => el.height;
  const pieces = Array.from({ length: 160 }, () => ({
    x: Math.random() * w(),
    y: -Math.random() * h() * 0.6,
    vx: (Math.random() - 0.5) * 3 * dpr,
    vy: (2 + Math.random() * 3) * dpr,
    size: (6 + Math.random() * 8) * dpr,
    angle: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.3,
    sway: Math.random() * Math.PI * 2,
    colour: colours[Math.floor(Math.random() * colours.length)],
  }));

  // 4b. Animate for a few seconds, then let the last pieces fall off.
  let frame = 0;
  let raf = 0;
  const tick = () => {
    frame += 1;
    ctx.clearRect(0, 0, w(), h());
    let visible = 0;
    for (const p of pieces) {
      p.sway += 0.05;
      p.x += p.vx + Math.sin(p.sway) * 0.8 * dpr;
      p.y += p.vy;
      p.angle += p.spin;
      if (p.y > h() + p.size) {
        // Recycle to the top for the first ~3 seconds, then let them go.
        if (frame < 180) {
          p.y = -p.size;
          p.x = Math.random() * w();
        } else continue;
      }
      visible += 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.colour;
      // A paper strip that "flips" as it spins.
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, (p.size / 2) * Math.abs(Math.cos(p.sway)));
      ctx.restore();
    }
    if (visible > 0) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}
