/**
 * 浏览器验证执行 Agent 的 system prompt 装配器。
 *
 * prompt 由 guidance/ 下的模块按固定顺序拼接：每个模块是一段可独立评审的
 * 运行约束，注入与否由 BrowserGuidanceContext 决定。顺序即最终 prompt 的
 * 段落顺序，与历史整体 prompt 保持一致（按行对应）。
 *
 * 观测：执行器把本次注入的模块 id 写入 agent.segment.started 事件的
 * promptSections，供人按 id 检索该段约束，不必通读整段 prompt。
 */
import type { BrowserGuidanceContext, GuidanceSection } from "./types.js";
import { core_identity, core_real_page, core_scope } from "./core.js";
import { tool_surface_grouped } from "./tool-surface.js";
import {
  working_state_cleanup,
  working_state_observations,
  working_state_page,
  working_state_pagination,
  working_state_popup_target,
  working_state_prerequisites,
  working_state_records,
  working_state_ref_validity,
} from "./working-state.js";
import { submission_citations, submission_criteria } from "./submission.js";
import {
  observation_async_completion,
  observation_coverage,
  observation_navigation_wait,
  observation_snapshot,
  observation_viewport_image,
} from "./observation.js";
import {
  interaction_dropdown_search,
  interaction_scroll,
  interaction_scroll_errors,
  interaction_select_dropdown,
} from "./interaction.js";
import {
  recovery_locator_token,
  recovery_progress,
  recovery_stale_refs,
} from "./recovery.js";
import { network_reference_only } from "./network-evidence.js";
import {
  accounts_data_precondition,
  accounts_identity_boundary,
  accounts_request_shape,
  accounts_slots,
  accounts_test_account,
} from "./accounts.js";
import { business_checks_v3 } from "./business-checks-v3.js";
import { legacy_contract_v2 } from "./legacy-contract-v2.js";
import {
  action_feedback,
  action_feedback_diagnostics,
} from "./action-feedback.js";
import { budget_time, budget_tool_calls } from "./budget.js";
import { terminal_rules } from "./terminal.js";

/** 全部指导模块，按注入顺序排列；顺序即最终 prompt 的段落顺序。 */
export const browserGuidanceSections: readonly GuidanceSection[] = [
  core_identity,
  core_scope,
  core_real_page,
  tool_surface_grouped,
  working_state_records,
  working_state_prerequisites,
  working_state_cleanup,
  working_state_observations,
  working_state_page,
  working_state_pagination,
  working_state_popup_target,
  working_state_ref_validity,
  submission_criteria,
  observation_navigation_wait,
  observation_async_completion,
  observation_snapshot,
  observation_viewport_image,
  interaction_select_dropdown,
  observation_coverage,
  interaction_scroll,
  interaction_scroll_errors,
  interaction_dropdown_search,
  recovery_stale_refs,
  recovery_locator_token,
  network_reference_only,
  submission_citations,
  accounts_slots,
  accounts_identity_boundary,
  accounts_request_shape,
  accounts_test_account,
  accounts_data_precondition,
  business_checks_v3,
  legacy_contract_v2,
  recovery_progress,
  action_feedback,
  action_feedback_diagnostics,
  budget_tool_calls,
  budget_time,
  terminal_rules,
];

/** 当前上下文下实际注入的模块。 */
export function includedGuidanceSections(
  ctx: BrowserGuidanceContext,
): readonly GuidanceSection[] {
  return browserGuidanceSections.filter(
    (section) => !section.include || section.include(ctx),
  );
}

/** 组装浏览器验证执行 Agent 的完整 system prompt。 */
export function browserSystemPrompt(ctx: BrowserGuidanceContext): string {
  return includedGuidanceSections(ctx)
    .map((section) => section.content)
    .join("\n");
}
