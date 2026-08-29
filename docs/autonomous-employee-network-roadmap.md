# Jarvis Autonomous Employee Network

Status: active product roadmap. This document is an implementation contract,
not a claim that every phase is already live.

## Outcome

Jarvis should operate a durable team across Daniel's businesses. Each employee
has a recognizable identity, a bounded role, an inbox, schedules, goals,
checkpointed work, and permission-aware tools. Employees can ask one another
for evidence or work, continue safe work while a decision is pending, and wake
again after restarts. Daniel sees a quiet work map rather than a wall of logs.

The system remains owner-controlled:

- ordinary read, research, drafting, testing, and reversible repair can proceed;
- publishing, external messages, money movement, bookings, destructive changes,
  and material changes of direction require explicit approval;
- a worker cannot broaden its own role, credentials, projects, or authority;
- every action is attributed to one employee, one goal, one attempt, and one
  immutable evidence trail;
- `cancel` stops the exact worker attempt. Cancelling a whole goal is separate.

## Architecture decision

Keep Convex as the authority and state ledger, and Trigger as the durable wake,
lease, retry, and checkpoint runner. Do not replace the existing verified
delivery controller with another orchestration framework.

Use proven open-source patterns behind narrow adapters:

- AutoGen Core message conventions for direct and broadcast worker messages,
  but never as the authority for credentials or delivery;
- Temporal's durable timer, signal, and workflow-history concepts for schedule
  and resume semantics without introducing a second workflow control plane yet;
- LangGraph's explicit interrupt/resume pattern for human decisions, with every
  side effect kept idempotent because interrupted work may resume;
- Postiz as Chloe's self-hostable social draft, schedule, integration, and
  analytics backend. Publishing remains an approval action;
- a self-hosted Jarvis runner for inexpensive background compute. It consumes
  the same Convex leases and checkpoints as every other worker and is never an
  alternate source of truth.

Primary references:

- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/core-concepts/architecture.html
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html
- https://docs.temporal.io/
- https://langchain-ai.github.io/langgraph/concepts/breakpoints/
- https://docs.postiz.com/public-api/posts/create
- https://github.com/erodium/postiz

## Phase 0 — quiet, truthful work screen

Delivery requirements:

- one compact work-map entry point; no duplicate top-corner task stack;
- employee portrait, name, role, concise current action, model policy, and the
  last real checkpoint;
- an animated bar that transitions only between durable percentages and shows
  live-stream freshness without inventing elapsed-time progress;
- exact worker `Stop` control, with a separate whole-goal control;
- at most two relevant work cards; everything else is behind `+N more`;
- blocked decisions appear as small urgent nodes, not long terminal output.

Acceptance:

- stopping a worker writes a terminal receipt, invalidates its lease, and a
  late worker cannot reopen or deliver it;
- refreshing the browser retains progress and selection;
- reduced-motion users receive the same data without animated decoration.

## Phase 1 — real employee identities

Seeded employees:

- JARVIS — chief of staff and supervisor;
- Paul — principal developer;
- Atlas — research and strategy;
- Iris — creative director;
- Maya — travel planner;
- Sentry — reliability and review;
- Chloe — social media manager.

Chloe may research audiences, prepare a calendar, draft variants, stage media,
and collect analytics autonomously. Sending, scheduling, boosting, or deleting
public content requires Daniel's explicit approval until a channel-specific
policy grants a narrower standing permission.

Replace the static TypeScript union with a durable, versioned persona registry:

- `personaId`, slug, display name, role, biography, portrait locator;
- capabilities and prohibited actions;
- project and business scopes;
- default model policy and budget ceiling;
- autonomy policy and approval policy version;
- schedule policy, timezone, quiet hours, and wake rules;
- instruction revision, status, and current goal/attempt references.

Static manifests remain only bootstrap seeds. Runtime routing resolves a signed
persona revision from Convex; unknown or stale revisions fail closed.

## Phase 2 — create an employee by talking to Jarvis

Voice intent such as “create a social manager named Chloe” creates a proposal,
never an immediately privileged employee. Jarvis asks only for missing material
choices, then proposes:

- purpose and measurable outcomes;
- allowed businesses/projects and tools;
- schedule and reporting cadence;
- autonomy and approval boundaries;
- model/cost policy;
- portrait and personality summary.

Daniel confirms one readable card. Confirmation persists an immutable persona
revision, installs only allowlisted capabilities, schedules the first wake, and
opens a private employee thread. Later changes create a new revision and audit
entry. Voice cannot smuggle raw credentials or arbitrary tool names into a role.

## Phase 3 — autonomous schedules and durable goals

Each employee runs a bounded goal loop:

1. wake from a schedule, event, message, or owner request;
2. inspect the current goal, projects, inbox, and prior checkpoint;
3. select the highest-value allowed next action;
4. reserve one exact attempt and execute inside the employee's capability set;
5. persist progress, artifacts, evidence, cost, and next wake;
6. ask another employee for a bounded handoff where useful;
7. finish only after acceptance evidence, or continue in a fresh attempt;
8. report a concise digest at the configured cadence.

No infinite process is required. Continuity is durable state plus scheduled
wakes. A lease expiry creates a successor attempt; stale attempts can neither
publish nor deliver. Goal-mode stopping conditions, retry budgets, and controller
verification remain mandatory.

## Phase 4 — worker-to-worker collaboration

Add a durable mailbox with typed messages:

- `request_work`, `handoff`, `evidence`, `question`, `decision`, `status`, and
  `cancel`;
- sender/recipient persona revisions, goal/attempt IDs, project scope, expiry,
  deduplication key, and artifact references;
- direct messages for ownership; topic streams for project awareness;
- no shared writable branch or ambient credentials.

Jarvis maintains the dependency graph, resolves duplicate ownership, and keeps
messages relevant to each employee's subscribed projects. A worker may use a
handoff only after verifying its evidence receipt and exact source revision.

## Phase 5 — mobile decision inbox

Human input is a durable decision object, not an error string:

- one-sentence decision, recommended choice, consequences, deadline, and the
  minimum supporting evidence;
- exact worker/goal/project links and a safe return URL;
- allowed response type: approve/decline, choose one, short text, file, or voice;
- notification state, reminder policy, resolution, and resume receipt.

The phone page uses large text and one decision at a time. A notification opens
the exact decision, signs Daniel into the correct private thread, and offers
text or voice. Submitting a response atomically records the decision and wakes
the waiting worker. Until then, the worker must inventory all other independent
work, continue it, consolidate additional questions, and escalate only when no
safe path remains or the deadline is material.

## Phase 6 — project-hub operating layer

- every business and project has an owner, goals, employees, documents, recent
  decisions, risks, and scheduled reviews;
- quick search opens projects, files, pages, workers, goals, and decisions;
- the work map shows only the searched/relevant neighborhood and progressively
  expands dots into folders, projects, documents, and full overlays;
- connector capability discovery is generated from real authenticated adapters,
  so Jarvis never claims an unavailable tool and never forgets a live one;
- portfolio reporting includes evidence-backed progress, current blockers,
  cost, and the next autonomous action.

## Delivery sequence

1. Work-screen stop/progress/portrait truthfulness and compact decision nodes.
2. Chloe seed plus Postiz draft-only adapter and approval tests.
3. Persona registry and static-team compatibility adapter.
4. Voice persona proposal/confirmation flow.
5. Durable schedules and employee mailboxes.
6. Mobile decision inbox, deep links, and notifications.
7. Project Hub cross-business graph and capability discovery.

Every phase requires focused tests, TypeScript, a production build, updated
Graphify output, screenshots for visual surfaces, independent review, exact
commit/push verification, provider deployment verification, and a production
smoke. A commit or green command alone is never “live.”
