import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const SKILL_API_KEY_PLACEHOLDER =
  "<ask-user-for-a-valid-api-key-in-chat-and-store-it-here-when-auto-discovery-does-not-apply>";

function detectLineEnding(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function frontmatterMatch(content) {
  return content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
}

export function resolveSkillDir(env = process.env) {
  if (env.NIUCODES_IMAGE_GEN_SKILL_DIR) {
    return path.resolve(env.NIUCODES_IMAGE_GEN_SKILL_DIR);
  }

  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export async function readSkillMd(skillDir) {
  return readFile(path.join(skillDir, "SKILL.md"), "utf8");
}

export function upsertSkillApiKeyBanner(content, apiKey) {
  const frontmatter = frontmatterMatch(content);
  if (!frontmatter) {
    throw new Error("SKILL.md is missing valid YAML frontmatter.");
  }

  const lineEnding = detectLineEnding(content);
  const bannerLine = `API_KEY: ${apiKey}`;
  const startIndex = frontmatter[0].length;
  const remaining = content.slice(startIndex);

  if (remaining.startsWith("API_KEY:")) {
    const nextLineBreakIndex = remaining.search(/\r?\n/);
    if (nextLineBreakIndex === -1) {
      return `${content.slice(0, startIndex)}${bannerLine}`;
    }

    return `${content.slice(0, startIndex)}${bannerLine}${remaining.slice(nextLineBreakIndex)}`;
  }

  return `${content.slice(0, startIndex)}${bannerLine}${lineEnding}${remaining}`;
}

export function extractStoredSkillApiKey(content) {
  const frontmatter = frontmatterMatch(content);
  if (!frontmatter) {
    return undefined;
  }

  const remaining = content.slice(frontmatter[0].length);
  const firstLine = remaining.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine?.startsWith("API_KEY:")) {
    return undefined;
  }

  const apiKey = firstLine.slice("API_KEY:".length).trim();
  if (!apiKey || apiKey === SKILL_API_KEY_PLACEHOLDER) {
    return undefined;
  }

  return apiKey;
}

export async function readStoredSkillApiKey(env = process.env) {
  const skillDir = resolveSkillDir(env);
  const skillContent = await readSkillMd(skillDir);
  return extractStoredSkillApiKey(skillContent);
}

export async function writeStoredSkillApiKey(apiKey, options = {}) {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error("A non-empty API key is required.");
  }

  const skillDir = options.skillDir ?? resolveSkillDir(options.env);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const skillContent = await readFile(skillMdPath, "utf8");
  const updated = upsertSkillApiKeyBanner(skillContent, apiKey.trim());

  await writeFile(skillMdPath, updated);
  return skillMdPath;
}
