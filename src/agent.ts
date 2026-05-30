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

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  throw new Error("TODO: implement runAgent — coming in later checklist steps");
}
