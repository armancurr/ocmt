import { selectModelCommand } from "./model-select";

export async function commitModelCommand(): Promise<void> {
  await selectModelCommand("commit");
}
