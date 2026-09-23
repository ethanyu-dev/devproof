/**
 * 浏览器验证执行 Agent 的 system prompt 指导模块类型。
 *
 * prompt 被拆成可独立评审、按条件注入的 GuidanceSection：
 * - 每个模块回答一个具体运行问题（身份与范围、工作状态语义、观察与定位、
 *   账号与数据处置、预算与收尾等）；
 * - 人类按 id 检索和评审对应约束，不必通读整段 prompt；
 * - 执行器根据任务快照与运行模式计算注入条件（见 index.ts 装配逻辑）。
 */
export interface BrowserGuidanceContext {
  /** 有界上下文模式（默认）。LEGACY 模式省略结构化上下文说明。 */
  readonly bounded: boolean;
  /** 分组工具面：核心操作先露出，其他模块按需 enable_browser_tools。 */
  readonly groupedTools: boolean;
  /** 任务包含 observationContract.version=3（businessCheck）验收。 */
  readonly hasBusinessChecks: boolean;
  /** 任务包含 observationContract.version=2 验收。 */
  readonly hasObservationContractV2: boolean;
}

export interface GuidanceSection {
  /** 稳定标识，用于检索、注入开关与观测。 */
  readonly id: string;
  /** 一句话说明本模块约束什么，供人阅读。 */
  readonly description: string;
  /** 是否注入当前执行上下文。缺省恒注入；条件模块按任务快照/模式决定。 */
  include?(ctx: BrowserGuidanceContext): boolean;
  /** 注入正文。段落间以换行分隔；末尾 "\n" 表示与下一模块之间保留空行。 */
  readonly content: string;
}
