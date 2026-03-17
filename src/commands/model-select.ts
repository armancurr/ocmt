import * as p from "@clack/prompts";
import color from "picocolors";
import {
  listAvailableModels,
  cleanup,
  type AvailableModel,
} from "../lib/opencode";
import {
  getChangelogModelPreference,
  getCommitModelPreference,
  setChangelogModelPreference,
  setCommitModelPreference,
} from "../lib/config";

type ModelTarget = "commit" | "changelog";

function isCurrentModel(model: AvailableModel, current?: { providerID: string; modelID: string }) {
  return (
    !!current &&
    model.providerID === current.providerID &&
    model.modelID === current.modelID
  );
}

export async function selectModelCommand(target: ModelTarget): Promise<void> {
  p.intro(color.bgCyan(color.black(` ${target}-model `)));

  try {
    const current = target === "commit"
      ? await getCommitModelPreference()
      : await getChangelogModelPreference();
    const models = await listAvailableModels();

    if (models.length === 0) {
      p.cancel("No active models available from OpenCode");
      cleanup();
      process.exit(1);
    }

    const selected = await p.select({
      message: `Choose a default model for ${target}:`,
      options: models.map((model) => {
        const hints: string[] = [];

        if (isCurrentModel(model, current)) {
          hints.push("current");
        }

        if (model.isProviderDefault) {
          hints.push("OpenCode default");
        }

        return {
          value: model.label,
          label: model.label,
          hint: hints.length > 0 ? hints.join(" • ") : model.name,
        };
      }),
      initialValue: current ? `${current.providerID}/${current.modelID}` : undefined,
    });

    if (p.isCancel(selected)) {
      p.cancel("Aborted");
      cleanup();
      process.exit(0);
    }

    const chosenModel = models.find((model) => model.label === selected);

    if (!chosenModel) {
      p.cancel("Selected model was not found");
      cleanup();
      process.exit(1);
    }

    const next = {
      providerID: chosenModel.providerID,
      modelID: chosenModel.modelID,
    };

    if (target === "commit") {
      await setCommitModelPreference(next);
    } else {
      await setChangelogModelPreference(next);
    }

    p.outro(
      color.green(
        `Saved ${target} model: ${chosenModel.providerID}/${chosenModel.modelID}`,
      ),
    );
    cleanup();
    process.exit(0);
  } catch (error: any) {
    p.cancel(error.message);
    cleanup();
    process.exit(1);
  }
}
