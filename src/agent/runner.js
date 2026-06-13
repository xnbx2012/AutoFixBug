const { query } = require('@anthropic-ai/claude-agent-sdk');
const fs = require('fs');
const logger = require('../log/logger');

// 网络/API 错误（连接/超时/HTTP 5xx）—— 触发外层 query() 重试
const NETWORK_ERR_PATTERNS = [
  'Connection was reset',
  'Connection reset',
  'Connection timed out',
  'Connection refused',
  'Connection closed',
  'Connection error',
  'Could not resolve host',
  'getaddrinfo',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'socket hang up',
  'fetch failed',
  'network timeout',
  'Network request failed',
  'API_CONNECTION_ERROR',
  'API_TIMEOUT',
  'rate_limit',
  'rate limit',
  'overloaded',
  '529',
  '503',
  '502',
  '500',
  '408',
  'Request was aborted',
  'aborted',
  'TLS',
  'SSL',
  'schannel',
  'OpenSSL',
];

function isNetworkError(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return NETWORK_ERR_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

const MAX_AGENT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5000;

// Agent 异常退出（is_error=true）后，自动发送"继续"重试
const MAX_CONTINUE_RETRIES = 10;
const CONTINUE_RETRY_DELAY_MS = 1000;

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
 *   - _resumeSessionId {string} 内部：用于在同一会话中发送"继续"消息
 * @param {string} sessionPath 会话记录保存路径（可选）
 * @param {object|null} outputFormat 结构化输出配置（可选）
 *   - { type: 'json_schema', schema: {...} }
 * @returns {Promise<{result: string, sessionId: string, costUSD: number, numTurns: number, isError: boolean, structuredOutput: object|null, structuredOutputError: string|null}>}
 */
async function runAgent(prompt, cwd, onMessage = null, agentOpts = {}, sessionPath = null, outputFormat = null) {
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
    toolUseCount: 0,
    structuredOutput: null,
    structuredOutputError: null,
  };

  // 是否为 resume 模式（同会话"继续"），跳过内部自动 continue 重试
  const resumeSessionId = agentOpts._resumeSessionId || null;
  const isResume = !!resumeSessionId;
  // resume 模式不继承 _resumeSessionId 字段（避免污染 query options）
  if (isResume) {
    agentOpts = { ...agentOpts };
    delete agentOpts._resumeSessionId;
  }

  // 构建自定义 env：仅在提供了 apiKey / apiBaseUrl 时才注入
  const customEnv = {};
  if (agentOpts.apiKey) {
    customEnv.ANTHROPIC_API_KEY = agentOpts.apiKey;
  }
  if (agentOpts.apiBaseUrl) {
    customEnv.ANTHROPIC_BASE_URL = agentOpts.apiBaseUrl;
  }
  const hasCustomEnv = Object.keys(customEnv).length > 0;

  let lastErr = null;
  for (let attempt = 0; attempt < MAX_AGENT_RETRIES; attempt++) {
    try {
      const queryResult = query({
        prompt: prompt,
        options: {
          cwd: cwd,
          permissionMode: 'bypassPermissions', // 无头模式：自动接受所有工具调用
          model: agentOpts.model || 'sonnet', // 使用自定义模型或默认 sonnet
          maxTurns: 50, // 限制最大轮次防止失控
          ...(hasCustomEnv ? { env: customEnv } : {}),
          ...(outputFormat ? { outputFormat } : {}),
          ...(isResume && resumeSessionId ? { resume: resumeSessionId } : {}),
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
          // 累加工具调用次数（诊断用：判断 Agent 到底干活没有）
          for (const block of message.message?.content || []) {
            if (block.type === 'tool_use') result.toolUseCount++;
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
          // 提取结构化输出（SDK 2.x 特性）
          if (message.structured_output !== undefined && message.structured_output !== null) {
            result.structuredOutput = message.structured_output;
            logger.info(`[Agent] 结构化输出: ${JSON.stringify(message.structured_output).substring(0, 500)}`);
          }
          if (message.subtype === 'error_max_structured_output_retries') {
            result.structuredOutputError = 'error_max_structured_output_retries';
            logger.warn('[Agent] 结构化输出验证失败（达到最大重试次数），将回退到文本解析');
          }
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
          logger.info(`[Agent] 完成: ${message.num_turns} 轮, $${message.total_cost_usd?.toFixed(4)}, is_error=${result.isError}, has_structured_output=${!!result.structuredOutput}`);
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

      // 成功完成循环（不含异常退出重试）—— 如果 is_error=true 触发 continue 重试
      break;
    } catch (err) {
      lastErr = err;
      const errMsg = err.message || '';
      const isNetErr = isNetworkError(errMsg);

      if (isNetErr && attempt < MAX_AGENT_RETRIES - 1) {
        const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
        logger.warn(
          `[Agent] 网络/API 错误，第 ${attempt + 1}/${MAX_AGENT_RETRIES - 1} 次重试，等待 ${delay}ms: ${errMsg}`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // 非网络错误或重试耗尽
      logger.error(`[Agent] SDK 调用失败: ${errMsg}`);
      result.isError = true;
      result.result = `Error: ${errMsg}`;
      break;
    }
  }

  // ——— 异常退出自动"继续"重试（Agent 以 is_error=true 完成，会话本身有效）———
  // 注意：resume 模式（同一会话"继续"）不进入此分支，由外部 pipeline 决定是否继续
  if (result.isError && result.sessionId && !isResume) {
    logger.info(
      `[Agent] 检测到异常退出 (is_error=true, turns=${result.numTurns})，` +
      `启动"继续"重试，最多 ${MAX_CONTINUE_RETRIES} 次，间隔 ${CONTINUE_RETRY_DELAY_MS}ms`
    );

    for (let c = 0; c < MAX_CONTINUE_RETRIES; c++) {
      // 等待间隔（先等待再重试，给 API 恢复时间）
      await new Promise((r) => setTimeout(r, CONTINUE_RETRY_DELAY_MS));

      logger.info(`[Agent] "继续"重试 ${c + 1}/${MAX_CONTINUE_RETRIES}，sessionId=${result.sessionId}`);

      try {
        const continueResult = query({
          prompt: '继续',
          options: {
            cwd: cwd,
            resume: result.sessionId,
            permissionMode: 'bypassPermissions',
            model: agentOpts.model || 'sonnet',
            maxTurns: 30,
            ...(hasCustomEnv ? { env: customEnv } : {}),
            ...(outputFormat ? { outputFormat } : {}),
          },
        });

        let continueIsError = false;
        for await (const message of continueResult) {
          result.messages.push(message);

          if (message.type === 'assistant') {
            const textContent = message.message.content
              .filter((bc) => bc.type === 'text')
              .map((bc) => bc.text)
              .join('\n');
            if (textContent) {
              logger.info(`[Agent] [继续 ${c + 1}] Assistant: ${textContent.substring(0, 200)}...`);
            }
            const usage = message.message?.usage;
            if (usage) {
              result.inputTokens += usage.input_tokens || 0;
              result.outputTokens += usage.output_tokens || 0;
              result.cacheReadInputTokens += usage.cache_read_input_tokens || 0;
            }
            for (const block of message.message?.content || []) {
              if (block.type === 'tool_use') result.toolUseCount++;
            }
          }

          if (message.type === 'result') {
            const usage = message.usage;
            if (usage) {
              result.inputTokens += usage.input_tokens || 0;
              result.outputTokens += usage.output_tokens || 0;
              result.cacheReadInputTokens += usage.cache_read_input_tokens || 0;
            }
            // 覆盖主结果
            result.result = message.result || result.result;
            result.costUSD = (result.costUSD || 0) + (message.total_cost_usd || 0);
            result.numTurns = (result.numTurns || 0) + (message.num_turns || 0);
            continueIsError = message.is_error || false;
            // 提取结构化输出（继续重试也可能是结构化的）
            if (message.structured_output !== undefined && message.structured_output !== null) {
              result.structuredOutput = message.structured_output;
              logger.info(`[Agent] [继续 ${c + 1}] 结构化输出: ${JSON.stringify(message.structured_output).substring(0, 500)}`);
            }
            if (message.subtype === 'error_max_structured_output_retries') {
              result.structuredOutputError = 'error_max_structured_output_retries';
              logger.warn(`[Agent] [继续 ${c + 1}] 结构化输出验证失败`);
            }
            logger.info(
              `[Agent] [继续 ${c + 1}] 完成: turns=${message.num_turns}, ` +
              `cost=$${message.total_cost_usd?.toFixed(4)}, is_error=${continueIsError}`
            );
          }

          if (onMessage) {
            try { onMessage(message); } catch (_) { /* 忽略 */ }
          }
        }

        if (!continueIsError) {
          // 恢复成功：重置 isError，后续走正常流程
          result.isError = false;
          logger.info(`[Agent] "继续"重试第 ${c + 1} 次成功，Agent 已恢复`);
          break;
        }

        // 仍是 is_error=true，继续下一轮
        logger.warn(`[Agent] "继续"重试第 ${c + 1} 次仍失败 (is_error=true)，${c < MAX_CONTINUE_RETRIES - 1 ? '将再次重试' : '已达重试上限'}`);
      } catch (continueErr) {
        // "继续"调用本身抛异常（网络错误等）—— 不对外层做特殊处理，继续下一轮
        logger.warn(
          `[Agent] "继续"重试第 ${c + 1} 次调用异常: ${continueErr.message}，` +
          `${c < MAX_CONTINUE_RETRIES - 1 ? '将再次重试' : '已达重试上限'}`
        );
      }
    }

    if (result.isError) {
      logger.error(
        `[Agent] "继续"重试 ${MAX_CONTINUE_RETRIES} 次后仍为 is_error=true，最终放弃。` +
        `最终输出 (前 500 字符): ${(result.result || '').substring(0, 500)}`
      );
    }
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
