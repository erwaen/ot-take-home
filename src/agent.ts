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

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  throw new Error("TODO: implement runAgent — coming in later checklist steps");
}
