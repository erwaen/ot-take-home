import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages.js";
import type {
  Assignee,
  Discipline,
  InboxItem,
  ItemOutput,
  PolicyTopic,
  ToolCall,
} from "./types.js";
import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  getToolCallsForItem,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
  withItemContext,
} from "./tools.js";

interface RawLLMOutput {
  classification: ItemOutput["classification"];
  urgency: ItemOutput["urgency"];
  extracted_intake: ItemOutput["extracted_intake"];
  missing_info: string[];
  recommended_next_action: string;
  draft_reply: string | null;
  escalation: ItemOutput["escalation"];
  decision_rationale: string;
}

interface LoopResult {
  raw: RawLLMOutput;
  task_ids: string[];
}

const SYSTEM_PROMPT = `You are the Monday-morning inbox triage agent for Cedar Kids Therapy, a pediatric therapy practice serving children ages 0–18 in speech-language pathology (SLP), occupational therapy (OT), and physical therapy (PT). Today is Monday 2026-04-28. You are processing items that arrived over the weekend.

Your job is to read each inbox item, call the appropriate tools to gather information, and produce a structured triage decision. You will be given one item at a time.

## Urgency levels

- P0 — Safeguarding, imminent harm, or mandated-reporter concern. Same-hour human review required.
- P1 — Same-day operational issue (e.g. appointment cancellation or reschedule needed today). Prompt staff action required.
- P2 — Normal intake, scheduling, billing, or clinical-review workflow. Default for most items.
- P3 — Low-priority admin, FYI, or no action needed. Use P3 for general information questions from parents that require no intake or scheduling action (e.g. "is this normal for my child's age?").

Default to P2. Over-escalation is itself a failure mode — do not use P0 or P1 unless the reason is clear and specific.

## Tool usage rules

Only call a tool when it directly informs your triage decision. Performative or irrelevant tool calls are penalized.

- search_patient: Call ONLY when the message contains a child name or date of birth that could identify an existing patient.
- verify_insurance: Call ONLY when a payer name or member ID is present in the message.
- lookup_policy: Call ONLY when a specific policy topic is needed to ground your decision. Do not call it on every item.
  - Any safeguarding or harm disclosure → lookup_policy({ topic: "safeguarding" }) BEFORE escalating
  - Clinical question from a parent → lookup_policy({ topic: "clinical_advice" })
  - Same-day cancellation or reschedule → lookup_policy({ topic: "scheduling" })
  - Out-of-network or insurance conflict → lookup_policy({ topic: "insurance" })
  - Spanish-speaking family → lookup_policy({ topic: "language_access" })
- find_slots: Call ONLY after verify_insurance returns in_network AND the referral has enough intake data (child name, discipline, at minimum). Do not find slots for out-of-network or expired insurance.
- hold_slot: Call for existing patients with an urgent same-day or near-term scheduling need after find_slots returns results. Use the first available slot that matches the discipline. Not for new referrals pending insurance review.
- create_task: Use to assign concrete follow-up work to staff. Always include clear notes and a due date.
- draft_message: Use to acknowledge receipt and communicate next steps to the sender. Never provide clinical advice. Never imply the message was sent — it is a draft for human review only.
- escalate: Call for P0 (safeguarding/harm) and P1 (same-day operational) items. Do not escalate P2 or P3 items.

## Hard rules

1. NEVER provide clinical advice in any draft message. If a parent asks a clinical question, route to evaluation or clinician review.
2. NEVER imply a message has been sent. draft_message creates a draft only.
3. NEVER schedule an appointment. find_slots and hold_slot are for human review only.
4. For any safeguarding disclosure: call lookup_policy({ topic: "safeguarding" }), then escalate with severity "P0", then create_task for clinical_lead, then draft a neutral acknowledgement only — no investigative language.
5. For Spanish-speaking families: use find_slots with language "es" and draft_message with language "es".
6. Classify as missing_paperwork (not new_referral) when a referral fax arrives with required fields explicitly blank or missing (e.g. DOB, parent contact, insurance). The referral cannot be processed until those fields are supplied.

## Output format

After all tool calls are complete, respond with ONLY a fenced JSON block and nothing else. The block must be valid JSON.

\`\`\`json
{
  "classification": "new_referral",
  "urgency": "P2",
  "extracted_intake": {
    "child_name": "string or null",
    "dob_or_age": "string or null",
    "parent_contact": "string or null",
    "discipline": ["SLP"],
    "diagnosis_or_concern": "string or null",
    "payer": "string or null",
    "member_id": "string or null"
  },
  "missing_info": [],
  "recommended_next_action": "One clear sentence for staff.",
  "draft_reply": "Message body, or null if no reply is needed.",
  "escalation": null,
  "decision_rationale": "2-3 sentences explaining the triage decision and how tool results informed it."
}
\`\`\`

Field rules:
- classification: one of new_referral | existing_patient_request | scheduling | clinical_question | billing_question | missing_paperwork | provider_followup | complaint | safeguarding | spam | other
- urgency: P0 | P1 | P2 | P3
- extracted_intake.discipline: array of SLP/OT/PT values, or null if unknown
- escalation: null, or { "reason": "...", "severity": "P0" or "P1" }
- draft_reply: must not give clinical advice or imply the message was sent

Replace every placeholder with real values. Do not output anything outside the fenced block.`;

const TOOLS: Tool[] = [
  {
    name: "search_patient",
    description:
      "Search existing patient records by name and/or date of birth. Use before creating a new referral workflow to check if the child is already a patient.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Child's full name" },
        dob: {
          type: "string",
          description: "Date of birth in YYYY-MM-DD format",
        },
      },
    },
  },
  {
    name: "verify_insurance",
    description:
      "Verify insurance coverage status against Cedar Kids Therapy in-network payers. Returns in_network, out_of_network, expired, or unknown.",
    input_schema: {
      type: "object",
      properties: {
        payer: { type: "string", description: "Insurance payer name" },
        member_id: { type: "string", description: "Insurance member ID" },
      },
    },
  },
  {
    name: "lookup_policy",
    description:
      "Retrieve relevant policy snippets by topic. Use to ground decisions in practice policy before drafting messages or escalating.",
    input_schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: [
            "service_lines",
            "insurance",
            "safeguarding",
            "clinical_advice",
            "scheduling",
            "cancellation",
            "language_access",
          ],
          description: "Policy topic to retrieve",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "find_slots",
    description:
      "Find available appointment slots filtered by discipline and/or language. Use after confirming in-network insurance to identify slot options for human review.",
    input_schema: {
      type: "object",
      properties: {
        discipline: {
          type: "string",
          enum: ["SLP", "OT", "PT"],
          description: "Therapy discipline",
        },
        preferences: {
          type: "string",
          description: "Family scheduling preferences (e.g. mornings, after school)",
        },
        language: {
          type: "string",
          description: "Preferred provider language (e.g. en, es)",
        },
      },
    },
  },
  {
    name: "hold_slot",
    description:
      "Place a 30-minute pending_review hold on a specific slot. Does NOT schedule — a human must confirm. Only use when there is a patient reference and the slot is appropriate.",
    input_schema: {
      type: "object",
      properties: {
        slot_id: { type: "string", description: "Slot ID from find_slots" },
        patient_ref: {
          type: "string",
          description: "Child name or patient ID as reference",
        },
      },
      required: ["slot_id", "patient_ref"],
    },
  },
  {
    name: "create_task",
    description:
      "Create a staff task for follow-up action. Use to assign work to front_desk, intake, billing, or clinical_lead.",
    input_schema: {
      type: "object",
      properties: {
        assignee: {
          type: "string",
          enum: ["front_desk", "intake", "billing", "clinical_lead"],
          description: "Staff role to assign the task to",
        },
        title: { type: "string", description: "Short task title" },
        due: {
          type: "string",
          description: "Due date in YYYY-MM-DD format",
        },
        notes: {
          type: "string",
          description: "Context and instructions for the assignee",
        },
      },
      required: ["assignee", "title", "due", "notes"],
    },
  },
  {
    name: "draft_message",
    description:
      "Draft an outbound message for human review and sending. Does NOT send. Use for acknowledgements, information requests, and next-step communications.",
    input_schema: {
      type: "object",
      properties: {
        recipient: {
          type: "string",
          description: "Recipient name or email address",
        },
        channel: {
          type: "string",
          enum: ["portal", "email", "phone"],
          description: "Communication channel",
        },
        body: { type: "string", description: "Message body text" },
        language: {
          type: "string",
          enum: ["en", "es"],
          description: "Message language (default: en)",
        },
      },
      required: ["recipient", "channel", "body"],
    },
  },
  {
    name: "escalate",
    description:
      "Escalate an item for immediate human review. P0 = safeguarding or imminent harm (same-hour review). P1 = same-day operational issue.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Inbox item ID" },
        reason: {
          type: "string",
          description: "Clear reason for escalation",
        },
        severity: {
          type: "string",
          enum: ["P0", "P1"],
          description: "P0 for safeguarding/harm, P1 for same-day operational",
        },
      },
      required: ["item_id", "reason", "severity"],
    },
  },
];

const client = new Anthropic();

async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ resultJson: string; task_id?: string }> {
  switch (name) {
    case "search_patient": {
      const r = await search_patient(input as { name?: string; dob?: string });
      return { resultJson: JSON.stringify(r.data) };
    }
    case "verify_insurance": {
      const r = await verify_insurance(
        input as { payer?: string; member_id?: string },
      );
      return { resultJson: JSON.stringify(r.data) };
    }
    case "lookup_policy": {
      const r = await lookup_policy(input as { topic: PolicyTopic });
      return { resultJson: JSON.stringify(r.data) };
    }
    case "find_slots": {
      const r = await find_slots(
        input as { discipline?: Discipline; preferences?: string; language?: string },
      );
      return { resultJson: JSON.stringify(r.data) };
    }
    case "hold_slot": {
      const r = await hold_slot(
        input as { slot_id: string; patient_ref: string },
      );
      return { resultJson: JSON.stringify(r.data) };
    }
    case "create_task": {
      const r = await create_task(
        input as { assignee: Assignee; title: string; due: string; notes: string },
      );
      return { resultJson: JSON.stringify(r.data), task_id: r.data.task_id };
    }
    case "draft_message": {
      const r = await draft_message(
        input as {
          recipient: string;
          channel: "portal" | "email" | "phone";
          body: string;
          language?: "en" | "es";
        },
      );
      return { resultJson: JSON.stringify(r.data) };
    }
    case "escalate": {
      const r = await escalate(
        input as { item_id: string; reason: string; severity: "P0" | "P1" },
      );
      return { resultJson: JSON.stringify(r.data) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function parseOutput(itemId: string, text: string): RawLLMOutput {
  const match = text.match(/```json\s*([\s\S]+?)\s*```/);
  if (!match) {
    throw new Error(`item ${itemId}: no JSON block in final LLM response`);
  }
  try {
    return JSON.parse(match[1]) as RawLLMOutput;
  } catch (err) {
    throw new Error(`item ${itemId}: failed to parse JSON output — ${err}`);
  }
}

async function agentLoop(
  item: InboxItem,
  initialMessages: MessageParam[],
): Promise<LoopResult> {
  const messages: MessageParam[] = [...initialMessages];
  const task_ids: string[] = [];
  const MAX_STEPS = 6;

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      console.error(`[triage] ${item.id} step ${step}: calling ${toolUseBlocks.map((b) => b.name).join(", ")}`);

      const dispatched = await Promise.all(
        toolUseBlocks.map(async (block) => {
          const result = await dispatchTool(
            block.name,
            block.input as Record<string, unknown>,
          );
          if (result.task_id) task_ids.push(result.task_id);
          return { block, result };
        }),
      );

      const toolResults: ToolResultBlockParam[] = dispatched.map(
        ({ block, result }) => ({
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: result.resultJson,
        }),
      );

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    } else {
      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error(`item ${item.id}: no text block in final response`);
      }
      return { raw: parseOutput(item.id, textBlock.text), task_ids };
    }
  }

  throw new Error(`item ${item.id}: exceeded max steps (${MAX_STEPS})`);
}

async function processItem(item: InboxItem): Promise<ItemOutput> {
  return withItemContext(item.id, async () => {
    console.error(`[triage] starting ${item.id}: ${item.subject}`);
    const messages: MessageParam[] = [
      {
        role: "user",
        content: `Triage this inbox item:\n\n${JSON.stringify(item, null, 2)}`,
      },
    ];

    const { raw, task_ids } = await agentLoop(item, messages);
    console.error(`[triage] done    ${item.id} → ${raw.urgency} ${raw.classification}`);

    const tools_called = getToolCallsForItem(item.id);

    return {
      item_id: item.id,
      classification: raw.classification,
      urgency: raw.urgency,
      requires_human_review: true,
      extracted_intake: raw.extracted_intake,
      missing_info: raw.missing_info,
      tools_called,
      recommended_next_action: raw.recommended_next_action,
      draft_reply: raw.draft_reply,
      task_ids,
      escalation: raw.escalation,
      decision_rationale: raw.decision_rationale,
    };
  });
}

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const CONCURRENCY = 3;
  const results: ItemOutput[] = [];

  for (let i = 0; i < inbox.length; i += CONCURRENCY) {
    const batch = inbox.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(processItem));
    results.push(...batchResults);
  }

  return results;
}
