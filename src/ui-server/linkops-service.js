'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

const { LinkOpsClient, isOfflineError } = require('../linkops-client');
const { HttpError } = require('./utils');

/** `start.bat` polls health for ~30s before giving up; leave headroom. */
const START_TIMEOUT_MS = 90000;

/**
 * The console's view of the external LinkOps workbench.
 *
 * Two jobs: report whether the service is up (and what it offers), and start it
 * when it is not. Everything else is a pass-through to the client — this layer
 * exists so the HTTP routes never touch process spawning or client construction
 * directly, and so an offline service reads as a status rather than a 500.
 */
class LinkOpsService {
  constructor(options = {}) {
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.configService = options.configService;
    this.clientFactory = options.clientFactory || ((settings) => new LinkOpsClient(settings));
    this.runCommand = options.runCommand || null;
    this.starting = null;
  }

  settings() {
    const raw = this.configService?.readRaw?.() || {};
    const linkops = raw.linkops || {};
    return {
      baseUrl: String(linkops.baseUrl || 'http://127.0.0.1:8082').trim().replace(/\/+$/, ''),
      startCommand: String(linkops.startCommand || '').trim(),
      requestTimeoutMs: Number(linkops.requestTimeoutMs || 20000),
    };
  }

  client() {
    return this.clientFactory(this.settings());
  }

  /**
   * Health plus the provider catalog, or a plain "offline" verdict.
   *
   * Deliberately never throws for a service that is simply not running: the
   * console renders that state as a start button, not as an error banner.
   */
  async status() {
    const { baseUrl, startCommand } = this.settings();
    const base = { baseUrl, canStart: Boolean(startCommand), starting: Boolean(this.starting) };
    const client = this.client();
    try {
      const health = await client.health();
      let modules = [];
      try { modules = (await client.modules())?.modules || []; } catch { modules = []; }
      return { ...base, online: true, health, modules };
    } catch (error) {
      if (isOfflineError(error)) return { ...base, online: false, reason: error.message };
      return { ...base, online: false, reason: error.message, rejected: true };
    }
  }

  /** Runs the configured `start.bat` and resolves once it reports healthy. */
  async start() {
    const { startCommand } = this.settings();
    if (!startCommand) throw new HttpError(400, '未配置 linkops.startCommand，无法从控制台启动服务');
    if (this.starting) return this.starting;

    const run = this.runCommand || ((command) => new Promise((resolve, reject) => {
      // `start.bat` stops any old instance, launches the server hidden and
      // polls health itself, so a zero exit already means "ready".
      execFile('cmd.exe', ['/c', command], {
        cwd: path.dirname(command) || this.cwd,
        timeout: START_TIMEOUT_MS,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new HttpError(502, `启动 LinkOps 失败：${String(stderr || error.message).trim().slice(0, 400)}`));
          return;
        }
        resolve(String(stdout || '').trim());
      });
    }));

    this.starting = (async () => {
      try {
        const output = await run(startCommand);
        const status = await this.status();
        if (!status.online) throw new HttpError(502, `启动脚本已执行，但服务仍未就绪：${status.reason || '未知原因'}`);
        return { ok: true, output, status };
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  async guarded(operation) {
    try {
      return await operation(this.client());
    } catch (error) {
      if (isOfflineError(error)) throw new HttpError(503, error.message);
      if (error instanceof HttpError) throw error;
      throw new HttpError(error.status && error.status >= 400 && error.status < 600 ? error.status : 502, error.message);
    }
  }

  modules() { return this.guarded((client) => client.modules()); }

  jobs(query = {}) { return this.guarded((client) => client.listJobs(query)); }

  job(jobId) { return this.guarded((client) => client.job(jobId)); }

  createJob(payload = {}) { return this.guarded((client) => client.createJob(payload)); }

  cancelJob(jobId) { return this.guarded((client) => client.cancelJob(jobId)); }

  retryJob(jobId) { return this.guarded((client) => client.retryJob(jobId)); }

  deleteJob(jobId) { return this.guarded((client) => client.deleteJob(jobId)); }

  batchDeleteJobs(jobIds) { return this.guarded((client) => client.batchDeleteJobs(jobIds)); }

  extractedLinks(limit) { return this.guarded((client) => client.extractedLinks(limit)); }

  submitInput(jobId, value) { return this.guarded((client) => client.submitInput(jobId, value)); }

  proxyPool(provider, country, role) { return this.guarded((client) => client.proxyPool(provider, country, role)); }

  refreshProxyPool(provider, country, role) { return this.guarded((client) => client.refreshProxyPool(provider, country, role)); }

  preflightProxyPool(provider, country, role, index) { return this.guarded((client) => client.preflightProxyPool(provider, country, role, index)); }

  clearProxyPool(provider, country, role) { return this.guarded((client) => client.clearProxyPool(provider, country, role)); }
}

module.exports = { LinkOpsService };
