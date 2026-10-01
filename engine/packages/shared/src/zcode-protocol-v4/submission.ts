import { z } from "zod";

/** Composer 可以显式提交的 Agent mode。auto 自己批准计划并跳过工具确认。 */
export const submissionModeSchema = z.enum(["build", "edit", "plan", "yolo", "auto"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
