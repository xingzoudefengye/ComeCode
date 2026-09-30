import { providerSetupResponse } from "./provider-setup.js";
import type { CommandCenterApp } from "./command-center.js";

export function loginRequiredResponse(locale?: string): string {
  return providerSetupResponse(locale);
}

/** Registry already applies provider/account availability, including personal providers. */
export function createTuiModelAvailabilityChecker(
  getApp: () => Promise<CommandCenterApp>,
): () => Promise<boolean> {
  return async () => {
    const app = await getApp();
    return ((await app.listModels?.()) ?? []).some((model) => !model.disabledReason);
  };
}
