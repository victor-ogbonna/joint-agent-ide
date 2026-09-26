import React, { useState, useRef, useEffect } from "react";
import { motion } from "motion/react";
import { Send, MessageSquare, Cpu, Zap, Bot, Plus, Mic, Copy, PenTool, Check, Square, Code, X} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { ChatMessage, MCUType, SchematicComponent, SchematicConnection } from "../types";
import { callAiEndpoint, QuotaBlockedInfo } from "../lib/aiClient";

interface AgentChatProps {
  messages: ChatMessage[];
  onSendMessage: (text: string, modeOverride?: "plan" | "implement") => void;
  isLoading: boolean;
  mcu: MCUType;
  chatMode: "plan" | "implement";
  setChatMode: (mode: "plan" | "implement") => void;
  mcuPluggedIn?: boolean;
  onStopGeneration?: () => void;
  isSmartFlashing?: boolean;
  onSmartFlash?: () => void;
  onApplyUpdate: (update: {
    code?: string;
    description?: string;
    components?: SchematicComponent[];
    connections?: SchematicConnection[];
  }) => void;
  onQuotaBlocked?: (info: QuotaBlockedInfo) => void;
}

// A clarifying question's answer box. Kept as a stable, module-level
// component (rather than defined inline per-render) so its open/typed
// state survives re-renders of the parent chat feed.
//
// Answers are saved locally (onSaveAnswer) rather than sent immediately —
// pressing Enter here must NOT dispatch anything to the agent, since the
// user may still have other questions left to answer. Only the "Proceed to
// Implement" button actually sends, bundling every saved answer at once.
/**
 * Re-encode whatever the browser recorded as 16 kHz mono WAV.
 *
 * MediaRecorder produces webm/opus on Chrome and mp4 on Safari and iOS, and
 * Gemini's inline audio accepts webm but NOT audio/mp4 — so voice input could
 * never have worked on an iPhone. Rather than special-case containers, decode
 * and re-encode to WAV: every engine accepts it and it carries no codec
 * parameters to get wrong. Speech at 16 kHz mono is about 32 KB per second,
 * comfortably inside the request limit.
 */
async function encodeAsWav(blob: Blob): Promise<string> {
  const Ctx: typeof AudioContext =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) throw new Error("This browser cannot process audio.");

  const decodeCtx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    try { await decodeCtx.close(); } catch { /* already closed */ }
  }

  // Downmix to mono at 16 kHz. Some engines refuse an OfflineAudioContext
  // below 44.1 kHz, so fall back to the source rate rather than fail.
  let pcm: Float32Array;
  let rate: number;
  try {
    const target = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * target), target);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    pcm = (await offline.startRendering()).getChannelData(0);
    rate = target;
  } catch {
    pcm = decoded.getChannelData(0);
    rate = decoded.sampleRate;
  }

  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const ascii = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const c = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true);
  }

  const raw = new Uint8Array(view.buffer);
  let binary = "";
  // Chunked: spreading a large array into fromCharCode blows the stack.
  for (let i = 0; i < raw.length; i += 0x8000) {
    binary += String.fromCharCode(...raw.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function PlanQuestionItem({
  children,
  liProps,
  chatMode,
  savedAnswer,
  onSaveAnswer
}: {
  children: React.ReactNode;
  liProps: any;
  chatMode: "plan" | "implement";
  savedAnswer?: string;
  onSaveAnswer: (question: string, answer: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(savedAnswer || "");

  const extractText = (nodes: any): string => {
    let text = "";
    React.Children.forEach(nodes, (child: any) => {
      if (typeof child === "string") text += child;
      else if (child && child.props && child.props.children) text += extractText(child.props.children);
    });
    return text;
  };
  const textContent = extractText(children);
  const isQuestion = textContent.trim().endsWith("?");

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSaveAnswer(textContent.trim(), trimmed);
    setOpen(false);
  };

  return (
    <li {...liProps}>
      {children}
      {isQuestion && chatMode === "plan" && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={`ml-2 inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded transition ${
              savedAnswer ? "bg-green-500/10 text-green-500 hover:bg-green-500 hover:text-white" : "bg-blue-500/10 text-blue-500 hover:bg-blue-500 hover:text-white"
            }`}
          >
            {savedAnswer ? <Check size={10} /> : <MessageSquare size={10} />} {savedAnswer ? "Answered" : "Comment"}
          </button>
          {open && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                type="text"
                autoFocus
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                  if (e.key === "Escape") setOpen(false);
                }}
                placeholder="Type your answer..."
                className="flex-1 min-w-0 bg-[var(--bg-root)] border border-[var(--border-main)] rounded px-2 py-1 text-[10px] text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-blue-500 transition"
              />
              <button
                type="button"
                onClick={submit}
                className="p-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition shrink-0"
                title="Save answer (sent when you click Proceed to Implement)"
              >
                <Send size={10} />
              </button>
            </div>
          )}
        </>
      )}
    </li>
  );
}


// Memoised so a streaming reply does not re-parse every OTHER message.
// The list previously re-rendered in full on every token — with ReactMarkdown +
// KaTeX on each message that is thousands of markdown parses for one reply,
// which is what made streaming feel jerky. Only the message whose content is
// actually changing re-renders now.
const MessageMarkdown = React.memo(function MessageMarkdown({
  content, chatMode, pendingAnswers, onSaveAnswer,
}: {
  content: string;
  chatMode: "plan" | "implement";
  pendingAnswers: Record<string, string>;
  onSaveAnswer: (question: string, answer: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        li({ node, children, ...props }: any) {
          const extractText = (nodes: any): string => {
            let text = "";
            React.Children.forEach(nodes, (child: any) => {
              if (typeof child === "string") text += child;
              else if (child && child.props && child.props.children) text += extractText(child.props.children);
            });
            return text;
          };
          const questionText = extractText(children).trim();
          return (
            <PlanQuestionItem
              chatMode={chatMode}
              liProps={props}
              savedAnswer={pendingAnswers[questionText]}
              onSaveAnswer={onSaveAnswer}
            >
              {children}
            </PlanQuestionItem>
          );
        },
        code({ node, inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || "");
          if (!inline && match) {
            return (
              <pre className="my-2 p-3 bg-[var(--bg-root)] rounded-md border border-[var(--border-main)] overflow-x-auto text-xs">
                <code className={className} {...props}>{children}</code>
              </pre>
            );
          }
          return <code className={className} {...props}>{children}</code>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

export default function AgentChat({
  messages,
  onSendMessage,
  isLoading,
  mcu,
  onApplyUpdate,
  chatMode,
  setChatMode,
  mcuPluggedIn,
  onStopGeneration,
  isSmartFlashing,
  onSmartFlash,
  onQuotaBlocked
}: AgentChatProps) {
  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  // One value per bar, so the indicator is a waveform rather than five bars
  // rising and falling as one.
  const [audioBars, setAudioBars] = useState<number[]>([0, 0, 0, 0, 0]);
  const [voiceError, setVoiceError] = useState("");
  /** Loudest RMS seen while recording. The model will happily invent a
   *  sentence out of silence — asking it not to helps but does not hold — so
   *  whether anything was actually said is decided here, deterministically,
   *  before any audio is sent or any tokens are spent. */
  const peakLevelRef = useRef(0);
  const SPEECH_RMS_FLOOR = 0.015;   // comfortably above a room's noise floor
  // Clarifying-question answers, saved locally by each PlanQuestionItem and
  // keyed by question text. Only sent (bundled together) when the user
  // clicks "Proceed to Implement" — never on a per-question Enter/Send.
  const [pendingAnswers, setPendingAnswers] = useState<Record<string, string>>({});

  // Firmware-only starters. Schematic/wiring generation isn't the focus yet,
  // so nothing here asks the agent to draw or map connections — these stay on
  // code the toolchain can actually compile and flash today.
  const starterPrompts = [
    // First slot is the zero-hardware path: the built-in LED needs no wiring,
    // so a new user reaches a real flash in under a minute. Phrased to invite
    // the agent's clarifying questions rather than assume a board.
    { label: "Blink built-in LED", prompt: "Blink the built-in LED on my board — ask me which board I'm using and how fast it should blink." },
    { label: "DHT11 Station", prompt: "Create a DHT11 temperature logger that prints temperature and humidity readings to the Serial monitor every two seconds." },
    { label: "Servo Swinger", prompt: "Write an SG90 micro servo sweep controller sketch that moves smoothly between 0 and 180 degrees." },
    { label: "Smart Button LED", prompt: "Configure a push button that toggles an indicator LED, with software debouncing so a single press registers once." }
  ];

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const mediaRecorderRef = useRef<any>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const toggleRecording = async () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
      setAudioLevel(0);
      setAudioBars([0, 0, 0, 0, 0]);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Never assume the container. MediaRecorder's default is webm/opus on
        // Chrome but mp4 on Safari and iOS, and the old code hardcoded
        // "audio/webm" for both the Blob and the mimeType sent to the model —
        // so on Apple hardware it described mp4 bytes as webm and transcription
        // could only fail or hallucinate.
        const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
        const picked = candidates.find((t) => (window as any).MediaRecorder?.isTypeSupported?.(t));
        const mediaRecorder = picked ? new MediaRecorder(stream, { mimeType: picked }) : new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];
        
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        const timeData = new Uint8Array(analyser.fftSize);
        const smoothed = [0, 0, 0, 0, 0];

        const updateAudioLevel = () => {
          if (analyserRef.current) {
            // Loudness from the time domain as RMS. Averaging the whole
            // frequency spectrum — what this did before — is dominated by the
            // empty high bins, so the meter barely moved however loudly
            // anyone spoke.
            analyserRef.current.getByteTimeDomainData(timeData);
            let sumSquares = 0;
            for (let i = 0; i < timeData.length; i++) {
              const v = (timeData[i] - 128) / 128;
              sumSquares += v * v;
            }
            const rms = Math.sqrt(sumSquares / timeData.length);
            if (rms > peakLevelRef.current) peakLevelRef.current = rms;
            setAudioLevel(Math.min(1, rms * 4));

            // Each bar gets its own slice of the spectrum, weighted towards
            // speech (roughly 100 Hz - 4 kHz sits in the lower half of the
            // bins at this fftSize), so the shape moves with the voice.
            analyserRef.current.getByteFrequencyData(freqData);
            const usable = Math.floor(freqData.length * 0.6);
            const per = Math.max(1, Math.floor(usable / smoothed.length));
            for (let b = 0; b < smoothed.length; b++) {
              let sum = 0;
              for (let i = b * per; i < (b + 1) * per; i++) sum += freqData[i] || 0;
              const band = Math.min(1, sum / per / 140);
              // Ease towards the new value so it looks like a wave, not a strobe.
              smoothed[b] = smoothed[b] * 0.55 + band * 0.45;
            }
            setAudioBars([...smoothed]);
          }
          animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
        };
        updateAudioLevel();

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          setIsTranscribing(true);
          setVoiceError("");
          // What the recorder actually produced, not what we hoped for.
          const recorded = mediaRecorder.mimeType || picked || "audio/webm";
          const audioBlob = new Blob(audioChunksRef.current, { type: recorded });
          if (audioBlob.size < 1024) {
            setIsTranscribing(false);
            setVoiceError("That recording was too short to hear. Hold the button while you speak.");
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          if (peakLevelRef.current < SPEECH_RMS_FLOOR) {
            setIsTranscribing(false);
            setVoiceError("No sound was picked up. Check that the right microphone is selected and that it is not muted.");
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          try {
             // Always WAV, whatever the recorder produced.
             const base64Audio = await encodeAsWav(audioBlob);
             const result = await callAiEndpoint('/api/ai/transcribe', {
               audioData: base64Audio,
               mimeType: "audio/wav",
             });
             if (!result.ok) {
                if (result.blocked && result.info) {
                   onQuotaBlocked?.(result.info);
                } else {
                   // This used to go only to console.error, so a failed
                   // transcription looked exactly like a mic that did nothing.
                   setVoiceError(result.error || "Could not transcribe that. Try again.");
                }
             } else if (result.data?.text?.trim()) {
                setInput((prev) => prev + (prev ? " " : "") + result.data.text.trim());
             } else {
                setVoiceError("No speech was picked up. Try again, a little closer to the microphone.");
             }
          } catch (err: any) {
             setVoiceError(err?.message || "Could not process that recording.");
          } finally {
             setIsTranscribing(false);
             stream.getTracks().forEach((track) => track.stop());
          }
        };

        setVoiceError("");
        peakLevelRef.current = 0;
        mediaRecorder.start();
        setIsRecording(true);
      } catch (err: any) {
        setVoiceError(
          err?.name === "NotAllowedError"
            ? "Microphone access was blocked. Allow it for this site in your browser settings and try again."
            : err?.name === "NotFoundError"
            ? "No microphone was found on this device."
            : err?.message || "Could not start recording."
        );
        console.error("Microphone error:", err);
        alert("Microphone access denied or not available. Please check your permissions.");
      }
    }
  };

  const handleFileUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
      // Stub file upload logic
      alert("Document upload functionality would process the file here.");
    };
    input.click();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    onSendMessage(input.trim());
    setInput("");
  };

  return (
    <div id="ai-chat-panel" className="bg-[var(--bg-panel)] flex flex-col h-full w-full">
      {/* Header */}
      <div className="bg-[var(--bg-panel)] border-b border-[var(--border-main)] px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-orange-500/10 rounded-md text-orange-600">
            <Bot size={14} className={isLoading ? "animate-pulse" : ""} />
          </div>
          <div>
            <h2 className="font-display font-bold text-xs text-[var(--text-main)] tracking-wide uppercase flex items-center gap-1.5">
              Joint-Agent
            </h2>
          </div>
        </div>
        <button
          type="button"
          onClick={onSmartFlash}
          disabled={!mcuPluggedIn || isSmartFlashing}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-orange-500/10 text-orange-500 hover:bg-orange-500 hover:text-white transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          title={mcuPluggedIn ? "Autonomously compile, debug, and flash the generated code to your microcontroller" : "Connect a board to use Smart Flash"}
        >
          <Zap size={12} className={isSmartFlashing ? "animate-pulse" : ""} />
          {isSmartFlashing ? "Flashing..." : "Smart Flash"}
        </button>
        </div>
      {/* Message Feed Canvas */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4 terminal-scrollbar bg-[var(--bg-panel)]">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col justify-center py-4">
            <div className="text-center space-y-4 mx-auto w-full">
              <div className="w-10 h-10 bg-[var(--bg-surface)] text-[var(--text-muted)] rounded-xl flex items-center justify-center mx-auto shadow-sm border border-[var(--border-light)]">
                <Bot size={20} />
              </div>
              <div className="space-y-1">
                <h3 className="font-display font-medium text-[var(--text-main)] text-sm">Autonomous IDE Agent</h3>
                <p className="text-[11px] text-[var(--text-muted)] leading-relaxed px-2">
                  I write code, generate dynamic schematics, and compile to your connected hardware autonomously.
                </p>
              </div>

              {/* Starter Quick Actions */}
              <div className="flex flex-col gap-2 pt-2">
                {starterPrompts.map((starter) => (
                  <button
                    key={starter.label}
                    onClick={() => onSendMessage(starter.prompt)}
                    className="p-3 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-left border border-[var(--border-main)] rounded-lg transition-all group duration-200"
                  >
                    <div className="text-[11px] font-semibold text-[var(--text-main)] group-hover:text-orange-600 transition mb-1">
                      {starter.label}
                    </div>
                    <div className="text-[9px] text-[var(--text-muted)] line-clamp-2 leading-snug">
                      {starter.prompt}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg, index) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed space-y-2.5 shadow-sm ${
                    msg.role === "user" ? "bg-[var(--bg-surface)] border border-[var(--border-main)] text-[var(--text-main)] rounded-br-none"
                      : "bg-[var(--bg-surface)] border border-[var(--border-main)] text-[var(--text-main)] rounded-bl-none"
                  }`}
                >
                  {/* Normal Text Content */}
                  <div className="prose prose-sm dark:prose-invert max-w-none break-words chat-prose">
                    <MessageMarkdown
                      content={msg.content}
                      chatMode={chatMode}
                      pendingAnswers={pendingAnswers}
                      onSaveAnswer={(question, answer) => setPendingAnswers((prev) => ({ ...prev, [question]: answer }))}
                    />
                  </div>
                  
                  {chatMode === "plan" && index === messages.length - 1 && msg.role === "assistant" && msg.isPlanResponse && (
                    <div className="mt-4 pt-3 border-t border-[var(--border-main)] space-y-3">
                      <p className="text-xs text-[var(--text-muted)] font-medium">Use the comment icons above to answer any clarifying questions, then proceed when ready:</p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            // Deliberately does NOT flip chatMode. The override
                            // below implements THIS message only; the session
                            // stays in plan mode so a follow-up question still
                            // gets a plan, and nothing implements until the user
                            // presses this button again.
                            const answerLines = Object.entries(pendingAnswers).map(([q, a]) => `Regarding: "${q}" -> ${a}`);
                            const message = answerLines.length > 0
                              ? `${answerLines.join("\n")}\nI have answered your questions above. Please proceed to implement the plan now.`
                              : "I have answered your questions. Please proceed to implement the plan now.";
                            onSendMessage(message, "implement");
                            setPendingAnswers({});
                          }}
                          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-xs font-bold shadow-sm transition flex items-center gap-1.5"
                        >
                          <Check size={14} /> Proceed to Implement
                        </button>
                      </div>
                    </div>
                  )}
                  

                  <div className={`flex items-center gap-1.5 mt-1 pt-1 opacity-70 hover:opacity-100 transition-opacity ${msg.role === "user" ? "justify-end text-[var(--text-muted)]" : "justify-start text-[var(--text-muted)]"}`}>
                    <button 
                       onClick={() => navigator.clipboard.writeText(msg.content)} 
                       className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition" 
                       title="Copy"
                    >
                       <Copy size={11} />
                    </button>
                    {msg.role === "user" && (
                      <button
                         onClick={() => setInput(msg.content)}
                         className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition"
                         title="Edit"
                      >
                         <PenTool size={11} />
                      </button>
                    )}
                  </div>

                  {/* AI Suggested Schematic & Code Card */}
                  {msg.role === "assistant" && msg.suggestedProjectUpdate && (
                    <div className="mt-2 space-y-2">
                      {chatMode !== "plan" && (
                        <div className="flex flex-col gap-3 p-3 bg-[var(--bg-root)] border border-[var(--border-main)] rounded-lg">
                          <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-semibold">Project Generated</span>
                          
                          {msg.suggestedProjectUpdate.components && msg.suggestedProjectUpdate.components.length > 0 && (
                             <div>
                               <span className="text-[10px] text-[var(--text-muted)] font-semibold">Hardware Requirements:</span>
                               <div className="flex flex-wrap gap-1 mt-1">
                                 {msg.suggestedProjectUpdate.components.map(c => (
                                    <span key={c.id} className="text-[9px] bg-[var(--bg-surface)] px-1.5 py-0.5 rounded border border-[var(--border-main)]">{c.label} ({c.value})</span>
                                 ))}
                               </div>
                             </div>
                          )}

                          {msg.suggestedProjectUpdate.connections && msg.suggestedProjectUpdate.connections.length > 0 && (
                             <div>
                               <span className="text-[10px] text-[var(--text-muted)] font-semibold">Hardware Architecture & Wiring:</span>
                               <div className="flex flex-col gap-1 mt-1">
                                 {msg.suggestedProjectUpdate.connections.map(c => (
                                    <div key={c.id} className="text-[10px] text-[var(--text-main)] flex items-center gap-1.5 bg-[var(--bg-surface)] px-2 py-1 rounded border border-[var(--border-main)] w-fit">
                                      <div className="w-1.5 h-1.5 rounded-full shadow-sm" style={{ backgroundColor: c.color || '#a855f7' }}></div>
                                      <span className="font-mono">{c.fromComponentId}[{c.fromPin}]</span>
                                      <span className="text-[var(--text-muted)]">→</span>
                                      <span className="font-mono">{c.toComponentId}[{c.toPin}]</span>
                                    </div>
                                 ))}
                               </div>
                             </div>
                          )}

                          <div className="flex items-center justify-end border-t border-[var(--border-main)] pt-2 mt-1">
                            {msg.suggestedProjectUpdate.code && (
                              <button
                                onClick={() => onApplyUpdate({ code: msg.suggestedProjectUpdate!.code })}
                                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-semibold transition flex items-center gap-1.5"
                              >
                                <Code size={14} /> Open Code
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                      <div className="bg-[var(--bg-root)] border border-[var(--border-main)] rounded-lg p-3 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1 text-[10px] text-orange-600 font-bold uppercase tracking-wider">
                            <Cpu size={12} /> Auto-Applied
                          </span>
                        </div>

                        {msg.suggestedProjectUpdate.description && (
                          <p className="text-[10px] text-[var(--text-muted)] leading-normal line-clamp-3">
                            {msg.suggestedProjectUpdate.description}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            ))}

            {isLoading && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="flex justify-start"
              >
                <div className="bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-xl rounded-bl-none px-4 py-3 flex items-center gap-2.5 text-xs text-[var(--text-muted)]">
                  <span>{chatMode === "plan" ? "Agent is thinking" : "Agent is building"}</span>
                  <span className="flex gap-0.5">
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="w-1 h-1 rounded-full bg-orange-500"
                        animate={{ y: [0, -3, 0], opacity: [0.4, 1, 0.4] }}
                        transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
                      />
                    ))}
                  </span>
                </div>
              </motion.div>
            )}
            <div ref={chatBottomRef} />
          </div>
        )}
      </div>

      {/* Input Form Box */}
      <form
        onSubmit={handleSubmit}
        className="bg-[var(--bg-root)] border-t border-[var(--border-main)] p-2 sm:p-3 flex items-center gap-1.5 sm:gap-2 shrink-0"
      >
        <button
          type="button"
          onClick={handleFileUpload}
          className="p-2 text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] rounded-md transition shrink-0"
          title="Add media"
        >
          <Plus size={16} />
        </button>
        <div className="flex-1 min-w-0 overflow-x-auto">
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${e.target.scrollHeight}px`;
              // To handle width auto-grow, we can let scrollWidth dictate if it exceeds 100%
              e.target.style.width = '100%';
              if (e.target.scrollWidth > e.target.clientWidth) {
                e.target.style.width = `${e.target.scrollWidth}px`;
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
                e.currentTarget.style.height = 'auto';
                e.currentTarget.style.width = '100%';
              }
            }}
            disabled={isLoading || isTranscribing}
            rows={3}
            className="chat-input w-full border rounded-md px-3 py-2 text-xs text-[var(--text-main)] focus:outline-none focus:border-orange-500 transition resize-none terminal-scrollbar overflow-hidden"
            placeholder={isTranscribing ? "Transcribing audio..." : "Ask Joint-Agent..."}
            style={{ minHeight: '64px', maxHeight: '384px', maxWidth: '150%' }}
          />
          {/* A failed transcription used to be invisible — it went to
              console.error only, so the mic looked simply broken. */}
          {voiceError && (
            <p className="mt-1 text-[10px] text-red-500 leading-snug flex items-start gap-1">
              <span className="flex-1">{voiceError}</span>
              <button type="button" onClick={() => setVoiceError("")} className="text-[var(--text-muted)] hover:text-[var(--text-main)] shrink-0" title="Dismiss">
                <X size={10} />
              </button>
            </p>
          )}
        </div>
        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors shrink-0">
          <input 
            type="checkbox" 
            checked={chatMode === "plan"} 
            onChange={(e) => setChatMode(e.target.checked ? "plan" : "implement")}
            className="rounded border-[var(--border-main)] bg-[var(--bg-surface)] text-orange-600 focus:ring-orange-500 focus:ring-offset-[var(--bg-panel)] w-3 h-3"
          />
          {/* "Mode" is dead weight on a phone — dropping it hands the width
              back to the textarea, which is the cramped element here. */}
          <span className="whitespace-nowrap">Plan<span className="hidden sm:inline"> Mode</span></span>
        </label>
        <button
          className={`p-2 rounded-md transition shrink-0 flex items-center justify-center ${isRecording ? 'text-red-500 bg-red-500/10' : 'text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)]'}`}
          title="Voice Command"
          onClick={toggleRecording}
        >
          {isRecording ? (
            <div className="flex items-center gap-0.5 h-4">
              {audioBars.map((v, i) => (
                <span
                  key={i}
                  className="w-0.5 rounded-full bg-red-500"
                  style={{ height: `${Math.max(3, Math.min(16, v * 16 + audioLevel * 6))}px`, transition: "height 60ms linear" }}
                />
              ))}
            </div>
          ) : (
            <Mic size={16} />
          )}
        </button>
        {isLoading ? (
          <button
            type="button"
            onClick={onStopGeneration}
            className="p-2 bg-red-600 hover:bg-red-500 text-white rounded-md transition shrink-0"
            title="Stop generation"
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() || isRecording}
            className="p-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-md transition shrink-0"
          >
            <Send size={14} />
          </button>
        )}
      </form>
    </div>
  );
}
