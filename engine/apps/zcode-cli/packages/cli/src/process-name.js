export const CLI_COMMAND_NAME = "comecode";
export const CLI_PROCESS_NAME = "comecode-cli";
export const setCliProcessTitle = (target = process) => {
    target.title = CLI_PROCESS_NAME;
};
