const { getOctokit } = require('../github/client');
const { getOpenIssues } = require('../github/issues');
const logger = require('../log/logger');
const queries = require('../db/queries');
const { getTriggerMention, getIssueMentionDebug, isUserAllowed } = require('../github/mention');
const { nowShanghai } = require('../utils/time');

/**
 * 轮询监控器：定期检查仓库的新 issue
 * @param {object} monitor 监控任务配置
 * @param {function} onNewIssue 新 issue 回调
 * @param {object|null} authContext { authType, owner, repo }
 */
function startPolling(monitor, onNewIssue, authContext = null) {
  const intervalMs = monitor.poll_interval * 1000;
  const monitorId = monitor.id;

  logger.info(`[Poller] 启动监控 #${monitorId}: ${monitor.repo_url} (${intervalMs}ms)`);

  // 初始化 cursor：如果没有，使用 Shanghai 当前时间
  if (!monitor.poll_cursor) {
    const now = nowShanghai();
    queries.updateMonitor(monitorId, { poll_cursor: now });
    monitor.poll_cursor = now;
  }

  const timer = setInterval(async () => {
    try {
      const since = monitor.poll_cursor;
      const issues = await getOpenIssues(monitor.owner, monitor.repo_name, since, authContext);

      logger.debug(`[Poller #${monitorId}] Poll tick: repo=${monitor.owner}/${monitor.repo_name}, since=${since}, fetchedIssues=${issues.length}, auth_type=${authContext && authContext.authType ? authContext.authType : (monitor.auth_type || 'user')}`);

      // 过滤出在 cursor 之后创建的 issue（issue.created_at 来自 GitHub，是 UTC ISO with Z）
      const newIssues = issues.filter(issue =>
        new Date(issue.created_at) > new Date(since)
      );

      logger.debug(`[Poller #${monitorId}] New issue candidates after cursor: ${newIssues.map(issue => `#${issue.number}`).join(', ') || 'none'}`);

      if (newIssues.length > 0) {
        logger.info(`[Poller #${monitorId}] 发现 ${newIssues.length} 个新 issue`);

        for (const issue of newIssues) {
          // 测试模式：每检测到一个新 issue 无条件输出一条日志（无论是否被 @提及）
          logger.info(`[Poller #${monitorId}] DETECTED NEW ISSUE: #${issue.number} "${issue.title}" (by ${issue.user && issue.user.login ? issue.user.login : 'unknown'}, created_at=${issue.created_at})`);

          logger.debug(`[Poller #${monitorId}] Inspecting issue #${issue.number}: title=${JSON.stringify(issue.title)}, author=${issue.user && issue.user.login ? issue.user.login : 'unknown'}, created_at=${issue.created_at}`);

          // 去重检查：确保没有正在处理此 issue 的任务
          const existingJob = queries.findActiveJobForIssue(monitorId, issue.number);
          if (existingJob) {
            logger.debug(`[Poller #${monitorId}] Issue #${issue.number} 已在处理中，跳过`);
            continue;
          }

          // @mention 过滤：仅当 issue 标题/内容/评论包含触发名称时才处理
          const mention = getTriggerMention();
          const mentionDebug = await getIssueMentionDebug(monitor.owner, monitor.repo_name, issue, mention, authContext);
          logger.debug(`[Poller #${monitorId}] Mention check issue #${issue.number}: trigger=${mention || '(disabled)'}, matched=${mentionDebug.matched}, titleMatched=${mentionDebug.titleMatched}, bodyMatched=${mentionDebug.bodyMatched}, commentMatched=${mentionDebug.commentMatched}, comments=${mentionDebug.commentCount}, matchedCommentIds=${mentionDebug.matchedCommentIds.join(',') || 'none'}, commentFetchError=${mentionDebug.commentFetchError || 'none'}`);
          if (mention && !mentionDebug.matched) {
            logger.debug(`[Poller #${monitorId}] Issue #${issue.number} 未包含 ${mention}，跳过`);
            continue;
          }

          // 允许的触发人过滤
          const authorLogin = issue.user && issue.user.login ? issue.user.login : null;
          const authorAllowed = !authorLogin || isUserAllowed(authorLogin, monitor.allowed_trigger_users);
          logger.debug(`[Poller #${monitorId}] Allowed user check issue #${issue.number}: author=${authorLogin || 'unknown'}, allowedUsers=${monitor.allowed_trigger_users || '(all)'}, allowed=${authorAllowed}`);
          if (!authorAllowed) {
            logger.info(`[Poller #${monitorId}] Issue #${issue.number} 创建者 ${authorLogin} 不在允许列表中，跳过`);
            continue;
          }

          // 触发新 issue 处理
          await onNewIssue(monitor, issue);
        }

        // 更新 cursor 为最新 issue 的创建时间（GitHub 返回 UTC，统一存 Shanghai 格式便于后续比较）
        const latestTime = nowShanghai();
        queries.updateMonitor(monitorId, { poll_cursor: latestTime });
        monitor.poll_cursor = latestTime;
      }

      // ===== 扫描所有 Open Issues 的评论，检测 @mention（处理已有 issue 的新评论触发）=====
      // 解决问题：轮询只检查新创建的 issue，但如果用户在旧 issue 的评论中 @提及机器人，会被忽略
      const mentionForComments = getTriggerMention();
      if (mentionForComments) {
        const checkedIssueNumbers = new Set(newIssues.map(i => i.number));
        for (const issue of issues) {
          // 跳过已在上面处理过的新 issue（避免重复检查）
          if (checkedIssueNumbers.has(issue.number)) continue;

          // 跳过已有任何 job 的 issue（无论成功/失败/进行中，避免重复触发）
          // 注：Webhook 处理器负责实时捕获新评论事件，轮询仅作为兜底
          if (queries.findAnyJobForIssue(monitorId, issue.number)) continue;

          try {
            const mentionDebug = await getIssueMentionDebug(monitor.owner, monitor.repo_name, issue, mentionForComments, authContext);
            logger.debug(`[Poller #${monitorId}] Comment scan issue #${issue.number}: trigger=${mentionForComments}, commentMatched=${mentionDebug.commentMatched}, matchedCommentIds=${mentionDebug.matchedCommentIds.join(',') || 'none'}, comments=${mentionDebug.commentCount}`);

            // 仅当评论中存在 @mention 时才触发（标题/正文的 @mention 在 issue 创建时已检查过）
            if (!mentionDebug.commentMatched) continue;

            // 检查触发人：取评论中的 @mention 发送者（issue.user.login 作为 fallback）
            const authorLogin = issue.user && issue.user.login ? issue.user.login : null;
            const authorAllowed = !authorLogin || isUserAllowed(authorLogin, monitor.allowed_trigger_users);
            if (!authorAllowed) {
              logger.debug(`[Poller #${monitorId}] Issue #${issue.number} 作者 ${authorLogin} 不在允许列表中，跳过评论 @mention`);
              continue;
            }

            logger.info(`[Poller #${monitorId}] 发现旧 Issue #${issue.number} 评论中有 @mention，触发处理`);
            await onNewIssue(monitor, issue);
          } catch (err) {
            logger.warn(`[Poller #${monitorId}] 扫描 Issue #${issue.number} 评论失败: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`[Poller #${monitorId}] 轮询失败: ${err.message}`);
    }
  }, intervalMs);

  return timer;
}

module.exports = { startPolling };
