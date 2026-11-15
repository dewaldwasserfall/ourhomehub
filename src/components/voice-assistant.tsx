/**
 * The voice helper's button and conversation sheet (board and phones).
 *
 *   1. Tap 🎤: the sheet opens and listens (Chrome's built-in speech
 *      recognition, British English). What you say appears as you say it.
 *   2. When you stop talking, it's sent to /api/assistant (Claude, acting
 *      with this device's own sign-in).
 *   3. The reply shows, and is read aloud (the browser's built-in voice).
 *      "Ask again" listens for the next one.
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

/** Read a reply aloud in a British English voice, if there is one. */
function speak(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB";
    const voice = synth.getVoices().find((v) => v.lang === "en-GB") ?? synth.getVoices().find((v) => v.lang.startsWith("en"));
    if (voice) u.voice = voice;
    u.rate = 1.02;
    synth.speak(u);
  } catch {
    // No voice on this device: the reply is still on screen.
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
        body: JSON.stringify({ text: value }),
      });
      const json = (await res.json().catch(() => ({}))) as { reply?: string; message?: string };
      const answer = res.ok ? (json.reply ?? "Done.") : (json.message ?? "Something went wrong. Try again.");
      setReply(answer);
      setPhase("answered");
      speak(answer);
    } catch {
      setReply("No connection. Check the internet and try again.");
      setPhase("answered");
    }
  }, []);

  // Step 2: listen once; send when the person stops talking.
  const listen = useCallback(() => {
    const Ctor = recognitionCtor();
    window.speechSynthesis?.cancel();
    setReply(null);
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
      else if (e.error === "no-speech") setNote("I didn't hear anything. Tap Ask again.");
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

  // Step 3: open and close.
  const start = () => {
    setOpen(true);
    setTyped("");
    listen();
  };
  const close = () => {
    recognition.current?.abort();
    recognition.current = null;
    window.speechSynthesis?.cancel();
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
          {reply && <p className="voice__reply">{reply}</p>}
          {note && <p className="voice__note">{note}</p>}

          {/* Talk again, or type */}
          <button type="button" className={`voice__mic ${phase === "listening" ? "voice__mic--on" : ""}`} onClick={listen} disabled={phase === "thinking"}>
            <MicIcon size={28} />
            <span>{phase === "listening" ? "Listening…" : "Ask again"}</span>
          </button>
          <form
            className="voice__type"
            onSubmit={(e) => {
              e.preventDefault();
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
