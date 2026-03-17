/**
 * OpenCode AI client for generating commit messages and changelogs
 *
 * Integrates with opencode.ai SDK for AI inference
 */

import * as p from "@clack/prompts";
import color from "picocolors";
import {
  createOpencode,
  createOpencodeClient,
  type Part,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import { exec } from "child_process";
import { promisify } from "util";
import {
  getChangelogConfig,
  getChangelogModelPreference,
  getCommitConfig,
  getCommitModelPreference,
  type ModelPreference,
} from "./config";

const execAsync = promisify(exec);

export interface AvailableModel extends ModelPreference {
  label: string;
  name: string;
  isProviderDefault: boolean;
}

type GenerationTarget = "commit" | "changelog";

// Server state
let clientInstance: OpencodeClient | null = null;
let serverInstance: { close: () => void } | null = null;

export interface CommitGenerationOptions {
  diff: string;
  context?: string;
}

export interface ChangelogGenerationOptions {
  commits: Array<{ hash: string; message: string }>;
  diff?: string;
  fromRef: string;
  toRef: string;
  version?: string | null;
}

export interface UpdateChangelogOptions {
  newChangelog: string;
  existingChangelog: string;
  changelogPath: string;
}

/**
 * Check if opencode CLI is installed
 */
async function isOpencodeInstalled(): Promise<boolean> {
  try {
    await execAsync("which opencode");
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if user is authenticated with opencode
 */
async function checkAuth(client: OpencodeClient): Promise<boolean> {
  try {
    const config = await client.config.get();
    return !!config;
  } catch {
    return false;
  }
}

/**
 * Get or create the OpenCode client
 * Tries to connect to existing server first, spawns new one if needed
 */
async function getClient(): Promise<OpencodeClient> {
  if (clientInstance) {
    return clientInstance;
  }

  // Try connecting to existing server first
  try {
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
    });
    // Test connection
    await client.config.get();
    clientInstance = client;
    return client;
  } catch {
    // No existing server, need to spawn one
  }

  // Check if opencode is installed
  if (!(await isOpencodeInstalled())) {
    p.log.error("OpenCode CLI is not installed");
    p.log.info(
      `Install it with: ${color.cyan("npm install -g opencode")} or ${color.cyan("brew install sst/tap/opencode")}`
    );
    process.exit(1);
  }

  // Spawn new server
  try {
    const opencode = await createOpencode({
      timeout: 10000,
    });

    clientInstance = opencode.client;
    serverInstance = opencode.server;

    // Check authentication
    if (!(await checkAuth(opencode.client))) {
      p.log.warn("Not authenticated with OpenCode");
      p.log.info(`Run ${color.cyan("opencode auth")} to authenticate`);
      process.exit(1);
    }

    // Clean up server on process exit
    process.on("exit", () => {
      serverInstance?.close();
    });
    process.on("SIGINT", () => {
      serverInstance?.close();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      serverInstance?.close();
      process.exit(0);
    });

    return opencode.client;
  } catch (error: any) {
    p.log.error(`Failed to start OpenCode server: ${error.message}`);
    p.log.info(`Make sure OpenCode is installed and configured correctly`);
    process.exit(1);
  }
}

/**
 * Extract text content from AI response parts
 */
function extractTextFromParts(parts: Part[]): string {
  const textParts = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

  return textParts.trim();
}

function getPromptErrorMessage(result: any): string | null {
  if (result?.error?.data?.message) {
    return result.error.data.message;
  }

  const responseError = result?.data?.info?.error;
  if (!responseError) {
    return null;
  }

  if (responseError.data?.message) {
    return responseError.data.message;
  }

  if (typeof responseError.message === "string") {
    return responseError.message;
  }

  if (typeof responseError.name === "string") {
    return responseError.name;
  }

  return "OpenCode returned an empty response";
}

async function deleteSession(client: OpencodeClient, sessionId: string): Promise<void> {
  try {
    await client.session.delete({ path: { id: sessionId } });
  } catch {
    // Ignore cleanup failures.
  }
}

function sortModels(models: AvailableModel[]): AvailableModel[] {
  return [...models].sort((a, b) => {
    if (a.isProviderDefault !== b.isProviderDefault) {
      return a.isProviderDefault ? -1 : 1;
    }

    return a.label.localeCompare(b.label);
  });
}

export async function listAvailableModels(): Promise<AvailableModel[]> {
  const client = await getClient();
  const providers = await client.config.providers();

  if (!providers.data) {
    throw new Error("Failed to load available models from OpenCode");
  }

  const defaults = providers.data.default || {};
  const models: AvailableModel[] = [];

  for (const provider of providers.data.providers || []) {
    for (const model of Object.values(provider.models || {})) {
      if (model.status !== "active") {
        continue;
      }

      models.push({
        providerID: provider.id,
        modelID: model.id,
        label: `${provider.id}/${model.id}`,
        name: model.name || model.id,
        isProviderDefault: defaults[provider.id] === model.id,
      });
    }
  }

  return sortModels(models);
}

export async function getConfiguredModel(
  target: GenerationTarget,
): Promise<ModelPreference | undefined> {
  const savedModel =
    target === "commit"
      ? await getCommitModelPreference()
      : await getChangelogModelPreference();

  if (!savedModel) {
    return undefined;
  }

  const availableModels = await listAvailableModels();
  const exists = availableModels.some(
    (model) =>
      model.providerID === savedModel.providerID &&
      model.modelID === savedModel.modelID,
  );

  if (!exists) {
    throw new Error(
      `Saved ${target} model ${savedModel.providerID}/${savedModel.modelID} is no longer available. Run ${target === "commit" ? "oc commit-model" : "oc changelog-model"} to choose a new one.`,
    );
  }

  return savedModel;
}

async function promptSession(
  client: OpencodeClient,
  sessionId: string,
  prompt: string,
  model?: ModelPreference,
): Promise<any> {
  return client.session.prompt({
    path: { id: sessionId },
    body: {
      ...(model ? { model } : {}),
      parts: [{ type: "text", text: prompt }],
    },
  });
}

/**
 * Generate a commit message from a git diff using OpenCode AI
 */
export async function generateCommitMessage(
  options: CommitGenerationOptions
): Promise<string> {
  const { diff, context } = options;

  const client = await getClient();
  const systemPrompt = await getCommitConfig();
  const model = await getConfiguredModel("commit");

  // Create a session for this commit
  const session = await client.session.create({
    body: { title: "oc-commit" },
  });

  if (!session.data) {
    throw new Error("Failed to create session");
  }

  try {
    let prompt = `${systemPrompt}\n\n---\n\nGenerate a commit message for the following diff:\n\n\`\`\`diff\n${diff}\n\`\`\``;

    if (context) {
      prompt += `\n\nAdditional context: ${context}`;
    }

    const result = await promptSession(client, session.data.id, prompt, model);

    const errorMessage = getPromptErrorMessage(result);
    if (errorMessage) {
      throw new Error(`Failed to generate commit message: ${errorMessage}`);
    }

    if (!result.data) {
      throw new Error("Failed to get AI response");
    }

    const message = extractTextFromParts(result.data.parts || []);

    if (!message) {
      throw new Error("OpenCode returned no text for the commit message");
    }

    return message
      .replace(/^```[\s\S]*?\n/, "")
      .replace(/\n```$/, "")
      .trim();
  } finally {
    await deleteSession(client, session.data.id);
  }
}

/**
 * Generate a changelog from commits using OpenCode AI
 */
export async function generateChangelog(
  options: ChangelogGenerationOptions
): Promise<string> {
  const { commits, fromRef, toRef, version } = options;

  const client = await getClient();
  const systemPrompt = await getChangelogConfig();
  const model = await getConfiguredModel("changelog");

  // Create a session for this changelog
  const session = await client.session.create({
    body: { title: "oc-changelog" },
  });

  if (!session.data) {
    throw new Error("Failed to create session");
  }

  // Build the commits list
  const commitsList = commits
    .map((c) => `- ${c.hash}: ${c.message}`)
    .join("\n");

  // Build version instruction
  let versionInstruction = "";
  if (version) {
    versionInstruction = `\n\nIMPORTANT: A version bump to ${version} was detected. Use "[${version}]" as the version header with today's date (format: YYYY-MM-DD), NOT "[Unreleased]".`;
  } else {
    versionInstruction = `\n\nUse "[Unreleased]" as the version header since no version bump was detected.`;
  }

  // Build the prompt
  const prompt = `${systemPrompt}\n\n---\n\nGenerate a changelog for the following commits (from ${fromRef} to ${toRef}):${versionInstruction}\n\n${commitsList}`;

  try {
    const result = await promptSession(client, session.data.id, prompt, model);

    const errorMessage = getPromptErrorMessage(result);
    if (errorMessage) {
      throw new Error(`Failed to generate changelog: ${errorMessage}`);
    }

    if (!result.data) {
      throw new Error("Failed to get AI response");
    }

    const changelog = extractTextFromParts(result.data.parts || []);

    if (!changelog) {
      throw new Error("OpenCode returned no text for the changelog");
    }

    return changelog.trim();
  } finally {
    await deleteSession(client, session.data.id);
  }
}

/**
 * Update an existing CHANGELOG.md file intelligently using AI
 * The AI will merge the new changelog content with existing content properly
 */
export async function updateChangelogFile(
  options: UpdateChangelogOptions
): Promise<string> {
  const { newChangelog, existingChangelog, changelogPath } = options;

  const client = await getClient();
  const model = await getConfiguredModel("changelog");

  // Create a session for this update
  const session = await client.session.create({
    body: { title: "oc-changelog-update" },
  });

  if (!session.data) {
    throw new Error("Failed to create session");
  }

  const prompt = `You are updating a CHANGELOG.md file. Your task is to intelligently merge new changelog entries into the existing file.

## Rules:
1. Preserve the existing file structure and header
2. Add the new changelog entry in the correct position (newest entries at the top, after the header)
3. Do not duplicate entries - if similar entries exist, keep the most detailed version
4. Maintain consistent formatting with the existing file
5. Keep the "Keep a Changelog" format if that's what the file uses
6. If there's an existing [Unreleased] section, merge into it or replace it with the new content
7. Return ONLY the complete updated file content, no explanations

## Existing CHANGELOG.md:
\`\`\`markdown
${existingChangelog}
\`\`\`

## New changelog entry to add:
\`\`\`markdown
${newChangelog}
\`\`\`

Return the complete updated CHANGELOG.md content:`;

  try {
    const result = await promptSession(client, session.data.id, prompt, model);

    const errorMessage = getPromptErrorMessage(result);
    if (errorMessage) {
      throw new Error(`Failed to update changelog: ${errorMessage}`);
    }

    if (!result.data) {
      throw new Error("Failed to get AI response");
    }

    let updatedChangelog = extractTextFromParts(result.data.parts || []);

    if (!updatedChangelog) {
      throw new Error("OpenCode returned no text for the changelog update");
    }

    updatedChangelog = updatedChangelog
      .replace(/^```markdown\n?/i, "")
      .replace(/^```\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    return updatedChangelog;
  } finally {
    await deleteSession(client, session.data.id);
  }
}

/**
 * Cleanup function to close the server if we spawned one
 */
export function cleanup(): void {
  serverInstance?.close();
  serverInstance = null;
  clientInstance = null;
}
