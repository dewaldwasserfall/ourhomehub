/**
 * A short, gentle chime for celebrations (board only, when switched on).
 *
 * Synthesised with the Web Audio API, so there's no sound file to load.
 * Browsers only allow sound after someone has touched the page, so the audio
 * is unlocked on the first tap (unlockChime, called by the board once).
 */

let ctx: AudioContext | null = null;

/** Step 1: create / resume the audio on a tap. Safe to call repeatedly. */
export function unlockChime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    ctx = null;
  }
}

/** Step 2: play a rising four-note chime (C, E, G, high C), soft sine tones. */
export function playChime(): void {
  if (!ctx || ctx.state !== "running") return;
  const notes = [523.25, 659.25, 783.99, 1046.5];
  const start = ctx.currentTime + 0.05;
  notes.forEach((freq, i) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = start + i * 0.13;
    // Quick fade in, long gentle tail.
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(t);
    osc.stop(t + 1);
  });
}
