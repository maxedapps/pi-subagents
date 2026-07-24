import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROFILE_KEYS = new Set(["name", "description"]);
const BUNDLED_PROFILE_DIRECTORY = fileURLToPath(new URL("../agents", import.meta.url));

export const MAX_PROFILE_DESCRIPTION_LENGTH = 256;
export const CHILD_ENV_MARKER = "PI_SUBAGENTS_CHILD";

export type ProfileName = string;

export interface Profile {
  readonly name: ProfileName;
  readonly description: string;
  readonly systemPrompt: string;
  readonly filePath: string;
}

export type ProfileCatalog = Readonly<Record<ProfileName, Profile>>;

export interface LoadProfileCatalogOptions {
  bundledDir?: string;
  userDir?: string;
}

export function isProfileName(value: unknown): value is ProfileName {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 64
    && PROFILE_NAME_PATTERN.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(filePath: string, message: string): never {
  throw new Error(`Invalid subagent profile ${filePath}: ${message}`);
}

function parseProfile(filePath: string): Profile {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(filePath, error instanceof Error ? error.message : String(error));
  }

  const { frontmatter, body } = parsed;
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    fail(filePath, "frontmatter must be a mapping");
  }
  const values = frontmatter as Record<string, unknown>;
  const unknownKeys = Object.keys(values).filter((key) => !PROFILE_KEYS.has(key)).sort(compareText);
  if (unknownKeys.length) fail(filePath, `unknown frontmatter key(s): ${unknownKeys.join(", ")}`);

  const name = values.name;
  if (!isProfileName(name)) fail(filePath, "name must be 1-64 characters of lowercase kebab-case");

  const description = values.description;
  if (typeof description !== "string" || !description.trim()) {
    fail(filePath, "description must be a non-empty string");
  }
  const trimmedDescription = description.trim();
  if (trimmedDescription.length > MAX_PROFILE_DESCRIPTION_LENGTH) {
    fail(filePath, `description must be at most ${MAX_PROFILE_DESCRIPTION_LENGTH} characters`);
  }

  const systemPrompt = body.trim();
  if (!systemPrompt) fail(filePath, "body must be a non-empty system prompt");

  return Object.freeze({
    name,
    description: trimmedDescription,
    systemPrompt,
    filePath,
  });
}

function loadLayer(directory: string, optional: boolean): Map<ProfileName, Profile> {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new Error(
      `Cannot load subagent profile directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const profiles = new Map<ProfileName, Profile>();
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (entry.name === "README.md" || !entry.name.endsWith(".md") || !entry.isFile()) continue;
    const profile = parseProfile(join(directory, entry.name));
    const duplicate = profiles.get(profile.name);
    if (duplicate) {
      throw new Error(
        `Duplicate subagent profile name ${profile.name} in ${duplicate.filePath} and ${profile.filePath}`,
      );
    }
    profiles.set(profile.name, profile);
  }
  return profiles;
}

export function defaultUserProfileDir(agentDir = getAgentDir()): string {
  return join(agentDir, "subagents", "agents");
}

export function loadProfileCatalog(options: LoadProfileCatalogOptions = {}): ProfileCatalog {
  const bundled = loadLayer(options.bundledDir ?? BUNDLED_PROFILE_DIRECTORY, false);
  const user = loadLayer(options.userDir ?? defaultUserProfileDir(), true);
  for (const [name, profile] of user) bundled.set(name, profile);

  const catalog = Object.create(null) as Record<ProfileName, Profile>;
  for (const name of [...bundled.keys()].sort(compareText)) catalog[name] = bundled.get(name)!;
  return Object.freeze(catalog);
}
