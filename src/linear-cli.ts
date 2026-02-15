import { execFile as execFileCb } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TIMEOUT_MS = 30_000;

let cachedBinary: string | undefined;

export function resolveLinearBinary(): string {
  if (cachedBinary) return cachedBinary;

  // Look for the binary name — execFile searches $PATH automatically
  cachedBinary = "linear";
  return cachedBinary;
}

/** Reset cached binary (for testing). */
export function _resetBinaryCache(): void {
  cachedBinary = undefined;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function execLinear(
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<ExecResult> {
  const bin = resolveLinearBinary();
  const timeout = opts?.timeoutMs ?? TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    execFileCb(
      bin,
      args,
      { timeout, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // System-level errors (ENOENT, ETIMEDOUT, etc.) have string codes
          if (typeof code === "string") {
            reject(error);
            return;
          }
        }

        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : 0;

        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          exitCode,
        });
      },
    );
  });
}

export async function withTempFile<T>(
  content: string,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "linear-cli-"));
  const filePath = join(dir, "content.md");
  await writeFile(filePath, content, "utf-8");
  try {
    return await fn(filePath);
  } finally {
    await unlink(filePath).catch(() => {});
    // Best-effort cleanup of the temp dir
    const { rmdir } = await import("node:fs/promises");
    await rmdir(dir).catch(() => {});
  }
}
