const { query } = require('@anthropic-ai/claude-code');
const fs = require('fs');
const logger = require('../log/logger');

/**
 * 格式化会话记录为可读文本
 * @param {Array} messages SDK 消息数组
 * @returns {string} 格式化后的文本
 */
function formatSessionTranscript(messages) {
  const lines = [];
  for (const msg of messages) {
    try {
      if (msg.type === 'system' && msg.subtype === 'init') {
        lines.push(`[system:init] session_id=${msg.session_id} model=${msg.model} cwd=${msg.cwd}`);
        lines.push('');
      } else if (msg.type === 'assistant') {
        const usage = msg.message?.usage || {};
        const turn = lines.filter(l => l.startsWith('[assistant]')).length + 1;
        lines.push(`[assistant] (turn ${turn}) input=${usage.input_tokens || 0} output=${usage.output_tokens || 0} cache=${usage.cache_read_input_tokens || 0}`);
        const content = msg.message?.content || [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            for (const textLine of block.text.split('\n')) {
              lines.push(`  > ${textLine}`);
            }
          } else if (block.type === 'tool_use') {
            lines.push(`  [tool_use] ${block.name} id=${block.id}`);
            if (block.input) {
              const inputStr = JSON.stringify(block.input);
              lines.push(`    input: ${inputStr.length > 500 ? inputStr.substring(0, 500) + '...' : inputStr}`);
            }
          }
        }
        lines.push('');
      } else if (msg.type === 'tool_result') {
        const toolId = msg.tool_use_id || '';
        const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
        lines.push(`[tool_result] tool_use_id=${toolId}`);
        lines.push(`  ${contentStr.substring(0, 300)}${contentStr.length > 300 ? '...' : ''}`);
        lines.push('');
      } else if (msg.type === 'result') {
        lines.push(`[result] turns=${msg.num_turns} cost=$${(msg.total_cost_usd || 0).toFixed(4)} is_error=${msg.is_error}`);
        if (msg.result) {
          lines.push(`  result: ${msg.result.substring(0, 500)}${msg.result.length > 500 ? '...' : ''}`);
        }
        lines.push('');
      }
    } catch (err) {
      lines.push(`[error formatting message: ${err.message}]`);
    }
  }
  return lines.join('\n');
}

/**
 * 调用 Claude Code Agent SDK 执行任务
 * @param {string} prompt 完整提示词
 * @param {string} cwd 工作目录（仓库 clone 路径）
 * @param {function} onMessage 消息回调（可选）
 * @param {object} agentOpts 自定义 Agent 配置（可选）
 *   - model {string} 自定义模型名（如 'opus', 'sonnet', 'haiku'）
 *   - apiKey {string} 自定义 API Key（将作为 ANTHROPIC_API_KEY 注入）
 *   - apiBaseUrl {string} 自定义 API Base URL（将作为 ANTHROPIC_BASE_URL 注入）
 * @param {string} sessionPath 会话记录保存路径（可选）
 * @returns {Promise<{result: string, sessionId: string, costUSD: number, numTurns: number, isError: boolean}>}
 */
async function runAgent(prompt, cwd, onMessage = null, agentOpts = {}, sessionPath = null) {
  logger.info(`[Agent] 启动 Claude Code Agent, cwd: ${cwd}`);
  logger.debug(`[Agent] Prompt 长度: ${prompt.length} 字符`);

  const result = {
    sessionId: null,
    result: '',
    costUSD: 0,
    numTurns: 0,
    isError: false,
    messages: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
  };

  // 构建自定义 env：仅在提供了 apiKey / apiBaseUrl 时才注入
  const customEnv = {};
  if (agentOpts.apiKey) {
    customEnv.ANTHROPIC_API_KEY = agentOpts.apiKey;
  }
  if (agentOpts.apiBaseUrl) {
    customEnv.ANTHROPIC_BASE_URL = agentOpts.apiBaseUrl;
  }
  const hasCustomEnv = Object.keys(customEnv).length > 0;

  try {
    const queryResult = query({
      prompt: prompt,
      options: {
        cwd: cwd,
        permissionMode: 'bypassPermissions', // 无头模式：自动接受所有工具调用
        model: agentOpts.model || 'sonnet', // 使用自定义模型或默认 sonnet
        maxTurns: 50, // 限制最大轮次防止失控
        ...(hasCustomEnv ? { env: customEnv } : {}),
        allowedTools: [
          'Bash',           // 执行命令
          'Read',           // 读取文件
          'Write',          // 写入文件
          'Edit',           // 编辑文件
          'MultiEdit',      // 批量编辑
          'Glob',           // 文件搜索
          'Grep',           // 内容搜索
          'Agent',          // 子代理
          'TodoRead',       // 读取 todo
          'TodoWrite',      // 写入 todo
          'NotebookEdit',   // Jupyter 编辑
        ],
      },
    });

    // 迭代处理消息流
    let assistantMsgCount = 0;
    for await (const message of queryResult) {
      result.messages.push(message);

      // 记录关键消息
      if (message.type === 'system' && message.subtype === 'init') {
        result.sessionId = message.session_id;
        logger.info(`[Agent] Session 初始化: ${message.session_id}, 模型: ${message.model}`);
      }

      if (message.type === 'assistant') {
        // 提取文本内容
        const textContent = message.message.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
        if (textContent) {
          logger.info(`[Agent] Assistant: ${textContent.substring(0, 200)}...`);
        }
        // 累加 token 使用量
        const usage = message.message?.usage;
        if (usage) {
          result.inputTokens += usage.input_tokens || 0;
          result.outputTokens += usage.output_tokens || 0;
          result.cacheReadInputTokens += usage.cache_read_input_tokens || 0;
        }
        // 调试日志：打印 usage 字段结构（仅前 2 条 assistant 消息）
        if (assistantMsgCount < 2) {
          assistantMsgCount++;
          logger.info(`[Agent] [DEBUG] assistant message keys: ${Object.keys(message.message || {}).join(', ')}`);
          logger.info(`[Agent] [DEBUG] assistant usage: ${JSON.stringify(usage || 'null')}`);
          logger.info(`[Agent] [DEBUG] message.usage: ${JSON.stringify(message.usage || 'null')}`);
        }
      }

      if (message.type === 'result') {
        result.result = message.result || '';
        result.costUSD = message.total_cost_usd || 0;
        result.numTurns = message.num_turns || 0;
        result.isError = message.is_error || false;
        // 兜底：result 消息中也可能携带 usage
        const usage = message.usage;
        if (usage) {
          result.inputTokens += usage.input_tokens || 0;
          result.outputTokens += usage.output_tokens || 0;
          result.cacheReadInputTokens += usage.cache_read_input_tokens || 0;
        }
        // 调试日志：打印 result 消息全部字段
        logger.info(`[Agent] [DEBUG] result message keys: ${Object.keys(message).join(', ')}`);
        logger.info(`[Agent] [DEBUG] result.usage: ${JSON.stringify(usage || 'null')}`);
        if (!usage) {
          // 尝试其他可能的字段路径
          const altUsage = message.message?.usage || message.total_usage || message.token_usage || null;
          logger.info(`[Agent] [DEBUG] result altUsage: ${JSON.stringify(altUsage || 'null')}`);
        }
        logger.info(`[Agent] 完成: ${message.num_turns} 轮, $${message.total_cost_usd?.toFixed(4)}`);
      }

      // 调用外部回调（如果有）
      if (onMessage) {
        try {
          onMessage(message);
        } catch (err) {
          logger.warn(`[Agent] onMessage 回调错误: ${err.message}`);
        }
      }
    }
  } catch (err) {
    logger.error(`[Agent] SDK 调用失败: ${err.message}`);
    result.isError = true;
    result.result = `Error: ${err.message}`;
  }

  // 持久化会话记录
  if (sessionPath && result.messages.length > 0) {
    try {
      const transcript = formatSessionTranscript(result.messages);
      fs.writeFileSync(sessionPath, transcript, 'utf8');
      logger.info(`[Agent] 会话记录已保存: ${sessionPath}`);
    } catch (err) {
      logger.warn(`[Agent] 保存会话记录失败: ${err.message}`);
    }
  }

  return result;
}

module.exports = { runAgent, formatSessionTranscript };
