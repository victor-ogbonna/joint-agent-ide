import type { GoogleGenAI } from "@google/genai";

// Gemini's explicit context caching lets a large, stable prompt prefix
// (system instruction + tool declarations) be uploaded once and referenced
// by ID on every subsequent call, instead of being re-sent — and re-billed
// at full price — on every single request. Real savings, but two hard
// constraints from Google's side, both confirmed empirically against the
// real API before this was wired in:
//   1. A minimum ~1024-token content size to even be eligible for caching.
//   2. On the Gemini API *free tier* specifically, cached-content storage
//      quota is zero — cache creation fails outright, always. This is not a
//      bug to route around; it only becomes usable on a billed API key.
// Given that, this module never risks the working, already-optimized inline
// path: it tries once per cache key, and on ANY failure (undersized content,
// free-tier quota, transient API error) it permanently stops trying for that
// key and callers fall back to sending the prompt inline exactly as they did
// before this module existed. No retry storms, no added latency once
// disabled, no behavior change for anyone not on a paid tier.

interface CacheEntry {
  name: string;
  expiresAt: number;
}

const cacheState = new Map<string, CacheEntry>();
const disabledKeys = new Set<string>();
const CACHE_TTL_SECONDS = 3600;

export async function getCachedContentName(
  ai: GoogleGenAI,
  key: string,
  model: string,
  systemInstruction: string,
  tools?: any
): Promise<string | null> {
  if (disabledKeys.has(key)) return null;

  const existing = cacheState.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.name;

  try {
    const cache = await ai.caches.create({
      model,
      config: { systemInstruction, tools, ttl: `${CACHE_TTL_SECONDS}s`, displayName: key },
    });
    if (!cache.name) throw new Error("cache created with no resource name");
    cacheState.set(key, { name: cache.name, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 - 60_000 });
    console.log(`[GeminiCache] Created cache "${key}" (${cache.usageMetadata?.totalTokenCount ?? "?"} tokens) — implement-mode requests for this board family will reuse it until it expires.`);
    return cache.name;
  } catch (err: any) {
    disabledKeys.add(key);
    console.warn(`[GeminiCache] Context caching unavailable for "${key}": ${err.message || err}. This is expected on the Gemini API free tier — falling back to sending the prompt inline, with no change in behavior.`);
    return null;
  }
}
