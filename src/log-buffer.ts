export type LogLevel = "log" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  msg: string;
  ts: number;
}

let _buffer: LogEntry[] = [];
let _maxSize = 200;
let _installed = false;

export function pushLog(level: LogLevel, msg: string): void {
  _buffer.push({ level, msg, ts: Date.now() });
  if (_buffer.length > _maxSize) {
    _buffer = _buffer.slice(_buffer.length - _maxSize);
  }
}

export function getRecentLogs(n?: number): LogEntry[] {
  if (!n || n >= _buffer.length) return [..._buffer];
  return _buffer.slice(_buffer.length - n);
}

export function clearLogBuffer(): void {
  _buffer = [];
}

export function installGlobalInterceptor(maxSize = 200): void {
  if (_installed) return;
  _installed = true;
  _maxSize = maxSize;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    pushLog("log", msg);
    origLog(...args);
  };

  console.warn = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    pushLog("warn", msg);
    origWarn(...args);
  };

  console.error = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    pushLog("error", msg);
    origError(...args);
  };
}

export function formatLogEntry(entry: LogEntry): string {
  const d = new Date(entry.ts);
  const ts = d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const prefix = entry.level === "error" ? "[ERR]" : entry.level === "warn" ? "[WRN]" : "[LOG]";
  return `${ts} ${prefix} ${entry.msg}`;
}
