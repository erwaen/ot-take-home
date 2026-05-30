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
- **Safety runs in two layers, not one.** The first layer is the system prompt: if the message contains any harm or abuse language, the model is instructed to call `lookup_policy(safeguarding)` first, then `escalate(P0)`, then create a task for the clinical lead, and only then draft a neutral acknowledgement — no investigative language, no clinical advice. This isn't a soft suggestion; it's a numbered hard rule in the prompt. The prompt also explicitly calls out that over-escalation is a failure — crying wolf burns clinical lead time and trains staff to ignore alerts — so the model is pushed to reserve P0 for real signals, not edge cases.

  The second layer is a post-processing safety override that runs after the LLM returns, completely independent of what the model decided. It scans the original message for patterns a clinician would immediately recognise — physical harm language, fear of a caregiver, unexplained bruises, confinement, abuse — and if any match, it forces the output to P0 regardless of the model's judgment. The override logs which exact pattern triggered so a reviewer can verify it wasn't a false positive. A missed P0 in a pediatric practice is not recoverable. A false positive costs 10 minutes of a clinical lead's time. That asymmetry justifies the hard override.

---

## 4. Failure Modes and Production Eval

The scariest failure in this domain isn't a schema error or a wrong classification — it's a missed P0. If Leo's voicemail doesn't trigger a safeguarding escalation, a child may be in danger and nobody at the practice knows about it. Everything else is recoverable. That isn't. That's why I treated safeguarding as the one thing that gets two layers of protection instead of one, and why the post-processing override exists — I don't want the safety of a child to depend entirely on a language model having a good day.

The other failure I thought about a lot is the opposite one: over-escalation. If the agent cries wolf and marks half the inbox as P0, the clinical lead stops paying attention, staff get desensitized, and the real P0 gets buried. So the prompt explicitly names over-escalation as a failure mode on equal footing with under-escalation. P0 should feel rare and serious when it appears.

Beyond safeguarding, the main things that can go wrong are the usual LLM problems — non-determinism means the same item might get classified differently on two runs, and there's no retry logic today, so a single API error or rate limit will fail that item and surface as an exception. The `MAX_STEPS = 6` guard handles the case where the model keeps calling tools without ever writing a final output — it throws a named error so the failure is visible rather than silent.

For forbidden actions — sending a message, scheduling an appointment — the protection is structural: those tools simply don't exist in the tool definitions the model receives. You can't call a tool that isn't there.

For production eval I'd want more than the schema validator. The validator checks that the output is well-formed; it doesn't check whether the triage judgment was right. I'd want a golden set of hand-labeled items that we run the agent against weekly and track drift on — if urgency accuracy drops after a prompt change, we know immediately. I'd also want shadow mode before going live: run the agent in parallel with the human process for a few weeks, compare outputs without acting on them, and measure the false-negative rate on safeguarding specifically. And I'd put a canary item in every batch — a synthetic message with a clear safeguarding signal — so we know the model is still catching P0 correctly after any change to the prompt or the model version.

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

## 6. What I Would Do With Another 4 Hours

The first thing I'd fix is the final output step. Right now the agent asks Claude to write a JSON block inside a code fence and we parse it with a regex — it works, but it's fragile. If the model adds a sentence before the block, the parse fails. I'd replace it with a `submit_triage` tool that has the full `ItemOutput` shape as its `input_schema` and use `tool_choice: { type: "tool", name: "submit_triage" }` to force the model to call it. No regex, no parse errors, schema-validated by the API itself.

Second, I'd abstract the LLM client behind a simple interface so the agent isn't tied to Anthropic. Something like `interface LLMClient { chat(messages, tools): Promise<Response> }` with an Anthropic implementation and an OpenAI one. The system prompt and tool schemas translate cleanly to OpenAI's function-calling format. If the primary model is rate-limited or down, you swap the client — the agent loop doesn't change. Right now the model name is hardcoded in the loop, which is the kind of thing that bites you at 8am on a Monday.

Third, prompt caching. The system prompt and tool definitions are about 1,200 tokens and get re-sent for every single item. Adding `cache_control: { type: "ephemeral" }` on the system block means those tokens are only charged once per batch after the first item. On a real Monday inbox with 30+ items that adds up fast.

The test I'd most want to write is an adversarial safeguarding suite — 10 synthetic items with subtle signals, not just obvious ones like "dad getting rough" but things like "she doesn't want to go home since the new babysitter started," "he had marks on his arms at the last session," "mom said he's been locked in his room when he misbehaves." Every one of those should come out P0. That's the regression suite that matters before you ship anything near a real practice.

I'd also wrap `processItem` in a retry helper with exponential backoff. One transient API error shouldn't kill the whole batch. Items that still fail after 3 attempts go into a dead-letter list that gets returned alongside the successful outputs — the batch finishes, it just tells you which items need a human to re-run.

Last thing would be a lightweight eval harness that runs the agent against a golden set of hand-labeled items and reports precision and recall on urgency and safeguarding. The point isn't to hit a number — it's to have something you can run in CI every time you touch the prompt, so you know immediately if a change that improves one case breaks another.

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
