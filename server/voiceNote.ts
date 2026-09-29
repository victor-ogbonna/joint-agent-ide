/**
 * Voice notes are capped at 2 minutes. The app stops recording there on its
 * own; this is the server's side of it, so a modified client cannot send an
 * hour of audio to be transcribed on our key.
 */
export const MAX_VOICE_NOTE_SECONDS = 120;
/** Slack for the recorder's last buffer and encoding, so a note stopped at 2:00 is never refused. */
const GRACE_SECONDS = 10;
/** Anything that is not WAV cannot be measured from its header; bound it by size instead. */
const MAX_UNMEASURED_BASE64 = 16 * 1024 * 1024;

/**
 * How long a base64 voice note plays, from its WAV header. The app always
 * sends 16-bit PCM WAV (see encodeAsWav in src/components/AgentChat.tsx), so
 * length = data bytes / byte rate. Null when it cannot be measured.
 */
export function voiceNoteSeconds(base64: string, mimeType: string | undefined): number | null {
  if (!/wav/i.test(mimeType || "")) return null;
  const head = Buffer.from(base64.slice(0, 64), "base64");
  if (head.length < 44 || head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return null;
  const byteRate = head.readUInt32LE(28);
  if (!byteRate) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  return Math.max(0, bytes - 44) / byteRate;
}

/** Whether a voice note is over the cap. */
export function voiceNoteTooLong(base64: string, mimeType: string | undefined): boolean {
  const seconds = voiceNoteSeconds(base64, mimeType);
  if (seconds === null) return base64.length > MAX_UNMEASURED_BASE64;
  return seconds > MAX_VOICE_NOTE_SECONDS + GRACE_SECONDS;
}
