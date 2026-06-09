const { startPolling } = require('./poller');
const { createWebhook, deleteWebhook } = require('../github/webhook');
const queries = require('../db/queries');
const logger = require('../log/logger');
const { processIssue, resumeJobPhaseB } = require('../agent/pipeline');

/**
 * 调度器：管理所有监控任务的启停，并负责服务重启后任务的断点续跑
 */
class Scheduler {
  constructor() {
    this.pollers = new Map(); // monitorId -> setInterval timer
    this.activeMonitors = new Set();
    this.onNewIssueCallback = null;
    this.resumeInProgress = new Set(); // 防止同一任务被重复恢复
  }

  /**
   * 设置新 issue 回调函数
   */
  setOnNewIssue(callback) {
    this.onNewIssueCallback = callback;
  }

  /**
   * 构建 authContext
   */
  buildAuthContext(monitor) {
    if (monitor.auth_type === 'app') {
      return { authType: 'app', owner: monitor.owner, repo: monitor.repo_name };
    }
    return { authType: 'user', owner: monitor.owner, repo: monitor.repo_name };
  }

  /**
   * 启动单个监控任务
   */
  async start(monitor) {
    const id = monitor.id;

    if (this.activeMonitors.has(id)) {
      logger.warn(`[Scheduler] Monitor #${id} 已在运行`);
      return;
    }

    if (!this.onNewIssueCallback) {
      throw new Error('onNewIssue callback not set');
    }

    const authContext = this.buildAuthContext(monitor);

    if (monitor.mode === 'poll' || monitor.mode === 'app_poll') {
      const timer = startPolling(monitor, this.onNewIssueCallback, authContext);
      this.pollers.set(id, timer);
      this.activeMonitors.add(id);
      logger.info(`[Scheduler] 已启动 ${monitor.mode} 监控 #${id} (auth_type=${monitor.auth_type || 'user'})`);
    } else if (monitor.mode === 'webhook') {
      // Webhook 模式不需要本地定时器，由 GitHub 推送触发
      this.activeMonitors.add(id);
      logger.info(`[Scheduler] 已启动 webhook 监控 #${id} (auth_type=${monitor.auth_type || 'user'})`);
    }
  }

  /**
   * 停止单个监控任务
   */
  async stop(monitor) {
    const id = monitor.id;

    if (!this.activeMonitors.has(id)) {
      logger.warn(`[Scheduler] Monitor #${id} 未在运行`);
      return;
    }

    if (monitor.mode === 'poll' && this.pollers.has(id)) {
      clearInterval(this.pollers.get(id));
      this.pollers.delete(id);
      logger.info(`[Scheduler] 已停止 poll 监控 #${id}`);
    }

    if (monitor.mode === 'app_poll' && this.pollers.has(id)) {
      clearInterval(this.pollers.get(id));
      this.pollers.delete(id);
      logger.info(`[Scheduler] 已停止 app_poll 监控 #${id}`);
    }

    this.activeMonitors.delete(id);
  }

  /**
   * 重启监控任务
   */
  async restart(monitor) {
    await this.stop(monitor);
    await this.start(monitor);
  }

  /**
   * 启动所有已启用的监控任务（服务启动时调用）
   */
  async startAll() {
    const monitors = queries.listEnabledMonitors();
    logger.info(`[Scheduler] 发现 ${monitors.length} 个已启用的监控任务`);

    for (const monitor of monitors) {
      try {
        await this.start(monitor);
      } catch (err) {
        logger.error(`[Scheduler] 启动监控 #${monitor.id} 失败: ${err.message}`);
      }
    }

    // 断点续跑：恢复之前 pending 或执行中的任务
    await this.resumeJobs();
  }

  /**
   * 停止所有监控任务
   */
  async stopAll() {
    for (const id of this.activeMonitors) {
      const monitor = queries.getMonitor(id);
      if (monitor) {
        await this.stop(monitor);
      }
    }
  }

  /**
   * 检查监控是否在运行
   */
  isActive(id) {
    return this.activeMonitors.has(id);
  }

  /**
   * 断点续跑：恢复数据库中处于 pending 或执行中状态的任务
   */
  async resumeJobs() {
    try {
      const jobs = queries.listResumableJobs();
      logger.info(`[Scheduler] 发现 ${jobs.length} 个可恢复的任务`);

      for (const job of jobs) {
        if (this.resumeInProgress.has(job.id)) continue;
        this.resumeInProgress.add(job.id);

        try {
          if (['pr_created', 'awaiting_review', 'merging'].includes(job.status)) {
            // Phase B：PR 已创建，进入异步审核/合并阶段
            logger.info(`[Scheduler] 恢复任务 Job#${job.id}: 进入审核阶段 (PR #${job.pr_number || 'unknown'})`);
            // 异步 fire-and-forget，不阻塞调度器启动
            setImmediate(() => {
              resumeJobPhaseB(job).finally(() => this.resumeInProgress.delete(job.id));
            });
          } else {
            // Phase A：尚未创建 PR，需要重新拉取 issue 信息并重新走完整流程。
            // 由于服务中断后本地工作目录已被清理，这里通过 GitHub API 重新获取 issue，
            // 然后重新触发 processIssue。
            const monitor = queries.getMonitor(job.monitor_id);
            if (!monitor) {
              logger.warn(`[Scheduler] 恢复任务 Job#${job.id} 失败: 监控不存在`);
              queries.updateJob(job.id, { status: 'failed', error_message: '监控不存在' });
              this.resumeInProgress.delete(job.id);
              continue;
            }

            logger.info(`[Scheduler] 恢复任务 Job#${job.id}: 重新处理 Issue #${job.issue_number}`);
            const { getIssue } = require('../github/issues');
            const authContext = this.buildAuthContext(monitor);
            const issue = await getIssue(monitor.owner, monitor.repo_name, job.issue_number, authContext);

            // 异步触发 Phase A（会创建新的 job 记录），然后把旧记录标记为失败避免重复
            setImmediate(async () => {
              try {
                queries.updateJob(job.id, {
                  status: 'failed',
                  error_message: '服务重启，任务已由新记录接管',
                });
                await this.onNewIssueCallback(monitor, issue);
              } catch (err) {
                logger.error(`[Scheduler] 恢复任务 Job#${job.id} 失败: ${err.message}`);
              } finally {
                this.resumeInProgress.delete(job.id);
              }
            });
          }
        } catch (err) {
          logger.error(`[Scheduler] 恢复任务 Job#${job.id} 失败: ${err.message}`);
          this.resumeInProgress.delete(job.id);
        }
      }
    } catch (err) {
      logger.error(`[Scheduler] 恢复任务扫描失败: ${err.message}`);
    }
  }
}

// 导出单例
const scheduler = new Scheduler();
module.exports = scheduler;
