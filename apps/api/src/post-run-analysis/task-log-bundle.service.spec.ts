import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildAnalysisSynopsis,
  buildStructuredEvidenceArchive,
  prepareJsonObjectStream,
  prepareStructuredEvidenceArchiveStream,
  sanitizeLogBundleValue,
} from "./task-log-bundle.service.js";

async function readStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("sanitizeLogBundleValue", () => {
  it("preserves runtime session logs while removing credentials and identifiers", () => {
    expect(
      sanitizeLogBundleValue({
        runtimeSession: {
          id: "runtime-session-secret",
          commands: [
            {
              payload: {
                headers: [{ name: "Cookie", value: "session=secret" }],
                profileKey: "profile-secret",
                url: "/home",
              },
            },
          ],
          events: [{ kind: "page.loaded" }],
          status: "RELEASED",
        },
        executionPolicy: {
          browser: {
            profile: { key: "persistent-profile-secret", mode: "PERSISTENT" },
          },
        },
        sessionId: "session-secret",
        token: "token-secret",
      }),
    ).toEqual({
      runtimeSession: {
        id: "[REDACTED]",
        commands: [
          {
            payload: {
              headers: [{ name: "Cookie", value: "[REDACTED]" }],
              profileKey: "[REDACTED]",
              url: "/home",
            },
          },
        ],
        events: [{ kind: "page.loaded" }],
        status: "RELEASED",
      },
      executionPolicy: {
        browser: {
          profile: { key: "[REDACTED]", mode: "PERSISTENT" },
        },
      },
      sessionId: "[REDACTED]",
      token: "[REDACTED]",
    });
  });

  it("redacts bearer tokens and sensitive URL parameters in free text", () => {
    const value = sanitizeLogBundleValue(
      "request Bearer abc.def and Cookie: session=secret; role=admin\nhttps://example.com/path?token=secret&view=full",
    );

    expect(value).not.toContain("abc.def");
    expect(value).not.toContain("session=secret");
    expect(value).not.toContain("token=secret");
    expect(value).toContain("view=full");
  });

  it("redacts cloud credentials and private keys from structured and free text", () => {
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const value = sanitizeLogBundleValue({
      accessKeyId: "AKIAEXAMPLE",
      environment: {
        privateKey,
        secretAccessKey: "secret-access-key-value",
      },
      output: `privateKey=${privateKey}`,
    });

    expect(value).toEqual({
      accessKeyId: "[REDACTED]",
      environment: {
        privateKey: "[REDACTED]",
        secretAccessKey: "[REDACTED]",
      },
      output: "privateKey=[REDACTED]",
    });
    expect(JSON.stringify(value)).not.toContain("AKIAEXAMPLE");
    expect(JSON.stringify(value)).not.toContain("secret-access-key-value");
    expect(JSON.stringify(value)).not.toContain("cHJpdmF0ZS1rZXktbWF0ZXJpYWw");
  });
});

describe("buildStructuredEvidenceArchive", () => {
  it("indexes and streams a large structured record set without a full output buffer", async () => {
    const commands = Array.from({ length: 25_000 }, (_, index) => ({
      evidenceRef: `browser-command://command-${index}`,
      status: index % 100 === 0 ? "FAILED" : "SUCCEEDED",
    }));
    const evidenceRefs = commands.map((command) => command.evidenceRef);

    const archive = prepareStructuredEvidenceArchiveStream(
      {
        runEvents: [],
        task: {
          analysisSources: [],
          executionRuns: [
            {
              browserExecutions: [{ runtimeSession: { commands, events: [] } }],
              evidences: [],
            },
          ],
          taskEvents: [],
          toolInvocations: [],
        },
      },
      evidenceRefs,
    );
    const streamedHash = createHash("sha256");
    let streamedByteSize = 0;
    for await (const chunk of archive.openStream()) {
      const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      streamedByteSize += body.byteLength;
      streamedHash.update(body);
    }

    expect(Object.keys(archive.index)).toHaveLength(25_000);
    expect(archive.byteSize).toBe(
      commands.reduce(
        (total, command) =>
          total + Buffer.byteLength(JSON.stringify(command)) + 1,
        0,
      ),
    );
    expect(streamedByteSize).toBe(archive.byteSize);
    expect(streamedHash.digest("hex")).toBe(archive.sha256);
  }, 10_000);

  it("streams bundle and evidence bytes without changing their hashes or indexes", async () => {
    const bundle = {
      capturedAt: "2026-09-02T00:00:00.000Z",
      runEvents: [],
      task: {
        analysisSources: [],
        executionRuns: [
          {
            browserExecutions: [
              {
                runtimeSession: {
                  commands: [
                    {
                      evidenceRef: "browser-command://command-1",
                      result: { output: "你好" },
                      status: "SUCCEEDED",
                    },
                  ],
                  events: [],
                },
              },
            ],
            evidences: [],
          },
        ],
        taskEvents: [],
        toolInvocations: [],
      },
    };
    const preparedBundle = prepareJsonObjectStream(bundle);
    const streamedBundle = await readStream(preparedBundle.openStream());
    expect(streamedBundle.toString("utf8")).toBe(JSON.stringify(bundle));
    expect(preparedBundle.byteSize).toBe(streamedBundle.byteLength);
    expect(preparedBundle.sha256).toBe(
      createHash("sha256").update(streamedBundle).digest("hex"),
    );

    const evidenceRefs = ["browser-command://command-1"];
    const bufferedArchive = buildStructuredEvidenceArchive(
      bundle,
      evidenceRefs,
    );
    const streamedArchive = prepareStructuredEvidenceArchiveStream(
      bundle,
      evidenceRefs,
    );
    const streamedEvidence = await readStream(streamedArchive.openStream());
    expect(streamedEvidence).toEqual(bufferedArchive.body);
    expect(streamedArchive.index).toEqual(bufferedArchive.index);
    expect(streamedArchive.byteSize).toBe(streamedEvidence.byteLength);
    expect(streamedArchive.sha256).toBe(
      createHash("sha256").update(streamedEvidence).digest("hex"),
    );
  });
});

describe("buildAnalysisSynopsis", () => {
  it("prioritizes failures and bounds candidates per run", () => {
    const runId = "run-1";
    const commands = Array.from({ length: 10 }, (_, index) => ({
      createdAt: new Date(1_000 + index).toISOString(),
      error: { code: `COMMAND_${index}_FAILED` },
      evidenceRef: `browser-command://command-${index}`,
      status: "FAILED",
    }));
    const locations = commands.map((command) => ({
      attemptNumber: 1,
      evidenceRef: command.evidenceRef,
      runId,
      runtimeId: "runtime-1",
    }));

    const synopsis = buildAnalysisSynopsis(
      {
        runEvents: [],
        task: {
          executionRuns: [
            {
              browserExecutions: [{ runtimeSession: { commands, events: [] } }],
              evidences: [],
              lifecycle: "FAILED",
              verdict: "FAILED",
            },
          ],
          taskEvents: [],
          toolInvocations: [],
          verdict: "FAILED",
        },
      },
      locations,
      {
        browserExecutionsFinalized: true,
        durableEvents: true,
        evidenceMetadata: true,
      },
    );

    expect(synopsis).toMatchObject({
      candidateCount: 10,
      cleanPass: false,
      selectedCandidateCount: 6,
      strategy: "failure-first-v1",
      truncated: true,
    });
    expect(synopsis.candidates[0]).toMatchObject({
      evidenceRef: "browser-command://command-9",
      signal: "BROWSER_COMMAND_FAILED",
    });
  });

  it("marks a passed task without anomaly signals as a clean pass", () => {
    expect(
      buildAnalysisSynopsis(
        {
          runEvents: [],
          task: {
            executionRuns: [],
            taskEvents: [],
            toolInvocations: [],
            verdict: "PASSED",
          },
        },
        [],
        {
          browserExecutionsFinalized: true,
          durableEvents: true,
          evidenceMetadata: true,
        },
      ),
    ).toMatchObject({
      candidateCount: 0,
      cleanPass: true,
      completenessSufficient: true,
      selectedCandidateCount: 0,
    });
  });

  it("does not mark an incomplete passed capture as a clean pass", () => {
    expect(
      buildAnalysisSynopsis(
        {
          runEvents: [],
          task: {
            executionRuns: [],
            taskEvents: [],
            toolInvocations: [],
            verdict: "PASSED",
          },
        },
        [],
        {
          browserExecutionsFinalized: false,
          durableEvents: true,
          evidenceMetadata: false,
        },
      ),
    ).toMatchObject({
      candidateCount: 0,
      cleanPass: false,
      completenessSufficient: false,
      incompleteReasons: [
        "BROWSER_EXECUTIONS_NOT_FINALIZED",
        "EVIDENCE_METADATA_INCOMPLETE",
      ],
    });
  });
});
