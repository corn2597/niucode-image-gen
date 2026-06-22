import path from "node:path";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

function formatTimestamp(date = new Date()) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
  const timeParts = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ];
  return `${parts.join("")}-${timeParts.join("")}`;
}

function extensionForFormat(outputFormat) {
  return outputFormat === "jpeg" ? "jpg" : outputFormat;
}

function isDirectoryHint(rawPath) {
  return /[\\/]$/.test(rawPath);
}

function isRecognizedImageExtension(extension) {
  return [".png", ".jpg", ".jpeg", ".webp"].includes(extension.toLowerCase());
}

function applyExpectedExtension(targetPath, outputFormat) {
  const expectedExtension = `.${extensionForFormat(outputFormat)}`;
  const currentExtension = path.extname(targetPath);

  if (!currentExtension) {
    return `${targetPath}${expectedExtension}`;
  }

  if (isRecognizedImageExtension(currentExtension) && currentExtension.toLowerCase() !== expectedExtension) {
    throw new Error(
      `Output extension ${currentExtension} does not match outputFormat=${outputFormat}. ` +
        `Use ${expectedExtension} or omit the extension.`,
    );
  }

  return targetPath;
}

function safeSlug(value) {
  return value.replace(/[^a-z0-9-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function chooseAvailablePath(targetPath, overwrite) {
  if (overwrite || !(await pathExists(targetPath))) {
    return targetPath;
  }

  const directory = path.dirname(targetPath);
  const extension = path.extname(targetPath);
  const baseName = path.basename(targetPath, extension);

  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(directory, `${baseName}_${String(index).padStart(3, "0")}${extension}`);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }

  throw new Error(`Could not find an available output filename for ${targetPath}`);
}

export async function resolveOutputTargets({
  command,
  cwd,
  model,
  output,
  outputFormat,
  overwrite,
  count,
}) {
  const extension = extensionForFormat(outputFormat);
  const defaultName = `${safeSlug(model)}-${command}-${formatTimestamp()}.${extension}`;

  let baseTarget;
  if (!output) {
    baseTarget = path.resolve(cwd, "image-outputs", defaultName);
  } else {
    const resolved = path.resolve(cwd, output);
    const resolvedIsDirectory =
      (await pathExists(resolved)) && (await stat(resolved).then((entry) => entry.isDirectory()).catch(() => false));

    if (isDirectoryHint(output) || resolvedIsDirectory) {
      baseTarget = path.join(resolved, defaultName);
    } else {
      baseTarget = applyExpectedExtension(resolved, outputFormat);
    }
  }

  await mkdir(path.dirname(baseTarget), { recursive: true });
  const targets = [];

  const firstTarget = await chooseAvailablePath(baseTarget, overwrite);
  targets.push(firstTarget);

  const extensionName = path.extname(baseTarget);
  const stem = path.basename(baseTarget, extensionName);
  const directory = path.dirname(baseTarget);

  for (let index = 1; index < count; index += 1) {
    const candidate = path.join(directory, `${stem}_${String(index).padStart(3, "0")}${extensionName}`);
    targets.push(await chooseAvailablePath(candidate, overwrite));
  }

  return targets;
}

function markdownPath(absolutePath) {
  const normalized = absolutePath.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
}

async function saveImageItem(item, outputPath, timeoutMs) {
  if (item?.b64_json) {
    const buffer = Buffer.from(item.b64_json, "base64");
    await writeFile(outputPath, buffer);
    return outputPath;
  }

  if (item?.url) {
    const response = await fetch(item.url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Failed to download image from ${item.url}: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(outputPath, bytes);
    return outputPath;
  }

  throw new Error("Image API response item did not contain b64_json or url.");
}

export async function saveImageItems(apiResponse, outputTargets, timeoutMs) {
  const data = Array.isArray(apiResponse?.data) ? apiResponse.data : [];
  if (data.length === 0) {
    throw new Error("Image API response did not contain any data items.");
  }

  if (data.length > outputTargets.length) {
    throw new Error("More response images than resolved output paths.");
  }

  const savedPaths = [];
  for (let index = 0; index < data.length; index += 1) {
    const savedPath = await saveImageItem(data[index], outputTargets[index], timeoutMs);
    savedPaths.push({
      absolutePath: savedPath,
      revisedPrompt: data[index]?.revised_prompt ?? null,
    });
  }

  return savedPaths;
}

export function buildRenderables(savedItems, command) {
  return savedItems.map((item, index) => ({
    index,
    absolute_path: item.absolutePath,
    markdown_path: markdownPath(item.absolutePath),
    markdown: `![${command}-${index + 1}](${markdownPath(item.absolutePath)})`,
    revised_prompt: item.revisedPrompt,
  }));
}

export function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}
