const os = require('os');
const { randomUUID } = require('crypto');
const config = require('./config.js');

const timestamp = () => (BigInt(Date.now()) * 1000000n).toString();
const cpuTimes = () => os.cpus().reduce((sum, cpu) => {
  sum.idle += cpu.times.idle;
  sum.total += Object.values(cpu.times).reduce((total, time) => total + time, 0);
  return sum;
}, { idle: 0, total: 0 });
const latencyBounds = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const newLatency = () => ({ count: 0, sum: 0, buckets: Array(latencyBounds.length + 1).fill(0) });

class Metrics {
  constructor(settings = config.metrics || {}) {
    this.settings = settings;
    this.instance = randomUUID();
    this.startedAt = timestamp();
    this.requests = Object.fromEntries(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'OTHER'].map(method => [method, 0]));
    this.auth = { successful: 0, failed: 0 };
    this.users = new Map();
    this.endpointLatency = new Map();
    this.pizzasSold = 0;
    this.pizzaFailures = 0;
    this.revenue = 0;
    this.pizzaLatency = newLatency();
    this.previousCpu = cpuTimes();
    this.timer = null;
    this.sending = false;
    this.requestTracker = this.requestTracker.bind(this);
  }

  // Install before authentication and routes to include their latency and failures.
  requestTracker(req, res, next) {
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      const method = Object.hasOwn(this.requests, req.method) ? req.method : 'OTHER';
      this.requests[method]++;
      // Route templates avoid exporting IDs, query strings, or arbitrary URL paths.
      const endpoint = req.route && req.route.path !== '*' ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';
      const key = `${method} ${endpoint}`;
      if (!this.endpointLatency.has(key)) this.endpointLatency.set(key, newLatency());
      this.recordLatency(this.endpointLatency.get(key), Number(process.hrtime.bigint() - start) / 1e9);

      const path = req.originalUrl.split('?')[0].replace(/\/$/, '');
      if (path === '/api/auth' && ['POST', 'PUT'].includes(req.method)) {
        this.auth[res.statusCode < 400 ? 'successful' : 'failed']++;
      }
      if (req.user) {
        this.users.set(req.user.id, Date.now());
        if (path === '/api/auth' && req.method === 'DELETE' && res.statusCode < 400) this.users.delete(req.user.id);
      }
    });
    next();
  }

  // Call after registration/login succeeds, since those requests initially have no req.user.
  userActivity(userId) {
    this.users.set(userId, Date.now());
  }

  // latency is in seconds; price is the full order's revenue, in the application's currency.
  // Each entry in this application's order.items represents one pizza.
  pizzaPurchase(success, latency, price = 0, quantity = 1) {
    this.recordLatency(this.pizzaLatency, latency);
    if (success) {
      this.pizzasSold += Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
      this.revenue += Number.isFinite(price) ? Math.max(0, price) : 0;
    } else {
      this.pizzaFailures++;
    }
  }

  recordLatency(metric, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    metric.count++;
    metric.sum += seconds;
    const index = latencyBounds.findIndex(bound => seconds <= bound);
    metric.buckets[index < 0 ? latencyBounds.length : index]++;
  }

  buildPayload() {
    const timeUnixNano = timestamp();
    const attributes = (labels = {}) => Object.entries({ source: this.settings.source || 'jwt-pizza-service-dev', instance: this.instance, ...labels })
      .map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
    const point = (value, labels) => ({ attributes: attributes(labels), startTimeUnixNano: this.startedAt, timeUnixNano, asDouble: value });
    // Cumulative counters survive failed exports; use rate(metric[...]) * 60 in Grafana.
    const counter = (name, values, unit = '1') => ({ name, unit, sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: values.map(([value, labels]) => point(value, labels)) } });
    const gauge = (name, value, unit = '1') => ({ name, unit, gauge: { dataPoints: [point(value)] } });
    const histogram = (name, values) => ({
      name, unit: 's', histogram: {
        aggregationTemporality: 2,
        dataPoints: values.map(([value, labels]) => ({
          attributes: attributes(labels), startTimeUnixNano: this.startedAt, timeUnixNano,
          count: String(value.count), sum: value.sum, explicitBounds: latencyBounds,
          bucketCounts: value.buckets.map(String),
        })),
      },
    });

    // Active means a distinct authenticated user seen within the past five minutes.
    for (const [id, lastSeen] of this.users) {
      if (Date.now() - lastSeen >= 5 * 60 * 1000) this.users.delete(id);
    }
    const currentCpu = cpuTimes();
    const elapsedCpu = currentCpu.total - this.previousCpu.total;
    const cpuPercent = elapsedCpu > 0 ? 100 * (1 - (currentCpu.idle - this.previousCpu.idle) / elapsedCpu) : 0;
    this.previousCpu = currentCpu;
    // These are OS-wide measurements, matching the assignment's system metrics.
    const memoryPercent = 100 * (1 - os.freemem() / os.totalmem());
    const metrics = [
      counter('http_requests', Object.entries(this.requests).map(([method, value]) => [value, { method }])),
      counter('auth_attempts', Object.entries(this.auth).map(([result, value]) => [value, { result }])),
      gauge('active_users', this.users.size),
      gauge('cpu_usage_percent', Math.max(0, Math.min(100, cpuPercent)), '%'),
      gauge('memory_usage_percent', memoryPercent, '%'),
      counter('pizzas_sold', [[this.pizzasSold]]),
      counter('pizza_creation_failures', [[this.pizzaFailures]]),
      counter('pizza_revenue', [[this.revenue]]),
      histogram('pizza_creation_duration', [[this.pizzaLatency]]),
      histogram('http_request_duration', [...this.endpointLatency].map(([endpoint, value]) => [value, { endpoint }])),
    ];
    return {
      resourceMetrics: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: this.settings.source || 'jwt-pizza-service-dev' } }] },
        scopeMetrics: [{ scope: { name: 'jwt-pizza-service' }, metrics }],
      }],
    };
  }

  async sendMetrics() {
    const { endpointUrl, accountId, apiKey } = this.settings;
    if (!endpointUrl || !accountId || !apiKey || this.sending) return false;
    this.sending = true;
    try {
      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${accountId}:${apiKey}`).toString('base64')}`,
        },
        body: JSON.stringify(this.buildPayload()),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // OTLP can accept the HTTP request while rejecting individual data points.
      const result = await response.json();
      if (Number(result.partialSuccess?.rejectedDataPoints || 0) > 0) throw new Error('Grafana rejected metric data points');
      return true;
    } catch (error) {
      // Do not log credentials or the response body; reporting must not break the service.
      console.error('Error sending metrics:', error.message);
      return false;
    } finally {
      this.sending = false;
    }
  }

  sendMetricsPeriodically(period = 10000) {
    if (!Number.isFinite(period) || period < 1000) throw new Error('Metrics period must be at least 1000 milliseconds');
    if (this.timer || !this.settings.endpointUrl || !this.settings.accountId || !this.settings.apiKey) return;
    this.timer = setInterval(() => { void this.sendMetrics(); }, period);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

// Importing this module alone does not start timers or send data.
module.exports = new Metrics();
module.exports.Metrics = Metrics;
