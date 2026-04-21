import path from "path";

const WEBSITE_PREVIEW_MIME_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

export function normalizeWebsitePreviewAssetPath(assetPath: string | string[] | null | undefined) {
  const joined = Array.isArray(assetPath) ? assetPath.join("/") : assetPath ?? "index.html";
  const sanitized = joined.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(`/${sanitized}`).replace(/^\/+/, "");

  if (!normalized || normalized === ".") {
    return "index.html";
  }

  if (normalized.startsWith("../") || normalized === "..") {
    return null;
  }

  return normalized;
}

export function getWebsitePreviewMimeType(assetPath: string) {
  return WEBSITE_PREVIEW_MIME_TYPES.get(path.extname(assetPath).toLowerCase()) ?? "application/octet-stream";
}
