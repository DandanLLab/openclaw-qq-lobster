import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";

export type PlatformType = "darwin" | "linux" | "win32" | "other";

export function getPlatform(): PlatformType {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "other";
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function getHomeDir(): string {
  try {
    const home = os.homedir();
    if (home && fs.existsSync(home)) return home;
  } catch {}

  const envHome = process.env.HOME || process.env.USERPROFILE;
  if (envHome && fs.existsSync(envHome)) return envHome;

  return os.tmpdir();
}

export function getQQBotDataDir(...subPaths: string[]): string {
  const dir = path.join(getHomeDir(), ".openclaw", "qq", ...subPaths);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getTempDir(): string {
  return os.tmpdir();
}

export function expandTilde(p: string): string {
  if (!p) return p;
  if (p === "~") return getHomeDir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(getHomeDir(), p.slice(2));
  }
  return p;
}

export function normalizePath(p: string): string {
  return expandTilde(p.trim());
}

export function sanitizeFileName(name: string): string {
  if (!name) return name;

  let result = name.trim();

  if (result.includes("%")) {
    try {
      result = decodeURIComponent(result);
    } catch {}
  }

  result = result.normalize("NFC");
  result = result.replace(/[\x00-\x1F\x7F]/g, "");

  return result;
}

export function isLocalPath(p: string): boolean {
  if (!p) return false;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) return true;
  if (p.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;
  if (p.startsWith("./") || p.startsWith("../")) return true;
  if (p.startsWith(".\\") || p.startsWith("..\\")) return true;
  return false;
}

export function looksLikeLocalPath(p: string): boolean {
  if (isLocalPath(p)) return true;
  return /^(?:Users|home|tmp|var|private|[A-Z]:)/i.test(p);
}

let _ffmpegPath: string | null | undefined;
let _ffmpegCheckPromise: Promise<string | null> | null = null;

export function detectFfmpeg(): Promise<string | null> {
  if (_ffmpegPath !== undefined) return Promise.resolve(_ffmpegPath);
  if (_ffmpegCheckPromise) return _ffmpegCheckPromise;

  _ffmpegCheckPromise = (async () => {
    const envPath = process.env.FFMPEG_PATH;
    if (envPath) {
      const ok = await testExecutable(envPath, ["-version"]);
      if (ok) {
        _ffmpegPath = envPath;
        console.log(`[platform] ffmpeg found via FFMPEG_PATH: ${envPath}`);
        return _ffmpegPath;
      }
      console.warn(`[platform] FFMPEG_PATH set but not working: ${envPath}`);
    }

    const cmd = isWindows() ? "ffmpeg.exe" : "ffmpeg";
    const ok = await testExecutable(cmd, ["-version"]);
    if (ok) {
      _ffmpegPath = cmd;
      console.log(`[platform] ffmpeg detected in PATH`);
      return _ffmpegPath;
    }

    const commonPaths = isWindows()
      ? [
          "C:\\ffmpeg\\bin\\ffmpeg.exe",
          path.join(process.env.LOCALAPPDATA || "", "Programs", "ffmpeg", "bin", "ffmpeg.exe"),
          path.join(process.env.ProgramFiles || "", "ffmpeg", "bin", "ffmpeg.exe"),
        ]
      : [
          "/usr/local/bin/ffmpeg",
          "/opt/homebrew/bin/ffmpeg",
          "/usr/bin/ffmpeg",
          "/snap/bin/ffmpeg",
        ];

    for (const p of commonPaths) {
      if (p && fs.existsSync(p)) {
        const works = await testExecutable(p, ["-version"]);
        if (works) {
          _ffmpegPath = p;
          console.log(`[platform] ffmpeg found at: ${p}`);
          return _ffmpegPath;
        }
      }
    }

    _ffmpegPath = null;
    return null;
  })().finally(() => {
    _ffmpegCheckPromise = null;
  });

  return _ffmpegCheckPromise;
}

function testExecutable(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

export function resetFfmpegCache(): void {
  _ffmpegPath = undefined;
  _ffmpegCheckPromise = null;
}

let _silkWasmAvailable: boolean | null = null;

export async function checkSilkWasmAvailable(): Promise<boolean> {
  if (_silkWasmAvailable !== null) return _silkWasmAvailable;

  try {
    const { isSilk } = await import("silk-wasm");
    isSilk(new Uint8Array(0));
    _silkWasmAvailable = true;
    console.log("[platform] silk-wasm: available");
  } catch (err) {
    _silkWasmAvailable = false;
    console.warn(`[platform] silk-wasm: NOT available (${err instanceof Error ? err.message : String(err)})`);
  }
  return _silkWasmAvailable;
}

export interface DiagnosticReport {
  platform: string;
  arch: string;
  nodeVersion: string;
  homeDir: string;
  tempDir: string;
  dataDir: string;
  ffmpeg: string | null;
  silkWasm: boolean;
  warnings: string[];
}

export async function runDiagnostics(): Promise<DiagnosticReport> {
  const warnings: string[] = [];

  const platform = `${process.platform} (${os.release()})`;
  const arch = process.arch;
  const nodeVersion = process.version;
  const homeDir = getHomeDir();
  const tempDir = getTempDir();
  const dataDir = getQQBotDataDir();

  const ffmpegPath = await detectFfmpeg();
  if (!ffmpegPath) {
    warnings.push(
      isWindows()
        ? "⚠️ ffmpeg 未安装。语音格式转换将受限。安装方式: choco install ffmpeg 或 scoop install ffmpeg"
        : getPlatform() === "darwin"
          ? "⚠️ ffmpeg 未安装。语音格式转换将受限。安装方式: brew install ffmpeg"
          : "⚠️ ffmpeg 未安装。语音格式转换将受限。安装方式: sudo apt install ffmpeg"
    );
  }

  const silkWasm = await checkSilkWasmAvailable();
  if (!silkWasm) {
    warnings.push("⚠️ silk-wasm 不可用。QQ 语音消息的收发将无法工作。请确认 Node.js 版本 >= 16 且 WASM 支持正常");
  }

  try {
    const testFile = path.join(dataDir, ".write-test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
  } catch {
    warnings.push(`⚠️ 数据目录不可写: ${dataDir}。请检查权限`);
  }

  if (isWindows()) {
    if (/[\u4e00-\u9fa5]/.test(homeDir) || homeDir.includes(" ")) {
      warnings.push(`⚠️ 用户目录包含中文或空格: ${homeDir}。某些工具可能无法正常工作`);
    }
  }

  const report: DiagnosticReport = {
    platform,
    arch,
    nodeVersion,
    homeDir,
    tempDir,
    dataDir,
    ffmpeg: ffmpegPath,
    silkWasm,
    warnings,
  };

  console.log("=== QQ Plugin 环境诊断 ===");
  console.log(`  平台: ${platform} (${arch})`);
  console.log(`  Node: ${nodeVersion}`);
  console.log(`  主目录: ${homeDir}`);
  console.log(`  数据目录: ${dataDir}`);
  console.log(`  ffmpeg: ${ffmpegPath ?? "未安装"}`);
  console.log(`  silk-wasm: ${silkWasm ? "可用" : "不可用"}`);
  if (warnings.length > 0) {
    console.log("  --- 警告 ---");
    for (const w of warnings) {
      console.log(`  ${w}`);
    }
  }
  console.log("==========================");

  return report;
}
