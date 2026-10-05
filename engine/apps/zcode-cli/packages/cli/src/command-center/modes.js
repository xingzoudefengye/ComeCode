const SWITCHABLE_COMMAND_CENTER_MODES = [
    "plan",
    "build",
    "edit",
    "yolo",
    "auto",
];
export function formatAvailableCommandCenterModes() {
    return SWITCHABLE_COMMAND_CENTER_MODES.join(", ");
}
export function isSwitchableCommandCenterMode(value) {
    return SWITCHABLE_COMMAND_CENTER_MODES.includes(value);
}
