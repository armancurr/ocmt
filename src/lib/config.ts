/**
 * Configuration file management for oc
 *
 * Manages .oc config files in the repo root
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { git } from "../utils/git";

const CONFIG_DIR = ".oc";
const COMMIT_CONFIG_FILE = "config.md";
const CHANGELOG_CONFIG_FILE = "changelog.md";
const CONFIG_JSON_FILE = "config.json";
const LEGACY_MODEL_CONFIG_FILE = "models.json";

export interface ModelPreference {
  providerID: string;
  modelID: string;
}

export interface RepoConfig {
  commit: {
    autoAccept: boolean;
    autoStageAll: boolean;
    model?: ModelPreference;
  };
  changelog: {
    autoSave: boolean;
    outputFile: string;
    model?: ModelPreference;
  };
  release: {
    autoTag: boolean;
    autoPush: boolean;
    tagPrefix: string;
  };
  general: {
    confirmPrompts: boolean;
    verbose: boolean;
  };
}

type LegacyModelPreferences = {
  commitModel?: ModelPreference;
  changelogModel?: ModelPreference;
};

const DEFAULT_CONFIG: RepoConfig = {
  commit: {
    autoAccept: false,
    autoStageAll: false,
  },
  changelog: {
    autoSave: false,
    outputFile: "CHANGELOG.md",
  },
  release: {
    autoTag: false,
    autoPush: false,
    tagPrefix: "v",
  },
  general: {
    confirmPrompts: true,
    verbose: false,
  },
};

const DEFAULT_COMMIT_CONFIG = `# Commit Message Guidelines

Generate commit messages following the Conventional Commits specification.

## Format

\`\`\`
<type>: <description>

[optional body]
\`\`\`

## Types

- \`feat\`: A new feature
- \`fix\`: A bug fix
- \`docs\`: Documentation only changes
- \`style\`: Changes that do not affect the meaning of the code
- \`refactor\`: A code change that neither fixes a bug nor adds a feature
- \`perf\`: A code change that improves performance
- \`test\`: Adding missing tests or correcting existing tests
- \`chore\`: Changes to the build process or auxiliary tools

## Rules

1. Use lowercase for the type
2. No scope (e.g., use \`feat:\` not \`feat(api):\`)
3. Use imperative mood in description ("add" not "added")
4. Keep the first line under 72 characters
5. Do not end the description with a period
6. Only return the commit message, no explanations or markdown formatting
`;

const DEFAULT_CHANGELOG_CONFIG = `# Changelog Generation Guidelines

Generate a changelog from the provided commits.

## Format

Use the "Keep a Changelog" format (https://keepachangelog.com/).

## Structure

\`\`\`markdown
## [Version] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes in existing functionality

### Deprecated
- Soon-to-be removed features

### Removed
- Removed features

### Fixed
- Bug fixes

### Security
- Vulnerability fixes
\`\`\`

## Rules

1. Group commits by type (feat -> Added, fix -> Fixed, etc.)
2. Write in past tense ("Added" not "Add")
3. Include the commit hash in parentheses at the end of each entry
4. Keep descriptions concise but informative
5. Omit the version number and date - just use "Unreleased" as the heading
6. Skip empty sections
7. Only return the changelog content, no explanations
`;

async function getRepoRoot(): Promise<string> {
  return git("rev-parse --show-toplevel");
}

async function ensureConfigDir(): Promise<string> {
  const repoRoot = await getRepoRoot();
  const configDir = join(repoRoot, CONFIG_DIR);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  return configDir;
}

async function getConfigJsonPath(): Promise<string> {
  const configDir = await ensureConfigDir();
  return join(configDir, CONFIG_JSON_FILE);
}

async function getLegacyModelConfigPath(): Promise<string> {
  const configDir = await ensureConfigDir();
  return join(configDir, LEGACY_MODEL_CONFIG_FILE);
}

function isModelPreference(value: unknown): value is ModelPreference {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.providerID === "string" &&
    candidate.providerID.length > 0 &&
    typeof candidate.modelID === "string" &&
    candidate.modelID.length > 0
  );
}

function normalizeLegacyModel(value: unknown): ModelPreference | undefined {
  if (isModelPreference(value)) {
    return value;
  }

  return undefined;
}

function normalizeConfig(value: unknown): RepoConfig {
  const input = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

  const commit =
    input.commit && typeof input.commit === "object"
      ? (input.commit as Record<string, unknown>)
      : {};
  const changelog =
    input.changelog && typeof input.changelog === "object"
      ? (input.changelog as Record<string, unknown>)
      : {};
  const release =
    input.release && typeof input.release === "object"
      ? (input.release as Record<string, unknown>)
      : {};
  const general =
    input.general && typeof input.general === "object"
      ? (input.general as Record<string, unknown>)
      : {};

  return {
    commit: {
      autoAccept:
        typeof commit.autoAccept === "boolean"
          ? commit.autoAccept
          : DEFAULT_CONFIG.commit.autoAccept,
      autoStageAll:
        typeof commit.autoStageAll === "boolean"
          ? commit.autoStageAll
          : DEFAULT_CONFIG.commit.autoStageAll,
      model: normalizeLegacyModel(commit.model),
    },
    changelog: {
      autoSave:
        typeof changelog.autoSave === "boolean"
          ? changelog.autoSave
          : DEFAULT_CONFIG.changelog.autoSave,
      outputFile:
        typeof changelog.outputFile === "string" && changelog.outputFile.length > 0
          ? changelog.outputFile
          : DEFAULT_CONFIG.changelog.outputFile,
      model: normalizeLegacyModel(changelog.model),
    },
    release: {
      autoTag:
        typeof release.autoTag === "boolean"
          ? release.autoTag
          : DEFAULT_CONFIG.release.autoTag,
      autoPush:
        typeof release.autoPush === "boolean"
          ? release.autoPush
          : DEFAULT_CONFIG.release.autoPush,
      tagPrefix:
        typeof release.tagPrefix === "string" && release.tagPrefix.length > 0
          ? release.tagPrefix
          : DEFAULT_CONFIG.release.tagPrefix,
    },
    general: {
      confirmPrompts:
        typeof general.confirmPrompts === "boolean"
          ? general.confirmPrompts
          : DEFAULT_CONFIG.general.confirmPrompts,
      verbose:
        typeof general.verbose === "boolean"
          ? general.verbose
          : DEFAULT_CONFIG.general.verbose,
    },
  };
}

function mergeLegacyModels(
  config: RepoConfig,
  legacy: LegacyModelPreferences,
): RepoConfig {
  return {
    ...config,
    commit: {
      ...config.commit,
      model: config.commit.model ?? legacy.commitModel,
    },
    changelog: {
      ...config.changelog,
      model: config.changelog.model ?? legacy.changelogModel,
    },
  };
}

async function readLegacyModelPreferences(): Promise<LegacyModelPreferences> {
  const legacyPath = await getLegacyModelConfigPath();

  if (!existsSync(legacyPath)) {
    return {};
  }

  try {
    const raw = JSON.parse(readFileSync(legacyPath, "utf-8")) as Record<
      string,
      unknown
    >;

    const commitModel = normalizeLegacyModel(raw.commitModel);
    const changelogModel = normalizeLegacyModel(raw.changelogModel);

    if (!commitModel && !changelogModel) {
      try {
        unlinkSync(legacyPath);
      } catch {
        // Ignore cleanup failures for malformed legacy config.
      }

      return {};
    }

    return {
      commitModel,
      changelogModel,
    };
  } catch {
    try {
      unlinkSync(legacyPath);
    } catch {
      // Ignore cleanup failures for malformed legacy config.
    }

    return {};
  }
}

async function writeRepoConfig(config: RepoConfig): Promise<void> {
  const configPath = await getConfigJsonPath();
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

async function cleanupLegacyModelFile(): Promise<void> {
  const legacyPath = await getLegacyModelConfigPath();

  if (existsSync(legacyPath)) {
    unlinkSync(legacyPath);
  }
}

export async function getRepoConfig(): Promise<RepoConfig> {
  const configPath = await getConfigJsonPath();
  let existing = DEFAULT_CONFIG;

  if (existsSync(configPath)) {
    try {
      existing = normalizeConfig(JSON.parse(readFileSync(configPath, "utf-8")));
    } catch {
      existing = DEFAULT_CONFIG;
    }
  }

  const legacyModels = await readLegacyModelPreferences();
  const merged = mergeLegacyModels(existing, legacyModels);

  if (
    !existsSync(configPath) ||
    legacyModels.commitModel ||
    legacyModels.changelogModel
  ) {
    await writeRepoConfig(merged);
    if (legacyModels.commitModel || legacyModels.changelogModel) {
      await cleanupLegacyModelFile();
    }
  }

  return merged;
}

export async function saveRepoConfig(config: RepoConfig): Promise<void> {
  await ensureConfigDir();
  await writeRepoConfig(config);
}

export async function updateRepoConfig(
  updater: (config: RepoConfig) => RepoConfig,
): Promise<RepoConfig> {
  const current = await getRepoConfig();
  const next = updater(current);
  await saveRepoConfig(next);
  return next;
}

export async function getCommitModelPreference(): Promise<ModelPreference | undefined> {
  const config = await getRepoConfig();
  return config.commit.model;
}

export async function getChangelogModelPreference(): Promise<ModelPreference | undefined> {
  const config = await getRepoConfig();
  return config.changelog.model;
}

export async function setCommitModelPreference(
  model: ModelPreference,
): Promise<void> {
  await updateRepoConfig((config) => ({
    ...config,
    commit: {
      ...config.commit,
      model,
    },
  }));
}

export async function setChangelogModelPreference(
  model: ModelPreference,
): Promise<void> {
  await updateRepoConfig((config) => ({
    ...config,
    changelog: {
      ...config.changelog,
      model,
    },
  }));
}

export async function getCommitConfig(): Promise<string> {
  const configDir = await ensureConfigDir();
  const configPath = join(configDir, COMMIT_CONFIG_FILE);

  if (!existsSync(configPath)) {
    writeFileSync(configPath, DEFAULT_COMMIT_CONFIG, "utf-8");
  }

  return readFileSync(configPath, "utf-8");
}

export async function getChangelogConfig(): Promise<string> {
  const configDir = await ensureConfigDir();
  const configPath = join(configDir, CHANGELOG_CONFIG_FILE);

  if (!existsSync(configPath)) {
    writeFileSync(configPath, DEFAULT_CHANGELOG_CONFIG, "utf-8");
  }

  return readFileSync(configPath, "utf-8");
}

export async function configExists(): Promise<boolean> {
  try {
    const repoRoot = await getRepoRoot();
    const configDir = join(repoRoot, CONFIG_DIR);
    return existsSync(join(configDir, COMMIT_CONFIG_FILE));
  } catch {
    return false;
  }
}
