# Origin AI Engineering Take-Home: Referral Inbox Triage Agent

Origin builds software for pediatric therapy practices. In this assignment, you are helping a fictional practice, Cedar Kids Therapy, triage its Monday inbox.

## Scenario

It is Monday at 8am at a multi-disciplinary pediatric therapy practice supporting speech-language pathology, occupational therapy, and physical therapy. The shared inbox accumulated items over the weekend from pediatrician fax referrals, parent voicemails, parent portal messages, and emails. Build an AI agent prototype that turns the messy batch into a sorted, human-reviewable action plan.

## What We Expect

Strong submissions are usually incomplete but honest. We are evaluating triage judgment, tool orchestration, and scoping, not whether you finished every nice-to-have. Produce some output for every item, even thin; document what you cut in the README.

You may use any AI coding agent (Claude Code, Cursor, Codex, etc.) while building. State your stack and assumptions in your README.

Runtime LLM usage is allowed and recommended, but not required. Origin will provide a temporary capped API key for either OpenAI or Anthropic; the email distributing the key will name the provider and the environment variable to set (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). You may also use your own provider. You may install dependencies for the provider you choose (e.g., `npm install openai` or `npm install @anthropic-ai/sdk`). Use any key only with the provided synthetic data, store it in an environment variable, and do not commit it. Model choice is not part of the rubric.

## How To Run

```bash
npm install
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

The commands also work with no flags and default to the paths above. Reviewers may run the same commands against similar hidden synthetic input. Do not hardcode input, output, or trace paths.

## Share And Submit

Create your own GitHub repo from this starter pack and implement your solution there. The repo can be public or private. When you are done, submit the repo link. If it is private, grant access to the Origin reviewer GitHub account `@nixu`.

Commit your code, your updated `README.md`, and your final generated `output.json`. Do not commit API keys, `.env` files, real PHI, `node_modules/`, or `.trace/`.

We expect you to spend about 2 hours. If you stop before finishing, commit what you have and describe the cuts in your README.

---

## 1. How to Run

```bash
npm install
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

Create a `.env` file in the project root with your API key — it's loaded automatically at startup:

```
ANTHROPIC_API_KEY=your_key_here
```

Expected runtime is around 2–3 minutes for 8 items. Progress logs go to stderr so they don't pollute `output.json`. Both commands also work with no flags and default to the paths above.

---

## 2. Stack and Runtime

- **Language**: TypeScript, Node LTS, ESM modules
- **Runner**: `tsx` — no build step needed
- **LLM**: Anthropic `claude-sonnet-4-6` via `@anthropic-ai/sdk`
- **Added dependencies**: `@anthropic-ai/sdk`, `dotenv`
- **Files modified**: only `src/agent.ts` — all provided files (`tools.ts`, `index.ts`, `types.ts`, `validate.ts`) are untouched

I used **Claude Code** as my coding assistant throughout, building incrementally against a checklist tracked in `CLAUDE.md`. Each checklist item was one focused change, typechecked before moving on. I'm not sure if I had to upload the CLAUDE.md but I can share with you too.

---

## 3. Architecture

I built a proper LLM tool-use loop where the model reads each item and decides which tools to call.

The loop looks like this:

```
runAgent(inbox)
  → items processed in batches of 3 (concurrency limit to avoid rate limits)
    → processItem(item)
        → withItemContext(item.id, ...) — isolates trace per item via AsyncLocalStorage
            → agentLoop:
                1. send item + system prompt + 8 tool definitions to Claude
                2. if stop_reason === "tool_use":
                     dispatch all tool blocks in parallel
                     collect task_ids from create_task results
                     append [assistant, tool_result] messages to history
                     repeat (max 6 steps)
                3. if stop_reason === "end_turn":
                     parse fenced JSON block from response text
                     return structured output
            → getToolCallsForItem(item.id) — read from trace after loop, passed through unchanged
            → build ItemOutput with requires_human_review: true always
```

**How the loop knows when to stop:**

The loop is driven by one question — did the model want to call a tool?

```
send message to Claude
       ↓
did Claude call a tool?
  YES → execute it, add result to history, ask Claude again
  NO  → Claude is done, extract the JSON output
```

When Claude responds with `stop_reason: "tool_use"` it means it needs more information. We run the tools, add the results to the conversation, and send everything back. When Claude responds with `stop_reason: "end_turn"` it has all it needs and writes the final triage JSON instead of calling another tool.

Concrete example for item_1 (Emma Lee fax referral):

```
→ Claude sees the referral
→ calls search_patient + verify_insurance     (step 0 — who is this? is insurance valid?)
→ results: no existing record, BCBS is in_network
→ calls find_slots                            (step 1 — insurance is good, find SLP slots)
→ results: available slots with provider names
→ calls create_task + draft_message           (step 2 — assign intake work, acknowledge sender)
→ Claude writes final JSON                    (end_turn) ✓
```

The `MAX_STEPS = 6` guard is the safety net — if the model keeps calling tools and never writes the final output, we throw a named error instead of looping forever.

**A few other decisions worth calling out:**

- **`withItemContext` wraps the entire item**, not individual tool calls. Every tool dispatched during the loop is automatically associated with the right item in the audit trace — no manual tracking needed.
- **`task_ids` are collected at dispatch time** from `create_task` return values, not re-parsed from result summaries after the fact.
- **The system prompt does the heavy lifting** on safety. Safeguarding disclosure → `lookup_policy(safeguarding)` → `escalate(P0)` is a hard rule, not a suggestion. Over-escalation is explicitly named as a failure mode with equal weight to under-escalation.
- **A hard safety override runs after the LLM**, independent of the model's judgment. If the message contains any signal a clinician would recognize as a safeguarding concern — physical harm language, fear of a caregiver, confinement, abuse — the output is forced to P0 regardless of what the LLM decided. A missed P0 is not recoverable; a false positive is. The override logs exactly which pattern triggered so the human reviewer can verify it.

---

## 4. Failure Modes and Production Eval

The scariest failure in this domain is a missed P0. If Leo's voicemail doesn't trigger a safeguarding escalation, a child may be in danger and no one at the practice knows. Everything else is recoverable; that isn't. So the system prompt treats safeguarding as a hard rule with no exceptions, and I'd want that tested adversarially before going anywhere near production.

**Failure modes I thought about:**

| Mode | What breaks | How I handled it |
|---|---|---|
| Missed safeguarding signal | Child at risk, no escalation triggered | Hard rule in prompt: *any* harm/abuse language → `lookup_policy(safeguarding)` → `escalate(P0)`. Not a soft suggestion. |
| Over-escalation | Clinical lead time wasted on P3 items | Explicit "over-escalation is itself a failure" in prompt; P3 defined for developmental questions with no action needed |
| LLM non-determinism | Same item triaged differently on re-runs | Strict prompt rules reduce variance; `decision_rationale` makes the reasoning auditable so a human can catch a bad call |
| Runaway tool loop | Agent calls tools forever, never finishes | `MAX_STEPS = 6` guard — throws a named error so the item fails visibly rather than silently |
| `max_tokens` hit | No JSON block in response → parse throws | Currently surfaces as a hard error; production needs a retry with a shorter prompt fallback |
| API error or 429 | Item fails, rest of batch continues | No retry logic in this build — a single failure propagates; production needs exponential backoff |
| LLM hallucinates a forbidden tool | Validator fails | Forbidden tools (`send_message`, `schedule_appointment`) are not in the tool definitions, so the model can't call them |

**How I'd eval this in production:**

The validator is a good gate but it only checks structure, not judgment. For real eval I'd want:

1. A golden set of hand-triaged items — run the agent weekly and compare urgency and classification against the ground truth. Track drift.
2. A mandatory human review of every P0 and P1 item before any staff action is taken. The `decision_rationale` field exists specifically for this — a reviewer should be able to read it in 10 seconds and either approve or override.
3. Shadow mode first — run the agent in parallel with the human process for 2–4 weeks, comparing outputs without acting on them. Measure false-negative rate on safeguarding specifically.
4. A canary test item in every batch — a synthetic item with a clear safeguarding signal, included to verify the model is still triggering P0 correctly after any prompt change.

---

## 5. What I Chose Not to Build, and Why

**Everything is in `src/agent.ts` — intentionally.**

This is a deliberate choice for reviewability, not a laziness shortcut. When a reviewer opens the repo, they can collapse and expand regions in their IDE to follow the full flow without jumping between files:

- `SYSTEM_PROMPT` — the triage rules and output format
- `TOOLS` — the 8 Anthropic tool schema definitions
- `dispatchTool` — maps LLM tool names to `tools.ts` functions
- `agentLoop` — the recursive tool-use loop
- `parseOutput` — JSON extraction from the final response
- `processItem` — wraps one item end-to-end
- `runAgent` — batch orchestration

In a real production codebase I'd split these into separate modules — `prompts.ts`, `tool-schemas.ts`, `loop.ts`, `dispatcher.ts` — both for testability and because different teams might own different pieces. I'd also abstract the LLM client behind an interface so you can swap providers:

```typescript
interface LLMClient {
  chat(messages: MessageParam[], tools: Tool[]): Promise<LLMResponse>;
}
// AnthropicClient implements LLMClient
// OpenAIClient implements LLMClient
```

This means if Anthropic has an outage, or a model is deprecated, or you want to A/B test providers, you swap the implementation without touching the agent logic. The model name itself (`claude-sonnet-4-6`) should live in config, not hardcoded in the loop.

**Other deliberate cuts:**

- **Prompt caching** — the system prompt and tool definitions (~1,200 tokens) are re-sent with every item. Adding `cache_control: { type: "ephemeral" }` on the system block would reduce cost by ~80% on repeat items. Straightforward to add but not worth the take-home time.
- **Retry logic** — one API error fails the item and the error surfaces. Production needs a retry wrapper with exponential backoff and a dead-letter queue for persistent failures.
- **Zod validation on LLM output** — `parseOutput` trusts the JSON the model returns. A Zod parse of `RawLLMOutput` before building `ItemOutput` would catch hallucinated or missing fields early.
- **`hold_slot` for new referrals** — I intentionally only call `hold_slot` for confirmed existing patients with a same-day need (item_8). Holding a slot for a new referral before insurance is verified and intake is complete creates noise for staff.

---

## 6. What I Would Do With Another 4 Hours

**1. Model adapter + provider fallback.**
Abstract the Anthropic client behind a `LLMClient` interface with implementations for both Anthropic and OpenAI. If the primary model is unavailable or rate-limited, the agent retries with the fallback. The system prompt and tool schemas translate cleanly to OpenAI's function-calling format.

**2. Structured output for the final response.**
Right now the agent ends by parsing a fenced JSON block from plain text — fragile if the model adds extra commentary. I'd use `tool_choice: { type: "tool", name: "submit_triage" }` with a `submit_triage` tool whose `input_schema` is the full `ItemOutput` shape. The model is forced to call it with a validated structure. No regex, no parse errors.

**3. Prompt caching.**
Add `cache_control: { type: "ephemeral" }` on the system prompt block. On a Monday batch of 30+ items this pays back immediately — the system prompt tokens are only charged once instead of once per item.

**4. Adversarial safeguarding tests.**
Write 5–10 synthetic items with subtle safeguarding language — not just "dad getting rough" but things like "she seems scared to go home," "he has unexplained bruises," "mom mentioned he's been locked in his room." Verify the agent catches all of them as P0. This is the test suite that matters most.

**5. Retry with dead-letter queue.**
Wrap `processItem` in a retry helper (3 attempts, exponential backoff). Items that still fail after retries go into a dead-letter list returned alongside the successful outputs — the batch doesn't abort, it just flags which items need human handling.

**6. Eval harness.**
Build a lightweight eval that runs the agent against a golden set of hand-labeled items and reports precision/recall on urgency classification and safeguarding detection. Run it in CI on every prompt change.

## Your Task

Implement the agent in `src/agent.ts`. It should read the `InboxItem[]` it receives, use the provided tools where appropriate, and return one output item per inbox item. `src/index.ts` wraps your items with `buildBatchOutput()` and writes the final `output.json`.

Available tools: `search_patient`, `verify_insurance`, `lookup_policy`, `find_slots`, `hold_slot`, `create_task`, `draft_message`, `escalate`.

Use `schema/output.schema.json` as the source of truth for the output shape. `data/example_output.json` shows one non-trivial worked item. It is illustrative and is not expected to pass validation by itself. **Do not copy the example call IDs** into your output — real outputs must use the `call_id` values returned by `getToolCallsForItem()`.

## Time Box

Spend about 2 hours. Suggested allocation: 20 minutes reading and designing, 70 minutes building, 20 minutes self-evaluating against the validator and the inbox, 10 minutes updating the README. Expected end-to-end runtime for `npm run triage` should be a few minutes or less; if your agent is much slower, that is worth noting in the README rather than optimizing under time pressure.

Minimum viable submission: processes every item in `data/inbox.json`, makes relevant tool calls including at least 3 distinct tools across the batch, writes a valid `output.json`, and passes `npm run validate`. Beyond that floor, your architecture, error handling, audit discipline, and scoping choices are part of what we evaluate.

## Constraints

- Use TypeScript, Node LTS, and npm. If this creates a real accessibility or environment issue, reach out.
- Use the provided tools in `src/tools.ts`; do not modify, reimplement, or bypass them. The tools create the audit trace used by the validator, so bypassing them fails validation.
- Use at least 3 distinct tools across the batch. Strong solutions use tools as part of the decision process across multiple items, not just once to satisfy the threshold. Irrelevant or performative tool calls will be penalized.
- Use `withItemContext(item.id, async () => ...)` around item-level tool calls.
- Use `getToolCallsForItem(item.id)` for `tools_called[]`; pass the returned entries through unchanged.
- Use `buildBatchOutput(items)` through the starter `src/index.ts`; do not hand-compute summary counts.
- Do not auto-send messages. Use `draft_message` only.
- Do not schedule appointments. `find_slots` and `hold_slot` are reviewable; scheduling is not.
- Use only synthetic data. Do not add real PHI.

## Urgency Calibration

- `P0`: safeguarding, imminent harm, mandated-reporter escalation. Same-hour human review.
- `P1`: same-day operational issue requiring prompt staff action.
- `P2`: normal intake, scheduling, billing, or clinical-review workflow.
- `P3`: low-priority admin, FYI, spam.

Default to `P2` unless there is a clear safety or same-day operational reason. Over-escalation is itself a production failure mode.

## Review Variants

Similar synthetic variants may be run during review. We will not tell you what they cover, but the visible 8 items show the kinds of cases we care about.

## Rubric

- Safety and domain judgment: 25%
- Tool orchestration and action model: 25%
- Output correctness and auditability: 20%
- Engineering quality: 15%
- README and production thinking: 15%

Draft replies should be clear, empathetic, concise, and operationally useful. They must not provide clinical advice or imply messages were sent.
