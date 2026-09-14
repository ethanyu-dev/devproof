# Spec generation with check references

The generator defines and validates acceptance checks before assembling Cases.
Cases reference those checks by ID, avoiding repeated generation of descriptions,
observation targets, evidence requirements and provenance during final corrections.
The persisted Spec and browser execution still receive the complete criteria.

## Workflow

1. Read the Issue, linked PR metadata, diffs and required implementation/Route Spec files.
2. Call `define_requirements` to establish the fixed requirement list and verbatim source basis.
3. Call `define_checks` in batches. Each check specifies `requirementId`, `description`,
   `observationTargets`, and optional `requiredEvidenceKinds` / `supportingSourceRefs`.
   The tool saves valid entries and returns their `checkId` and the new catalog revision.
4. Resubmit only invalid entries. To change a saved check, include its `checkId`
   and full check content. Every batch carries `expectedRevision` from the latest result.
5. Call `finish_spec` with Cases containing `name`, `steps`, and `checkIds`.
   The runtime expands the checks and validates source and requirement coverage before returning a Spec.

Example final model input after `check-1` and `check-2` have been saved:

```json
{
  "analysisSummary": "提交已校验的类型与样式标准。",
  "spec": {
    "summary": "验证旧版对公转账白名单配置",
    "cases": [
      {
        "name": "检查类型与配置样式",
        "steps": [
          "打开白名单配置，确认旧版对公转账和 ZDR 均可选择。",
          "分别打开两个类型的新增表单，对照配置区域的结构与交互。"
        ],
        "checkIds": ["check-1", "check-2"]
      }
    ]
  }
}
```

## Grounding and correction

Requirement evidence and UI evidence can come from different files. An Issue may
say “样式参考 ZDR” while the displayed text “零数据留存 (ZDR)” exists only in an i18n
file. The check explicitly lists that already-read file in `supportingSourceRefs`.
Expansion preserves the Issue quote as `basis` and includes both sources in the
criterion and Case. Every allowed target text must still appear in a bound source.
An observed source must also support the assertion semantically; a substring
match alone does not prove this relationship.

`define_checks` returns all independent issues within its batch, including
`inputIndex`, `requirementId`, optional `checkId`, `code`, `path`, `value`, and bound
or candidate source references when applicable. A failed update retains the
previous saved version. Identical submissions reuse their IDs. Catalog revisions
prevent stale updates; unknown IDs and requirement remapping are rejected.

Multiple business objects remain separate targets. Use their actual visible type
or region names to identify them during comparisons. Equivalent display variants
may use `alternatives`; opposite states such as enabled/disabled cannot be treated
as equivalent. Required screenshots and delivered per-object evidence are retained.

Checks can be reused only for the same object, condition and expected behavior.
Each Case expands to separate criterion IDs and must observe its own evidence.
The runtime does not transfer data or verdicts between Cases. Preconditions,
test data and cleanup remain available when needed. Any uncovered requirement
still needs an explicit reason; merely defining an unused check does not cover it.

## Rollout and limits

API claims select `CHECK_REFERENCES` for Agent protocol minor 19 or newer and
`COMPACT` for minor 18. Older full Spec and COMPACT parsing remain supported in the
worker. Final output uses the existing Spec schema, so there is no database
migration or Browser Runtime upgrade for this format change.

Saved checks live within one attempt. Worker-loss recovery starts a new catalog;
this change does not introduce durable draft checkpoints, parameterized Case
templates, or change browser evidence semantics. Final Case corrections still
resubmit the small Case document, while the checks remain saved.

Regression coverage includes the Issue/i18n source conflict, partial batch
acceptance, isolated updates, stale revisions, unknown/duplicate IDs, independent
expansion of shared checks, fixed requirement coverage, and protocol negotiation.
Live first-submission success rates and latency improvements require a separate
comparison using the same source fixtures, model and generation budget.
