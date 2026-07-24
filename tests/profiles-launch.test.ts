import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CHILD_ENV_MARKER,
  isProfileName,
  loadProfileCatalog,
  MAX_PROFILE_DESCRIPTION_LENGTH,
} from "../src/profiles.ts";
import { buildChildArgv } from "../src/rpc-child.ts";

const bundledProfiles = fileURLToPath(new URL("../agents", import.meta.url));

async function directories(prefix = "profiles-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const bundledDir = join(root, "bundled");
  const userDir = join(root, "user");
  await mkdir(bundledDir);
  return { root, bundledDir, userDir };
}

function markdown(frontmatter: string, body = "System prompt") {
  return `---\n${frontmatter}\n---\n${body}\n`;
}

async function writeProfile(directory: string, filename: string, frontmatter: string, body?: string) {
  const path = join(directory, filename);
  await writeFile(path, markdown(frontmatter, body));
  return path;
}

const minimal = (name: string) => `name: ${name}\ndescription: ${name} description`;

test("bundled profiles expose only name/description/body with role guidance", async () => {
  const { root, userDir } = await directories();
  try {
    const catalog = loadProfileCatalog({ bundledDir: bundledProfiles, userDir });
    assert.deepEqual(Object.keys(catalog), ["research", "scout", "worker"]);

    const scout = catalog.scout!;
    assert.equal(scout.description, "Repository inspection and codebase questions");
    assert.equal(scout.filePath, join(bundledProfiles, "scout.md"));
    assert.match(scout.systemPrompt, /Do not modify files or delegate/);
    assert.match(scout.systemPrompt, /Never recursively delegate/);
    assert.match(scout.systemPrompt, /Parent owns every VCS operation/);

    const research = catalog.research!;
    assert.match(research.systemPrompt, /web research/i);
    assert.match(research.systemPrompt, /never invent sources/i);

    const worker = catalog.worker!;
    assert.match(worker.systemPrompt, /Never run version-control commands/);
    assert.match(worker.systemPrompt, /Parent owns authoritative full-diff review/);
    assert.match(worker.systemPrompt, /Never recursively delegate/);

    assert.equal(Object.isFrozen(catalog), true);
    assert.equal(Object.isFrozen(scout), true);
    assert.equal(CHILD_ENV_MARKER, "PI_SUBAGENTS_CHILD");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user overrides replace whole profiles deterministically", async () => {
  const { root, bundledDir, userDir } = await directories();
  try {
    await mkdir(userDir);
    await writeProfile(bundledDir, "z.md", minimal("zeta"));
    await writeProfile(bundledDir, "a.md", minimal("shared"), "Bundled prompt");
    await writeProfile(userDir, "custom.md", minimal("alpha"), "Alpha prompt");
    const overridePath = await writeProfile(userDir, "override.md", "name: shared\ndescription: user replacement", "User prompt");

    const catalog = loadProfileCatalog({ bundledDir, userDir });
    assert.deepEqual(Object.keys(catalog), ["alpha", "shared", "zeta"]);
    assert.deepEqual(catalog.shared, {
      name: "shared",
      description: "user replacement",
      systemPrompt: "User prompt",
      filePath: overridePath,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery ignores README, non-Markdown entries, directories, and symlinks", async () => {
  const { root, bundledDir, userDir } = await directories();
  try {
    await writeProfile(bundledDir, "valid.md", minimal("valid"));
    await writeFile(join(bundledDir, "README.md"), markdown("not: a profile", "ignored"));
    await writeFile(join(bundledDir, "profile.txt"), markdown(minimal("text")));
    await mkdir(join(bundledDir, "directory.md"));
    await symlink(join(bundledDir, "valid.md"), join(bundledDir, "linked.md"));
    assert.deepEqual(Object.keys(loadProfileCatalog({ bundledDir, userDir })), ["valid"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unknown frontmatter and malformed profiles", async () => {
  const { root, bundledDir, userDir } = await directories();
  try {
    await writeProfile(bundledDir, "tools.md", `${minimal("bad")}\ntools:\n  - read`);
    assert.throws(
      () => loadProfileCatalog({ bundledDir, userDir }),
      /unknown frontmatter key\(s\): tools/,
    );

    await rm(join(bundledDir, "tools.md"));
    await writeProfile(bundledDir, "model.md", `${minimal("bad")}\nmodel: x/y`);
    assert.throws(
      () => loadProfileCatalog({ bundledDir, userDir }),
      /unknown frontmatter key\(s\): model/,
    );

    await rm(join(bundledDir, "model.md"));
    await writeProfile(bundledDir, "empty.md", minimal("empty"), "   ");
    assert.throws(
      () => loadProfileCatalog({ bundledDir, userDir }),
      /body must be a non-empty system prompt/,
    );

    await rm(join(bundledDir, "empty.md"));
    await writeProfile(bundledDir, "long.md", `name: long\ndescription: ${"x".repeat(MAX_PROFILE_DESCRIPTION_LENGTH + 1)}`);
    assert.throws(
      () => loadProfileCatalog({ bundledDir, userDir }),
      /description must be at most/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile-name validation accepts only safe bounded lowercase kebab-case", () => {
  for (const value of ["a", "a1", "a-b", "a".repeat(64), "scout"]) assert.equal(isProfileName(value), true, value);
  for (const value of ["", "A", "-a", "a-", "a--b", "a_b", "a/b", "a.b", "a b", "a".repeat(65), null, 1]) {
    assert.equal(isProfileName(value), false, String(value));
  }
});

test("child launch argv inherits model/thinking and omits capability suppressors", () => {
  const argv = buildChildArgv({
    systemPromptFile: "/tmp/system.md",
    parent: { model: "openai/gpt-5", thinking: "medium" },
  });
  assert.deepEqual(argv, [
    "--mode", "rpc",
    "--no-session",
    "--no-context-files",
    "--system-prompt", "/tmp/system.md",
    "--model", "openai/gpt-5",
    "--thinking", "medium",
  ]);
  const joined = argv.join(" ");
  assert.equal(joined.includes("--tools"), false);
  assert.equal(joined.includes("--no-skills"), false);
  assert.equal(joined.includes("--no-extensions"), false);
  assert.equal(joined.includes("--no-approve"), false);
});
