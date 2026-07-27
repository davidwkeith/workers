import { describe, it, expect, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDwkEnv } from "./env.js";

const STATIC_KEYS = [
  "DWK_BASE_URL",
  "FOO",
  "SECRET",
  "SHARED",
  "DOMAIN_ONLY",
  "GENERIC_ONLY",
  "PRESET",
  "A",
  "B",
] as const;

let saved: Record<string, string | undefined> = {};
const dirs: string[] = [];

function snapshot(): void {
  saved = {};
  for (const key of STATIC_KEYS) saved[key] = process.env[key];
}

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-env-"));
  dirs.push(dir);
  return dir;
}

function writeEnvFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

afterEach(() => {
  for (const key of STATIC_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("loadDwkEnv", () => {
  it("loads a plain .env when no domain is known", () => {
    snapshot();
    delete process.env.DWK_BASE_URL;
    const dir = workdir();
    writeEnvFile(dir, ".env", "FOO=bar\n");
    loadDwkEnv({ cwd: dir });
    expect(process.env.FOO).toBe("bar");
  });

  it("loads <domain>.env when DWK_BASE_URL is already set", () => {
    snapshot();
    process.env.DWK_BASE_URL = "https://pod.example.com";
    const dir = workdir();
    writeEnvFile(dir, "pod.example.com.env", "SECRET=xyz\n");
    loadDwkEnv({ cwd: dir });
    expect(process.env.SECRET).toBe("xyz");
  });

  it("prefers <domain>.env over .env for overlapping keys, and fills gaps from .env", () => {
    snapshot();
    process.env.DWK_BASE_URL = "https://pod.example.com";
    const dir = workdir();
    writeEnvFile(dir, "pod.example.com.env", "SHARED=domain\nDOMAIN_ONLY=d\n");
    writeEnvFile(dir, ".env", "SHARED=generic\nGENERIC_ONLY=g\n");
    loadDwkEnv({ cwd: dir });
    expect(process.env.SHARED).toBe("domain");
    expect(process.env.DOMAIN_ONLY).toBe("d");
    expect(process.env.GENERIC_ONLY).toBe("g");
  });

  it("is a no-op when neither file exists", () => {
    snapshot();
    delete process.env.DWK_BASE_URL;
    const dir = workdir();
    expect(() => loadDwkEnv({ cwd: dir })).not.toThrow();
    expect(process.env.FOO).toBeUndefined();
  });

  it("never overwrites a real pre-set process.env value", () => {
    snapshot();
    delete process.env.DWK_BASE_URL;
    process.env.PRESET = "real-value";
    const dir = workdir();
    writeEnvFile(dir, ".env", "PRESET=file-value\n");
    loadDwkEnv({ cwd: dir });
    expect(process.env.PRESET).toBe("real-value");
  });

  it("prefers <domain>.env over .env even when DWK_BASE_URL is only known via .env", () => {
    snapshot();
    delete process.env.DWK_BASE_URL;
    const dir = workdir();
    writeEnvFile(
      dir,
      ".env",
      "DWK_BASE_URL=https://blog.example.org\nA=from-generic\nSHARED=generic\n",
    );
    writeEnvFile(dir, "blog.example.org.env", "B=from-domain\nSHARED=domain\n");
    loadDwkEnv({ cwd: dir });
    expect(process.env.DWK_BASE_URL).toBe("https://blog.example.org");
    expect(process.env.A).toBe("from-generic");
    expect(process.env.B).toBe("from-domain");
    expect(process.env.SHARED).toBe("domain");
  });
});
