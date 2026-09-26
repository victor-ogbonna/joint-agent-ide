/**
 * The conversation's context budget, and compacting it when it fills.
 *
 * The chat used to send only the last 16 messages and drop the rest without
 * a word, so a long session quietly forgot its own beginning — the board,
 * the pins, what had already been tried. Now the whole conversation is sent
 * against a token budget, the user can see how full it is, and when it
 * reaches AUTOCOMPACT_AT the older part is folded into a summary the agent
 * keeps, while the most recent messages stay word for word.
 */

/** Tokens a conversation may use. The model's own window is larger; this is
 *  the budget the app spends per request, which also bounds its cost. */
export const CONTEXT_BUDGET_TOKENS = Number(process.env.CHAT_CONTEXT_TOKENS) || 64000;
export const AUTOCOMPACT_AT = 0.98;
/** Messages kept verbatim after a compaction: the live thread of the task. */
export const KEEP_RECENT_MESSAGES = 6;

export interface ConversationMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  isContextSummary?: boolean;
}

/**
 * A deliberately cautious estimate, used only to decide BEFORE a request
 * whether to compact. What the user sees comes from the model's own count.
 * Code and punctuation-heavy text run nearer 3 characters per token than
 * English prose's 4, so 3 over-counts slightly, which errs toward compacting
 * a little early rather than overflowing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 3);
}

export function estimateConversation(systemText: string, messages: ConversationMessage[]): number {
  // A few tokens of framing per message on top of its text.
  return estimateTokens(systemText) + messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
}

/**
 * Whether this request must be compacted first, and where to split. Only
 * ever folds messages that come BEFORE the kept tail, and never folds when
 * there would be nothing older to fold.
 */
export function planCompaction(
  systemText: string,
  messages: ConversationMessage[],
  budget = CONTEXT_BUDGET_TOKENS,
): { compact: false } | { compact: true; older: ConversationMessage[]; recent: ConversationMessage[] } {
  if (estimateConversation(systemText, messages) < budget * AUTOCOMPACT_AT) return { compact: false };
  if (messages.length <= KEEP_RECENT_MESSAGES) return { compact: false };
  return {
    compact: true,
    older: messages.slice(0, -KEEP_RECENT_MESSAGES),
    recent: messages.slice(-KEEP_RECENT_MESSAGES),
  };
}

export const SUMMARY_INSTRUCTION =
  "You are compacting a conversation between a user and an AI agent that writes and flashes microcontroller firmware, " +
  "so the agent can continue it without the full transcript. Write a plain-text summary under 400 words. Keep: the " +
  "user's goals; the board and every component, pin and wiring decision; constraints and preferences the user stated " +
  "(including corrections such as 'use pins 16 and 17'); what was built; what failed and how it was fixed; anything " +
  "still open. Leave out pleasantries. Do not invent anything that is not in the transcript.";

export function transcriptOf(messages: ConversationMessage[]): string {
  return messages
    .map((m) => m.isContextSummary
      ? `[Earlier summary]\n${m.content}`
      : `${m.role === "user" ? "User" : "Agent"}: ${m.content}`)
    .join("\n\n");
}
