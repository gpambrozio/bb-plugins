/** The agent tools' names, unique across every bb plugin, so each starts with the plugin's own. */
export const TOOL = {
  threads: "diff_review_threads",
  comment: "diff_review_comment",
  generalComment: "diff_review_general_comment",
  reply: "diff_review_reply",
  resolve: "diff_review_resolve",
  dismiss: "diff_review_dismiss",
} as const;

export const TOOL_NAMES: string[] = Object.values(TOOL);

/** The key under which a run's thread carries its run id, in this plugin's thread metadata. */
export const RUN_METADATA_KEY = "diffReviewRunId";
