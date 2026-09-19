export const POLICY = Object.freeze({
  version: 3, activeMs: 1_800_000, repairs: 6, calls: 48, roleCalls: 16,
  concurrency: 2, inputPerCall: 20_000, inputTotal: 300_000,
  outputPerCall: 4_000, outputTotal: 80_000, jobMicros: 3_000_000,
  userDayMicros: 20_000_000, serviceDayMicros: 50_000_000,
  tools: 400, browserActions: 600, browserPasses: 7, external: 40,
  documentRequests: 160, documentPages: 24, sourceSelections: 3, analysisRecoveries: 2,
  modelMs: 90_000, commandMs: 120_000, readyMs: 3_600_000,
  waitingMs: 1_800_000, sandboxMinutes: 120,
  sandboxDailyMinutes: 10_000, maxSandboxes: 10,
});
// USD per million tokens = micro-USD per token. Reserve cache-write worst case.
// Official model pages checked 2026-09-19; stop automatically after review expiry.
export const PRICES = Object.freeze({
  // Dedicated GPU rental is billed by wall time, not tokens. Display separately.
  'qwen3.6:35b-a3b-q8_0': { input: 0, output: 0, billing: 'gpu-hour' },
  'nosana-sdxl': { input: 0, output: 0, billing: 'gpu-hour' },
  'gpt-5.6-luna': { input: .25, output: 1.2 },
  'gpt-5.6-terra': { input: 2.5, output: 12 },
  'gpt-5.6-sol': { input: 5, output: 20 },
  // Text-only image generation input; image output tokens. No input images accepted.
  'gpt-image-1-mini': { input: 2, output: 8 },
});
export const PRICE_REVIEW_UNTIL = '2026-11-21';
export const TERMINAL = new Set(['FAILED', 'UNSUPPORTED', 'CANCELLED', 'EXPIRED']);
export const PREPARING = new Set(['ANALYZING', 'PREPARING', 'VERIFYING', 'WAITING_FOR_USER']);
export class AppError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const fail = (code, message, status) => { throw new AppError(code, message, status); };
export const day = () => new Date().toISOString().slice(0, 10);
