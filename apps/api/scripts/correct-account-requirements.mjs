#!/usr/bin/env node
/** Uses the explicitly configured DATABASE_URL. Preview never changes application data. */
import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { specificationDefinitionHash } from "@devproof/test-domain";
import { correctAccountRequirements } from "../dist/task-executions/correct-account-requirements.js";
const { values } = parseArgs({
  options: {
    task: { type: "string" },
    team: { type: "string" },
    file: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL for the intended environment.");
if (
  (!values.file && (!values.task || !values.team)) ||
  (values.apply && !values.file)
)
  throw new Error(
    "Preview: --team UUID --task UUID. Validate a reviewed correction: --file correction.json. Apply that file: --file correction.json --apply.",
  );
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
try {
  if (values.file) {
    console.log(
      JSON.stringify(
        await correctAccountRequirements(
          db,
          JSON.parse(await readFile(values.file, "utf8")),
          values.apply,
        ),
        null,
        2,
      ),
    );
  } else {
    const task = await db.taskExecution.findFirstOrThrow({
      where: { id: values.task, teamId: values.team },
      select: {
        id: true,
        lifecycle: true,
        cancelRequestedAt: true,
        caseExecutions: {
          include: { testCase: true },
          orderBy: [{ executionOrdinal: "desc" }],
        },
      },
    });
    console.log(
      JSON.stringify(
        {
          taskId: task.id,
          lifecycle: task.lifecycle,
          cancelled: Boolean(task.cancelRequestedAt),
          cases: task.caseExecutions.map((row) => ({
            caseExecutionId: row.id,
            name: row.testCase.name,
            snapshotId: row.testCase.snapshotId,
            definitionHash: specificationDefinitionHash(
              row.testCase.definition,
            ),
            expectedRevision: row.testAccountPlan?.revision,
            runId: row.runId,
            dispatchStatus: row.dispatchStatus,
            requirements: row.testAccountPlan?.requirements ?? [],
          })),
        },
        null,
        2,
      ),
    );
  }
} finally {
  await db.$disconnect();
}
