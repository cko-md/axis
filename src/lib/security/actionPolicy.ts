/**
 * Action taxonomy and approval policy — the deterministic core of the financial
 * safety kernel (docs/axis-redesign/05 / 07 security model; §11 of the program
 * prompt).
 *
 * Every action an agent or routine can take is classified into one of a small
 * set of classes with a default approval requirement. A pure policy function
 * then decides whether a specific action, in a specific context, may run
 * automatically or must be approved (optionally with step-up authentication).
 *
 * Keeping this pure and dependency-free means the same decision is reached in
 * the agent runtime, the API, and the UI, and the rules — especially the
 * prompt-injection combinatorial rule — are unit-testable rather than living in
 * prose.
 */

/** What an action does, ordered least to most privileged. */
export type ActionClass =
  | "READ" // read balances, transactions, filings, calendar
  | "DRAFT" // draft a memo, task, email, trade plan (not sent/applied)
  | "SIMULATE" // rebalance / tax / cash-flow scenario
  | "INTERNAL_WRITE" // add tag, update thesis status, resolve alert
  | "EXTERNAL_COMMUNICATION" // send email/Slack, share a report
  | "FINANCIAL_EXECUTION" // place trade, transfer money, pay a bill
  | "DESTRUCTIVE_ADMIN"; // delete data, revoke integration, disable audit log

/** How much authorization an action needs before it may run. */
export type ApprovalRequirement =
  | "auto" // may run automatically within granted scope
  | "approval" // requires explicit human approval
  | "approval_step_up"; // requires approval AND step-up authentication

/** Baseline requirement per class, before context escalation. */
export const BASE_REQUIREMENT: Readonly<Record<ActionClass, ApprovalRequirement>> = {
  READ: "auto",
  DRAFT: "auto",
  SIMULATE: "auto",
  INTERNAL_WRITE: "approval",
  EXTERNAL_COMMUNICATION: "approval",
  FINANCIAL_EXECUTION: "approval_step_up",
  DESTRUCTIVE_ADMIN: "approval_step_up",
};

/** Classes that reach outside the system or move money/state irreversibly. */
const OUTBOUND_OR_EXECUTION: ReadonlySet<ActionClass> = new Set([
  "EXTERNAL_COMMUNICATION",
  "FINANCIAL_EXECUTION",
  "DESTRUCTIVE_ADMIN",
]);

export type ActionContext = {
  /** The action's class. */
  actionClass: ActionClass;
  /** Reads private financial data (balances, positions, account numbers, PII). */
  touchesSensitiveData?: boolean;
  /**
   * Was influenced by untrusted external content (email body, web page,
   * attachment, third-party API text). Such content is data, never authority.
   */
  usesUntrustedExternalContent?: boolean;
  /**
   * The user (or routine policy) has explicitly pre-trusted this exact action
   * class for this context — e.g. an allowlisted internal write. Never applies
   * to financial execution or destructive admin.
   */
  explicitlyTrusted?: boolean;
};

export type ApprovalDecision = {
  requirement: ApprovalRequirement;
  /** Human-readable reasons, most significant first. Empty when plain-auto. */
  reasons: string[];
};

const RANK: Record<ApprovalRequirement, number> = {
  auto: 0,
  approval: 1,
  approval_step_up: 2,
};

function escalate(current: ApprovalRequirement, to: ApprovalRequirement): ApprovalRequirement {
  return RANK[to] > RANK[current] ? to : current;
}

/**
 * Decide the approval requirement for an action in context.
 *
 * Rules:
 * - Start from the class baseline.
 * - **Combinatorial prompt-injection rule** (mandatory approval): if the action
 *   reaches outside the system or executes/destroys AND it both touches
 *   sensitive data and was influenced by untrusted external content, it must be
 *   approved. This is the "read an emailed instruction, then transfer money"
 *   confused-deputy pattern — treated as policy, not a prompt-engineering hope.
 * - `explicitlyTrusted` may downgrade an INTERNAL_WRITE to auto, but never
 *   financial execution, destructive admin, or an action caught by the
 *   combinatorial rule.
 */
export function decideApproval(context: ActionContext): ApprovalDecision {
  const reasons: string[] = [];
  let requirement = BASE_REQUIREMENT[context.actionClass];
  if (requirement !== "auto") {
    reasons.push(`${context.actionClass} defaults to "${requirement}".`);
  }

  const combinatorialRisk =
    OUTBOUND_OR_EXECUTION.has(context.actionClass) &&
    !!context.touchesSensitiveData &&
    !!context.usesUntrustedExternalContent;

  if (combinatorialRisk) {
    requirement = escalate(requirement, "approval");
    reasons.unshift(
      "Sensitive data + untrusted external content + an outbound/executing action — mandatory approval (prompt-injection containment).",
    );
  }

  const canDowngrade =
    context.explicitlyTrusted &&
    !combinatorialRisk &&
    context.actionClass !== "FINANCIAL_EXECUTION" &&
    context.actionClass !== "DESTRUCTIVE_ADMIN";

  if (canDowngrade && requirement === "approval") {
    requirement = "auto";
    reasons.length = 0;
    reasons.push(`${context.actionClass} explicitly pre-trusted for this context.`);
    return { requirement, reasons };
  }

  return { requirement, reasons };
}

/** Convenience: does this action require any human approval before running? */
export function requiresApproval(context: ActionContext): boolean {
  return decideApproval(context).requirement !== "auto";
}
