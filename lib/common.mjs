const ANSI_CSI_REGEX = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_REGEX = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function parsePositiveEnvInt(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

export function sanitizeDisplayText(value, { singleLine = false } = {}) {
  if (value === undefined || value === null) {
    return "";
  }
  let out = String(value)
    .replace(ANSI_OSC_REGEX, "")
    .replace(ANSI_CSI_REGEX, "")
    .replace(/\x1b/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  if (singleLine) {
    out = out.replace(/[\r\n\t]+/g, " ").trim();
  }
  return out;
}

