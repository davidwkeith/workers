import { describe, it, expect, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadDwkEnv } from "./env.js";

const require = createRequire(import.meta.url);
const dotenvxCli = join(
  require.resolve("@dotenvx/dotenvx/package.json"),
  "..",
  "src/cli/dotenvx.js",
);

function encryptFile(dir: string, filename: string): void {
  execFileSync(
    "node",
    [
      dotenvxCli,
      "encrypt",
      "-f",
      filename,
      "--no-armor",
      "--no-native",
      "--quiet",
    ],
    { cwd: dir },
  );
}

/** Extra env vars set mid-test (dynamic key names dotenvx assigns) to clean up. */
const dynamicKeys: string[] = [];

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
  "PLAIN",
  "SECRET_VALUE",
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
  for (const key of dynamicKeys.splice(0)) delete process.env[key];
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

  it("decrypts encrypted: values using whichever DOTENV_PRIVATE_KEY* name dotenvx assigns", () => {
    snapshot();
    process.env.DWK_BASE_URL = "https://pod.example.com";
    const dir = workdir();
    writeEnvFile(
      dir,
      "pod.example.com.env",
      "PLAIN=not-secret\nSECRET_VALUE=super-secret\n",
    );
    encryptFile(dir, "pod.example.com.env");

    // Read back whichever DOTENV_PUBLIC_KEY* name dotenvx actually assigned —
    // never assume one (see design spec §3: filename-derived naming isn't
    // meaningful for <domain>.env files).
    const encryptedFile = readFileSync(
      join(dir, "pod.example.com.env"),
      "utf8",
    );
    const publicKeyMatch = encryptedFile.match(/^(DOTENV_PUBLIC_KEY\w*)=/m);
    expect(publicKeyMatch).not.toBeNull();
    const publicKeyName = publicKeyMatch?.[1];
    expect(publicKeyName).toBeDefined();
    const privateKeyName = (publicKeyName || "DOTENV_PUBLIC_KEY").replace(
      "PUBLIC",
      "PRIVATE",
    );

    const keysFile = readFileSync(join(dir, ".env.keys"), "utf8");
    const privateKeyMatch = keysFile.match(
      new RegExp(`^${privateKeyName}=(.+)$`, "m"),
    );
    expect(privateKeyMatch).not.toBeNull();

    process.env[privateKeyName] = privateKeyMatch![1];
    dynamicKeys.push(privateKeyName);

    loadDwkEnv({ cwd: dir });
    expect(process.env.PLAIN).toBe("not-secret");
    expect(process.env.SECRET_VALUE).toBe("super-secret");
  });

  it("throws when an encrypted value has no matching private key available", () => {
    snapshot();
    process.env.DWK_BASE_URL = "https://pod.example.com";
    const dir = workdir();
    writeEnvFile(dir, "pod.example.com.env", "SECRET_VALUE=super-secret\n");
    encryptFile(dir, "pod.example.com.env");
    // No DOTENV_PRIVATE_KEY* in the real environment, and no .env.keys to
    // fall back to: decryption must fail loudly, not silently pass the
    // ciphertext through as the app's config value.
    rmSync(join(dir, ".env.keys"));
    expect(() => loadDwkEnv({ cwd: dir })).toThrow();
  });

  it("loads <domain>.env as a fallback layer when .env's DWK_BASE_URL is encrypted", () => {
    snapshot();
    delete process.env.DWK_BASE_URL;
    const dir = workdir();
    writeEnvFile(dir, ".env", "DWK_BASE_URL=https://blog.example.org\n");
    encryptFile(dir, ".env");
    const encryptedFile = readFileSync(join(dir, ".env"), "utf8");
    const publicKeyMatch = encryptedFile.match(/^(DOTENV_PUBLIC_KEY\w*)=/m);
    expect(publicKeyMatch).not.toBeNull();
    const privateKeyName = publicKeyMatch![1]!.replace("PUBLIC", "PRIVATE");
    const keysFile = readFileSync(join(dir, ".env.keys"), "utf8");
    const privateKeyMatch = keysFile.match(
      new RegExp(`^${privateKeyName}=(.+)$`, "m"),
    );
    expect(privateKeyMatch).not.toBeNull();
    process.env[privateKeyName] = privateKeyMatch![1]!;
    dynamicKeys.push(privateKeyName);

    writeEnvFile(dir, "blog.example.org.env", "B=from-domain\n");

    loadDwkEnv({ cwd: dir });
    expect(process.env.DWK_BASE_URL).toBe("https://blog.example.org");
    expect(process.env.B).toBe("from-domain");
  });

  it("does not error when peeking an encrypted .env with no private key available", () => {
    snapshot();
    delete process.env.DWK_BASE_URL;
    const dir = workdir();
    writeEnvFile(
      dir,
      ".env",
      "DWK_BASE_URL=https://blog.example.org\nA=plain\n",
    );
    encryptFile(dir, ".env");
    // Provide the real private key so the actual load() succeeds (this test
    // is about the peek path not erroring, not about decryption failing).
    const encryptedFile = readFileSync(join(dir, ".env"), "utf8");
    const publicKeyMatch = encryptedFile.match(/^(DOTENV_PUBLIC_KEY\w*)=/m);
    const privateKeyName = publicKeyMatch![1]!.replace("PUBLIC", "PRIVATE");
    const keysFile = readFileSync(join(dir, ".env.keys"), "utf8");
    const privateKeyMatch = keysFile.match(
      new RegExp(`^${privateKeyName}=(.+)$`, "m"),
    );
    process.env[privateKeyName] = privateKeyMatch![1]!;
    dynamicKeys.push(privateKeyName);

    expect(() => loadDwkEnv({ cwd: dir })).not.toThrow();
    expect(process.env.DWK_BASE_URL).toBe("https://blog.example.org");
  });
});
