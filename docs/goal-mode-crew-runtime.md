# Jarvis Goal Mode crew runtime

Jarvis uses its existing Convex and Trigger state machine as the durable crew runtime. It borrows the useful production patterns from CrewAI without adding a second scheduler or a second source of truth.

Reference patterns:

- Hierarchical manager process: <https://docs.crewai.com/v1.15.18/en/concepts/processes>
- Task context, expected output, structured output, guardrails, and human input: <https://docs.crewai.com/v1.15.18/en/concepts/tasks>
- Stateful event-driven flows: <https://docs.crewai.com/v1.15.18/en/concepts/flows>

## Spoken start

Explicit commands such as these take the deterministic Goal Mode lane instead of relying on a foreground model to remember a tool call:

- `Make my Snuffelo Shopify website profitable.`
- `Start a team to repair the launch and prove every production journey.`
- `Keep working on the launch until the accepted target is met.`

Questions such as `How should I make the store profitable?` remain conversation. A normal one-feature request remains a single specialist task.

## Contract

Every accepted plan contains:

1. One measurable outcome: objective, primary metric, baseline, target, measurement window, authoritative evidence sources, and exact stop conditions.
2. One hierarchical crew charter: Jarvis manages delegation, escalation, and event-driven reporting.
3. Between one and eight necessary workstreams. One is valid; filler roles are invalid.
4. For each workstream: a typed deliverable, required evidence, explicit guardrails, dependencies, repository scope, and one permanent specialist identity.
5. Goal-level tests and live checks.

The specialist receives that contract at the start of its work order. The same deliverable, evidence, and guardrail fields are copied into the controller-owned definition of done so the supervisor cannot approve a narrative that ignored the plan.

## Collaboration

- A worker starts only after all declared dependency jobs have terminal signed handoffs.
- Downstream workers receive bounded, verified upstream evidence rather than another worker's raw mutable session.
- Every repository worker owns an isolated checkout and branch. The delivery controller alone serializes verified receipts into the mission integration branch.
- Workers checkpoint and retry in bounded segments. They do not poll to appear busy.
- Safe independent work continues before a protected decision is escalated.
- A real human decision becomes a durable Needs-you item tied to the exact mission/job; routine implementation questions are answered by Jarvis's supervisor.

## Completion

A passing validator must return both general evidence and measured outcome evidence. Convex independently requires:

- the accepted metric, target, and measurement window, exactly;
- at least two outcome-evidence entries;
- every accepted stop condition, exactly;
- an observed baseline and observed result;
- `outcomeAchieved: true`.

For profitability, the primary metric is reconciled net contribution after attributable costs, refunds, fees, fulfilment, and acquisition expense. Sales, traffic, code, and deployment are supporting evidence, never proof of profit.

After all stop conditions are proved, the mission becomes terminal and no replacement or idle worker is created. A new mission requires a new owner outcome.

## Model and authority boundaries

- Terra/xhigh is the normal durable-work default.
- Terra/ultra is used for unusually deep architecture or cross-system validation.
- Sol/max is reserved for explicit maximum-quality requests or exceptional critical security, privacy, or irreversible-risk work.
- Public messages, publishing, booking, payment, trading, paid spend, credential changes, and destructive production actions remain approval-gated.
- Production execution still requires the existing cloud-workspace admission receipt, exact source admission, and a healthy Trigger/Convex controller. A UI acknowledgement alone is not proof a crew started.
