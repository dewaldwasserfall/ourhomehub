/**
 * The voice helper's button and conversation sheet (board and phones).
 *
 *   1. Tap 🎤: the sheet opens and listens (Chrome's built-in speech
 *      recognition, British English). What you say appears as you say it.
 *   2. When you stop talking, it's sent to /api/assistant (Claude, acting
 *      with this device's own sign-in).
 *   3. The reply shows, and is read aloud (the browser's built-in voice, or
 *      Fully Kiosk's on the wall tablet).
 *   4. A conversation: while the sheet is open, each question goes with the
 *      last few back-and-forths, so "Hardware" can answer "Which list?". If
 *      the helper asked something back, the mic opens again by itself once
 *      it has finished speaking; otherwise "Ask again" listens. Closing the
 *      sheet forgets the conversation (the next person starts fresh).
 *
 * No microphone or no speech recognition (some browsers)? Type instead:
 * the text field always works.
 *
 * Nothing is recorded or stored by HomeHub; the words go to Google (speech
 * recognition, inside Chrome) and Anthropic (the reply).
 */
"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { Sheet } from "@/components/sheet";
import { MAX_HISTORY_TURNS, asksBack, type HistoryTurn } from "@/lib/assistant/core";

// Step 0: the bits of the Web Speech API we use (not in TypeScript's DOM types).
interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEventLike {
  results: ArrayLike<RecognitionResultLike>;
}
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
}
type RecognitionCtor = new () => RecognitionLike;

const recognitionCtor = (): RecognitionCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

type Phase = "idle" | "listening" | "thinking" | "answered";

/**
 * Reading replies aloud (the browser's built-in voice).
 *
 * Chrome on Android is fussy about speech:
 *   * it only speaks after a tap, and the reply arrives a few seconds after
 *     the tap, so primeSpeech() says an empty sentence during the tap itself
 *     to unlock speaking for the page;
 *   * speak() straight after cancel() is often dropped, so we wait a moment;
 *   * the voices list is empty until it has loaded ("voiceschanged");
 *   * asking for a language with no installed voice can stay silent, so we
 *     pick an installed English voice and use its own language.
 */
let primedAt = 0;
function primeSpeech() {
  primedAt = Date.now();
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    synth.speak(u);
  } catch {
    // No speech on this device: replies still show on screen.
  }
}

/** An installed English voice: British first, then any English. Waits up to 1 s for the list. */
async function pickVoice(): Promise<SpeechSynthesisVoice | null> {
  const synth = window.speechSynthesis;
  const choose = () => {
    const voices = synth.getVoices();
    return (
      voices.find((v) => v.lang.replace("_", "-") === "en-GB" && v.localService) ??
      voices.find((v) => v.lang.replace("_", "-") === "en-GB") ??
      voices.find((v) => v.lang.toLowerCase().startsWith("en")) ??
      null
    );
  };
  if (synth.getVoices().length) return choose();
  await new Promise<void>((resolve) => {
    const done = () => {
      synth.removeEventListener("voiceschanged", done);
      resolve();
    };
    synth.addEventListener("voiceschanged", done);
    setTimeout(done, 1000);
  });
  return choose();
}

/**
 * Fully Kiosk Browser (the wall tablet's kiosk app) shows pages in Android's
 * WebView, which has no speechSynthesis. It offers its own text-to-speech to
 * the page instead, when "Enable JavaScript Interface" is switched on in
 * Fully (Advanced Web Settings; a Fully PLUS feature).
 */
interface FullyLike {
  textToSpeech?: (text: string, localeOrVoice?: string) => void;
  stopTextToSpeech?: () => void;
  initTts?: () => void;
  bind?: (event: string, code: string) => void;
}
const fully = (): FullyLike | null => (typeof window === "undefined" ? null : ((window as unknown as { fully?: FullyLike }).fully ?? null));

/** Which way replies are read aloud on this device (shown in the sheet when it's "none"). */
export type SpeechRoute = "fully" | "browser" | "none";
export function speechRoute(): SpeechRoute {
  if (typeof window === "undefined") return "none";
  if (fully()?.textToSpeech) return "fully";
  return window.speechSynthesis ? "browser" : "none";
}

// Fully reports how speaking went through events; it runs the code we give
// bind() as a string, so the events call this global.
let fullyStarted = 0;
let fullyReady = false;
/** Called when Fully has finished reading the current reply. */
let fullyDone: (() => void) | null = null;
function readyFully(kiosk: FullyLike) {
  if (fullyReady) return;
  fullyReady = true;
  (window as unknown as { __hhTts?: (e: string) => void }).__hhTts = (e) => {
    if (e === "start") fullyStarted = Date.now();
    if (e === "done" && fullyDone) {
      const done = fullyDone;
      fullyDone = null;
      done();
    }
  };
  try {
    kiosk.bind?.("ttsUtteranceStart", "window.__hhTts && window.__hhTts('start')");
    kiosk.bind?.("ttsUtteranceDone", "window.__hhTts && window.__hhTts('done')");
    kiosk.initTts?.(); // newer Fully versions: start the speech engine early
  } catch {
    // Older Fully: speaking still works without these.
  }
}

/**
 * Read a reply aloud. onProblem gets a sentence to show when it can't;
 * onDone runs once it has finished (or couldn't speak at all), at most once.
 */
async function speak(text: string, onProblem: (message: string) => void = () => {}, onDone: () => void = () => {}) {
  // Step A: onDone exactly once, with a safety net in case no "finished"
  //         event ever comes (about 80 ms a character, plus slack).
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(safety);
    onDone();
  };
  const safety = setTimeout(done, text.length * 80 + 5000);
  try {
    // Step 0: inside Fully Kiosk: use its speech (the device's own voice).
    //         British English first; if nothing starts within 2.5 s (that
    //         voice isn't installed), the device's default voice.
    const kiosk = fully();
    if (kiosk?.textToSpeech) {
      readyFully(kiosk);
      fullyDone = done;
      const asked = Date.now();
      kiosk.stopTextToSpeech?.();
      kiosk.textToSpeech(text, "en_GB");
      if (!kiosk.bind) return; // can't tell whether it started: trust it
      await new Promise((r) => setTimeout(r, 2500));
      if (fullyStarted >= asked) return;
      kiosk.textToSpeech(text);
      await new Promise((r) => setTimeout(r, 2500));
      if (fullyStarted < asked) {
        onProblem("The tablet didn't read it out. Check its text-to-speech voice in Android Settings.");
        done();
      }
      return;
    }
    if (!window.speechSynthesis) {
      onProblem("This app can't read replies aloud. In Fully Kiosk, turn on Advanced Web Settings → Enable JavaScript Interface, then reload.");
      done();
      return;
    }
    const synth = window.speechSynthesis;
    // Step 1: stop anything still talking, then give Chrome a moment.
    if (synth.speaking || synth.pending) {
      synth.cancel();
      await new Promise((r) => setTimeout(r, 150));
    }
    // Step 2: an installed English voice, in its own language.
    const u = new SpeechSynthesisUtterance(text);
    const voice = await pickVoice();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = "en-GB";
    }
    u.rate = 1;
    u.volume = 1;
    u.onend = done;
    u.onerror = done;
    synth.resume(); // Chrome can leave the queue paused
    synth.speak(u);
  } catch {
    // No voice on this device: the reply is still on screen.
    done();
  }
}

export function VoiceAssistant({ variant }: { variant: "board" | "fab" }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState("");
  const [typed, setTyped] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const recognition = useRef<RecognitionLike | null>(null);
  const finalText = useRef("");
  // The conversation while the sheet is open (cleared on close).
  const history = useRef<HistoryTurn[]>([]);
  const isOpen = useRef(false);
  // listen() is defined below ask(); ask() reaches it through this ref.
  const listenRef = useRef<(auto?: boolean) => void>(() => {});

  // Step 1: send what was said (or typed) and read the answer out.
  const ask = useCallback(async (text: string) => {
    const value = text.trim();
    if (!value) return;
    setPhase("thinking");
    setNote(null);
    setReply(null);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value, history: history.current }),
      });
      const json = (await res.json().catch(() => ({}))) as { reply?: string; message?: string };
      const answer = res.ok ? (json.reply ?? "Done.") : (json.message ?? "Something went wrong. Try again.");
      setReply(answer);
      setPhase("answered");
      // Remember this exchange (only real answers) for the follow-up.
      if (res.ok) history.current = [...history.current, { role: "user" as const, text: value }, { role: "assistant" as const, text: answer }].slice(-MAX_HISTORY_TURNS);
      // Asked something back? Open the mic again once it's done talking.
      const again = res.ok && asksBack(answer);
      void speak(answer, setNote, () => {
        if (again && isOpen.current) listenRef.current(true);
      });
    } catch {
      setReply("No connection. Check the internet and try again.");
      setPhase("answered");
    }
  }, []);

  // Step 2: listen once; send when the person stops talking.
  const listen = useCallback((auto = false) => {
    const Ctor = recognitionCtor();
    // Stop a reply that's still being read out (but don't cancel the silent
    // primer: that's what unlocks speaking for the next reply).
    if (window.speechSynthesis?.speaking && Date.now() - primedAt > 1000) window.speechSynthesis.cancel();
    fully()?.stopTextToSpeech?.();
    // Opened by itself after a question: keep the question on screen.
    if (!auto) setReply(null);
    setHeard("");
    setNote(null);
    finalText.current = "";
    if (!Ctor) {
      setPhase("idle");
      setNote("Voice isn't available in this browser. Type it instead.");
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-GB";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join("");
      setHeard(text);
      if (Array.from(e.results).every((r) => r.isFinal)) finalText.current = text;
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setNote("The microphone is blocked. Allow it in the browser's site settings, or type instead.");
      else if (e.error === "no-speech") setNote(auto ? "Tap Ask again to answer." : "I didn't hear anything. Tap Ask again.");
      else if (e.error !== "aborted") setNote("I didn't catch that. Tap Ask again, or type it.");
    };
    rec.onend = () => {
      recognition.current = null;
      if (finalText.current) void ask(finalText.current);
      else setPhase((p) => (p === "listening" ? "idle" : p));
    };
    recognition.current = rec;
    setPhase("listening");
    try {
      rec.start();
    } catch {
      setPhase("idle");
    }
  }, [ask]);
  listenRef.current = listen;

  // Step 3: open and close.
  const start = () => {
    primeSpeech(); // inside the tap: unlocks speaking for the reply later
    history.current = []; // a new conversation
    isOpen.current = true;
    setOpen(true);
    setTyped("");
    listen();
  };
  const close = () => {
    recognition.current?.abort();
    recognition.current = null;
    window.speechSynthesis?.cancel();
    fully()?.stopTextToSpeech?.();
    fullyDone = null;
    history.current = [];
    isOpen.current = false;
    setOpen(false);
    setPhase("idle");
  };
  useEffect(() => () => recognition.current?.abort(), []);

  return (
    <>
      <button type="button" className={variant === "board" ? "board-lock voice-board" : "voice-fab"} onClick={start} aria-label="Ask HomeHub">
        <MicIcon size={variant === "board" ? 22 : 24} />
      </button>

      <Sheet
        open={open}
        onClose={close}
        title="Ask HomeHub"
        leading={
          <button type="button" className="nav-button" onClick={close}>
            Done
          </button>
        }
      >
        <div className="voice">
          {/* What was heard, and the answer */}
          <div className="voice__said" aria-live="polite">
            {phase === "listening" && <span className="voice__listening">{heard || "Listening…"}</span>}
            {phase !== "listening" && heard && <span className="voice__heard">&ldquo;{heard}&rdquo;</span>}
          </div>
          {phase === "thinking" && <p className="voice__thinking">Thinking…</p>}
          {reply && (
            <div className="voice__reply">
              <p>{reply}</p>
              <button type="button" className="voice__replay" onClick={() => void speak(reply, setNote)} aria-label="Read it out again">
                🔊
              </button>
            </div>
          )}
          {note && <p className="voice__note">{note}</p>}

          {/* Talk again, or type */}
          <button
            type="button"
            className={`voice__mic ${phase === "listening" ? "voice__mic--on" : ""}`}
            onClick={() => {
              primeSpeech();
              listen(false);
            }} disabled={phase === "thinking"}>
            <MicIcon size={28} />
            <span>{phase === "listening" ? "Listening…" : "Ask again"}</span>
          </button>
          <form
            className="voice__type"
            onSubmit={(e) => {
              e.preventDefault();
              primeSpeech();
              recognition.current?.abort();
              setHeard(typed);
              void ask(typed);
              setTyped("");
            }}
          >
            <input
              className="input"
              placeholder="Or type: add eggs to groceries"
              aria-label="Type a request"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              maxLength={300}
              enterKeyHint="send"
            />
            <button type="submit" className="chip-button chip-button--strong" disabled={!typed.trim() || phase === "thinking"}>
              Send
            </button>
          </form>
          <p className="voice__help">Try: &ldquo;Add eggs and milk&rdquo;, &ldquo;When are the bins?&rdquo;, &ldquo;What&rsquo;s on Saturday?&rdquo;</p>
        </div>
      </Sheet>
    </>
  );
}

/**
 * Phones: a round 🎤 button above the tab bar, on every screen, for adults.
 * (Children ask on the board.) Hidden on a list, where the add-item bar
 * sits in the same corner.
 */
export function VoiceFab() {
  const { meIsAdult } = useHousehold();
  const pathname = usePathname();
  if (!meIsAdult || pathname.startsWith("/lists/")) return null;
  return <VoiceAssistant variant="fab" />;
}

/** A microphone. */
function MicIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </svg>
  );
}
