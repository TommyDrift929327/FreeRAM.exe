'use strict';

/**
 * Orchestration de la surveillance : mémoire, CPU, processus, capteurs.
 * Les cadences viennent de config/app.config.json.
 */

const os = require('node:os');
const memory = require('./memory');
const { listProcesses } = require('./processes');
const logger = require('./logger');

class Monitor {
  constructor(options) {
    this.getWindow = options.getWindow;
    this.getSelfPids = options.getSelfPids;
    this.config = options.config;
    this.sensors = options.sensors;

    this.timers = { telemetry: null, processes: null };
    this.paused = false;
    this.stopped = false;
    this.processBusy = false;
    this.initPromise = null;

    this.latest = {
      memory: null,
      cpu: null,
      processes: null,
      sensors: null,
      sensorStatus: this.sensors.getStatus(),
      lastTelemetryAt: null,
      lastProcessesAt: null,
      lastSensorsAt: null
    };

    this.sensors.onSample = (sample, status) => {
      this.latest.sensors = sample;
      this.latest.sensorStatus = status;
      this.latest.lastSensorsAt = Date.now();
      this.broadcast('sensors:update', {
        sensors: sample,
        sensorStatus: status,
        timestamp: Date.now()
      });
    };
    this.sensors.onStatus = (status) => {
      this.latest.sensorStatus = status;
      this.broadcast('sensor-status', status);
    };
  }

  broadcast(channel, payload) {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.send(channel, payload);
    } catch (error) {
      logger.warn('Diffusion IPC impossible :', error.message);
    }
  }

  telemetryIntervalMs() {
    const { memoryMs, cpuMs } = this.config.refresh;
    return Math.max(500, Math.min(memoryMs, cpuMs));
  }

  refreshTelemetry() {
    const snapshot = memory.getMemorySnapshot();
    this.latest.memory = snapshot;
    const cpu = memory.sampleCpu();
    if (cpu) this.latest.cpu = cpu;
    this.latest.lastTelemetryAt = Date.now();

    this.broadcast('telemetry:update', {
      memory: snapshot,
      cpu: this.latest.cpu,
      sensors: this.latest.sensors,
      sensorStatus: this.latest.sensorStatus,
      timestamp: Date.now()
    });
  }

  async refreshProcesses() {
    if (this.processBusy) return this.latest.processes;
    this.processBusy = true;
    try {
      const snapshot = await listProcesses({ selfPids: this.getSelfPids() });
      this.latest.processes = snapshot;
      this.latest.lastProcessesAt = Date.now();
      this.broadcast('processes:update', {
        ...snapshot,
        totalBytes: this.latest.memory?.totalBytes || os.totalmem()
      });
      return snapshot;
    } catch (error) {
      logger.warn('Énumération des processus impossible :', error.message);
      this.broadcast('processes:error', { message: error.message, timestamp: Date.now() });
      return this.latest.processes;
    } finally {
      this.processBusy = false;
    }
  }

  startTimers() {
    this.stopTimers();
    this.timers.telemetry = setInterval(() => {
      if (!this.paused) this.refreshTelemetry();
    }, this.telemetryIntervalMs());
    this.timers.processes = setInterval(() => {
      if (!this.paused) this.refreshProcesses();
    }, this.config.refresh.processesMs);
  }

  stopTimers() {
    if (this.timers.telemetry) clearInterval(this.timers.telemetry);
    if (this.timers.processes) clearInterval(this.timers.processes);
    this.timers.telemetry = null;
    this.timers.processes = null;
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.refreshTelemetry();
      await this.refreshProcesses();
      this.startTimers();
      this.sensors.start();
    })();
    return this.initPromise;
  }

  async ensureReady() {
    if (!this.initPromise) await this.init();
    else await this.initPromise;
    if (!this.latest.processes) await this.refreshProcesses();
  }

  async refreshNow() {
    await this.ensureReady();
    this.refreshTelemetry();
    await this.refreshProcesses();
    return this.getBootstrap();
  }

  pause() {
    if (this.paused || this.stopped) return;
    this.paused = true;
    this.stopTimers();
    this.sensors.stop();
    this.broadcast('monitor:paused', { paused: true, timestamp: Date.now() });
  }

  resume() {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    memory.primeCpu();
    this.refreshTelemetry();
    this.refreshProcesses();
    this.startTimers();
    this.sensors.start();
    this.broadcast('monitor:paused', { paused: false, timestamp: Date.now() });
  }

  stop() {
    this.stopped = true;
    this.paused = true;
    this.stopTimers();
    this.sensors.stop();
  }

  getBootstrap() {
    return {
      memory: this.latest.memory,
      cpu: this.latest.cpu,
      processes: this.latest.processes,
      sensors: this.latest.sensors,
      sensorStatus: this.latest.sensorStatus,
      lastTelemetryAt: this.latest.lastTelemetryAt,
      lastProcessesAt: this.latest.lastProcessesAt,
      lastSensorsAt: this.latest.lastSensorsAt,
      paused: this.paused
    };
  }
}

module.exports = { Monitor };
