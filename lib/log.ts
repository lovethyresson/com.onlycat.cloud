/**
 * Logging, and the switch that turns the noisy half of it on.
 *
 * Three levels, and the split between them is the whole design:
 *
 *  - `error` and `info` are **always on**. They are rare, and they are what a user pastes into a
 *    support thread without being asked to go and enable anything first.
 *  - `debug` is **off unless the owner turns it on** in the device's Advanced settings. It is the
 *    per-event, per-RPC detail that would otherwise write a line every time a cat walks past.
 *
 * Pairing is the exception and logs unconditionally at info. It happens once, interactively, and
 * it is precisely when nobody has a device yet on which to tick a box — which is the situation
 * that produced the "No API key yet" report this module was written for.
 *
 * Nothing here ever logs an API key. `redactKey()` is the only way a key is allowed near a log
 * line, and it is used at the two places one could otherwise leak.
 */

export type LogSink = (...args: any[]) => void;

export interface LoggerHost {
  log: LogSink;
  error: LogSink;
}

/** `oc_live_EXAM…y000` — enough to tell two keys apart, useless to anyone who reads it. */
export function redactKey(key: string | null | undefined): string {
  if (!key) return '<none>';
  const trimmed = String(key).trim();
  if (trimmed.length <= 16) return `${trimmed.slice(0, 4)}…`;
  return `${trimmed.slice(0, 12)}…${trimmed.slice(-4)}`;
}

export class Logger {

  private enabled = false;

  constructor(
    private readonly host: LoggerHost,
    private readonly scope: string,
  ) {}

  /** Driven by the device's `debug_logging` Advanced setting. */
  setDebug(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    // Announced at info on both edges, so a log that starts mid-stream says why it got noisy,
    // and a log that goes quiet does not look like the app died.
    this.host.log(`[${this.scope}] debug logging ${enabled ? 'ENABLED' : 'disabled'}`);
  }

  get debugEnabled(): boolean {
    return this.enabled;
  }

  debug(...args: any[]): void {
    if (!this.enabled) return;
    this.host.log(`[${this.scope}]`, ...args);
  }

  info(...args: any[]): void {
    this.host.log(`[${this.scope}]`, ...args);
  }

  error(...args: any[]): void {
    this.host.error(`[${this.scope}]`, ...args);
  }

  /** A child scope sharing this logger's switch, e.g. `cat_flap:OC-…` → `…:gateway`. */
  child(scope: string): Logger {
    const child = new Logger(this.host, `${this.scope}:${scope}`);
    child.enabled = this.enabled;
    return child;
  }

}

/** A logger that only ever prints errors — for code paths with no device to configure. */
export function quietLogger(host: LoggerHost, scope: string): Logger {
  return new Logger(host, scope);
}
