import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFileCb);

// Import after mocking
const { execLinear, withTempFile, _resetBinaryCache } = await import(
  "./linear-cli.js"
);

beforeEach(() => {
  _resetBinaryCache();
  vi.clearAllMocks();
});

describe("execLinear", () => {
  it("resolves with stdout and exitCode 0 on success", async () => {
    mockedExecFile.mockImplementation((_bin, _args, _opts, cb: any) => {
      cb(null, '{"id":"123"}', "");
      return undefined as any;
    });

    const result = await execLinear(["issue", "view", "ENG-1", "--json"]);
    expect(result).toEqual({
      stdout: '{"id":"123"}',
      stderr: "",
      exitCode: 0,
    });

    expect(mockedExecFile).toHaveBeenCalledWith(
      "linear",
      ["issue", "view", "ENG-1", "--json"],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
  });

  it("resolves with non-zero exitCode on process error", async () => {
    const error = Object.assign(new Error("exit 1"), { code: 1 });
    mockedExecFile.mockImplementation((_bin, _args, _opts, cb: any) => {
      cb(error, "", "Not found");
      return undefined as any;
    });

    const result = await execLinear(["issue", "view", "NOPE"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("Not found");
  });

  it("rejects on ENOENT (binary not found)", async () => {
    const error = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
    });
    mockedExecFile.mockImplementation((_bin, _args, _opts, cb: any) => {
      cb(error, "", "");
      return undefined as any;
    });

    await expect(execLinear(["issue", "view", "X"])).rejects.toThrow("ENOENT");
  });

  it("uses custom timeout", async () => {
    mockedExecFile.mockImplementation((_bin, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await execLinear(["issue", "view", "X"], { timeoutMs: 5000 });
    expect(mockedExecFile).toHaveBeenCalledWith(
      "linear",
      expect.any(Array),
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });
});

describe("withTempFile", () => {
  it("creates temp file, passes path, and cleans up", async () => {
    let capturedPath = "";
    let fileContent = "";

    await withTempFile("hello markdown", async (path) => {
      capturedPath = path;
      fileContent = await readFile(path, "utf-8");
    });

    expect(fileContent).toBe("hello markdown");
    expect(capturedPath).toContain("linear-cli-");
    expect(capturedPath).toContain("content.md");
    // File should be cleaned up
    expect(existsSync(capturedPath)).toBe(false);
  });

  it("cleans up even if fn throws", async () => {
    let capturedPath = "";

    await expect(
      withTempFile("data", async (path) => {
        capturedPath = path;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(existsSync(capturedPath)).toBe(false);
  });
});
