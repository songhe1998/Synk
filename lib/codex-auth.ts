import os from "os";
import path from "path";
import { readFile } from "fs/promises";

export function getCodexAuthPath() {
  return process.env.CODEX_AUTH_JSON_FILE || path.join(os.homedir(), ".codex", "auth.json");
}

export async function readCodexAuthJson() {
  if (process.env.CODEX_AUTH_JSON) {
    return process.env.CODEX_AUTH_JSON;
  }

  if (process.env.CODEX_AUTH_JSON_B64) {
    return Buffer.from(process.env.CODEX_AUTH_JSON_B64, "base64").toString("utf8");
  }

  try {
    return await readFile(getCodexAuthPath(), "utf8");
  } catch {
    throw new Error("Codex auth.json is not configured. Sign in on this worker or set CODEX_AUTH_JSON(_B64|_FILE).");
  }
}

