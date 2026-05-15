import { selectModelCommand } from "./model-select";

export async function changelogModelCommand(): Promise<void> {
  await selectModelCommand("changelog");
}
