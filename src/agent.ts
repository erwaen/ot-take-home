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
- P3 — Low-priority admin, FYI, or no action needed.

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
- hold_slot: Call ONLY for existing patients with an urgent same-day or near-term scheduling need where a specific slot is appropriate. Not for new referrals pending insurance review.
- create_task: Use to assign concrete follow-up work to staff. Always include clear notes and a due date.
- draft_message: Use to acknowledge receipt and communicate next steps to the sender. Never provide clinical advice. Never imply the message was sent — it is a draft for human review only.
- escalate: Call for P0 (safeguarding/harm) and P1 (same-day operational) items. Do not escalate P2 or P3 items.

## Hard rules

1. NEVER provide clinical advice in any draft message. If a parent asks a clinical question, route to evaluation or clinician review.
2. NEVER imply a message has been sent. draft_message creates a draft only.
3. NEVER schedule an appointment. find_slots and hold_slot are for human review only.
4. For any safeguarding disclosure: call lookup_policy({ topic: "safeguarding" }), then escalate with severity "P0", then create_task for clinical_lead, then draft a neutral acknowledgement only — no investigative language.
5. For Spanish-speaking families: use find_slots with language "es" and draft_message with language "es".

## Output format

After all tool calls are complete, respond with ONLY a fenced JSON block and nothing else:

\`\`\`json
{
  "classification": "<new_referral|existing_patient_request|scheduling|clinical_question|billing_question|missing_paperwork|provider_followup|complaint|safeguarding|spam|other>",
  "urgency": "<P0|P1|P2|P3>",
  "extracted_intake": {
    "child_name": "<string or null>",
    "dob_or_age": "<string or null>",
    "parent_contact": "<string or null>",
    "discipline": ["<SLP|OT|PT>"] or null,
    "diagnosis_or_concern": "<string or null>",
    "payer": "<string or null>",
    "member_id": "<string or null>"
  },
  "missing_info": ["<field name>"],
  "recommended_next_action": "<one clear sentence for staff>",
  "draft_reply": "<message body for the sender, or null if no reply is appropriate>",
  "escalation": { "reason": "<string>", "severity": "<P0|P1>" } or null,
  "decision_rationale": "<2–3 sentences explaining the triage decision and how tool results informed it>"
}
\`\`\`

The draft_reply must be clear, empathetic, and concise. It must not give clinical advice or imply it has been sent.`;

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

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  throw new Error("TODO: implement runAgent — coming in later checklist steps");
}
