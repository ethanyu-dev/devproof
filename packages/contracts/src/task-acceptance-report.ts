import type { AcceptanceAssessment } from "./acceptance-assessment.js";

export type AcceptanceVerdict =
  "PASSED" | "FAILED" | "INCONCLUSIVE" | "PENDING";

export interface AcceptanceIssue {
  category:
    | "CONTEXT"
    | "PRODUCT"
    | "EVIDENCE"
    | "UNDETERMINED"
    | "COVERAGE"
    | "PRECONDITION"
    | "EXECUTION"
    | "CANCELLED"
    | "TIMEOUT";
  code: string;
  message: string;
  nextStep: string;
}

export interface AcceptanceCriterion {
  id: string;
  requirementId: string | null;
  description: string;
  required: boolean;
  verdict: AcceptanceVerdict;
  recordedVerdict: string | null;
  summary: string;
  evidence: Array<{
    id: string;
    ref: string;
    kind: string;
    downloadPath: string | null;
  }>;
  issues: AcceptanceIssue[];
}

export interface AcceptanceCase {
  caseId: string;
  name: string;
  deployment: string;
  targetUrl: string | null;
  runId: string | null;
  attemptNumber: number | null;
  executionOrdinal: number;
  lifecycle: string;
  executionDisposition: string | null;
  verdict: AcceptanceVerdict;
  criteria: AcceptanceCriterion[];
  issues: AcceptanceIssue[];
}

export interface TaskAcceptanceReport {
  version: 1 | 2;
  revision: string;
  generatedAt: string;
  taskId: string;
  title: string;
  sourceRef: string | null;
  scope: "REQUIREMENT" | "CASE" | "DIRECT";
  specificationId: string | null;
  sourceHash: string | null;
  pullRequestUrl: string | null;
  lifecycle: string;
  finishedAt: string | null;
  final: boolean;
  verdict: AcceptanceVerdict;
  aiAccepted: boolean;
  summary: string;
  assessment: AcceptanceAssessment;
  review?: {
    status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
    model: string | null;
    generatedAt: string | null;
    summary: string | null;
    releaseReason: string | null;
    focusAreas: Array<{
      criterionKey: string;
      impact: string;
      nextStep: string;
    }>;
    error: string | null;
  };
  coverageComplete: boolean;
  counts: {
    cases: Record<AcceptanceVerdict, number> & { total: number };
    criteria: Record<AcceptanceVerdict, number> & {
      total: number;
      required: number;
    };
  };
  requirements: Array<{
    id: string;
    description: string;
    sourceRef: string | null;
    verdict: AcceptanceVerdict;
    caseIds: string[];
    reason: string | null;
  }>;
  cases: AcceptanceCase[];
  issues: AcceptanceIssue[];
}
