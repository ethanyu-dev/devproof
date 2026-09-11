/** Reject actual prerequisites, not statements that explicitly forbid reuse. */
export function hasExternalCaseDependency(value: string) {
  return value
    .split(/[。；;，,\n]|但是|然而|不过|随后|然后|并且|同时|但|且/u)
    .some((clause) => {
      if (
        /(?:已了解|已掌握).*(?:操作路径|操作流程)/u.test(clause) &&
        !/(?:不要求|无需|无须|不需要).*(?:已了解|已掌握)/u.test(clause)
      )
        return true;
      const reference =
        /\bcase\s*[-#]?\s*\d+|用例\s*[一二三四五六七八九十\d]+|(?:其他|其它|前一|另一个)(?:\s*Case|用例)/iu.exec(
          clause,
        );
      if (!reference) return false;
      const before = clause.slice(0, reference.index);
      if (
        /(?:不依赖|不使用|不复用|不要求|无需|无须|不需要|不等待|不要依赖|不得使用|不能依赖|禁止复用)[^。；;]*$/u.test(
          before,
        )
      )
        return false;
      const after = clause.slice(reference.index + reference[0].length);
      if (
        /^[^。；;]*(?:不作为|不是|并非)(?:本用例的?)?(?:前提|前置条件|依赖)/u.test(
          after,
        )
      )
        return false;
      return /依赖|使用|复用|基于|要求|已完成|已通过|已成功|已创建|已执行|提供|创建|完成.*后|通过.*后/u.test(
        clause,
      );
    });
}
