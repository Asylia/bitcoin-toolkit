export function debugLog(enabled: boolean, message: string, context?: unknown): void {
  if (!enabled) return;
  if (context === undefined) console.log(message);
  else console.log(message, context);
}

export function debugError(enabled: boolean, message: string, context?: unknown): void {
  if (!enabled) return;
  if (context === undefined) console.error(message);
  else console.error(message, context);
}
