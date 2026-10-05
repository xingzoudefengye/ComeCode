import { providerSetupResponse } from "./provider-setup.js";
export function loginRequiredResponse(locale) {
    return providerSetupResponse(locale);
}
/** Registry already applies provider/account availability, including personal providers. */
export function createTuiModelAvailabilityChecker(getApp) {
    return async () => {
        const app = await getApp();
        return ((await app.listModels?.()) ?? []).some((model) => !model.disabledReason);
    };
}
