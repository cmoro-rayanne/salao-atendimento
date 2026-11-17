import type { AgentMessage, AgentTool, LlmClient, SystemPrompt, TokenUsage, ToolCall, ToolContext } from './ports.js';

interface RunStats {
  steps: number;
  toolsUsed: string[];
  usage: TokenUsage;
}

export type AgentOutcome =
  | ({ kind: 'reply'; text: string } & RunStats)
  | ({ kind: 'handoff'; reason: 'tool' | 'max_steps' } & RunStats);

export interface RunAgentInput {
  system: SystemPrompt;
  history: AgentMessage[];
  tools: AgentTool[];
  maxSteps: number;
  ctx: ToolContext;
}

/**
 * Loop do agente: o modelo responde em texto ou pede ferramentas.
 * Passou de `maxSteps` sem resposta final, a conversa vai para a equipe.
 */
export async function runAgent(llm: LlmClient, input: RunAgentInput): Promise<AgentOutcome> {
  const messages: AgentMessage[] = [...input.history];
  const toolsByName = new Map(input.tools.map((t) => [t.spec.name, t]));
  const toolsUsed: string[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let step = 1; step <= input.maxSteps; step++) {
    const turn = await llm.complete({
      system: input.system,
      messages,
      tools: input.tools.map((t) => t.spec),
    });
    usage.inputTokens += turn.usage?.inputTokens ?? 0;
    usage.outputTokens += turn.usage?.outputTokens ?? 0;

    if (turn.type === 'text') {
      return { kind: 'reply', text: turn.text.trim(), steps: step, toolsUsed, usage };
    }

    messages.push({ role: 'assistant_tool_calls', calls: turn.calls });

    for (const call of turn.calls) {
      const tool = toolsByName.get(call.name);
      toolsUsed.push(call.name);
      const result = await executeTool(tool, call, input.ctx);
      messages.push(result.message);
      if (result.endsConversation) {
        return { kind: 'handoff', reason: 'tool', steps: step, toolsUsed, usage };
      }
    }
  }

  return { kind: 'handoff', reason: 'max_steps', steps: input.maxSteps, toolsUsed, usage };
}

async function executeTool(
  tool: AgentTool | undefined,
  call: ToolCall,
  ctx: ToolContext,
): Promise<{ message: AgentMessage; endsConversation: boolean }> {
  if (!tool) {
    return {
      message: { role: 'tool_result', callId: call.id, content: `Ferramenta desconhecida: ${call.name}`, isError: true },
      endsConversation: false,
    };
  }

  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) {
    // Devolve o erro ao modelo para ele corrigir os argumentos no próximo passo.
    return {
      message: { role: 'tool_result', callId: call.id, content: `Input inválido: ${parsed.error.message}`, isError: true },
      endsConversation: false,
    };
  }

  const content = await tool.run(parsed.data, ctx);
  return {
    message: { role: 'tool_result', callId: call.id, content, isError: false },
    endsConversation: tool.endsConversation === true,
  };
}
