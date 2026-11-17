const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./config.js');

const requests = new AsyncLocalStorage();
const apiPrefixes = new Set(['/api/auth', '/api/user', '/api/franchise', '/api/order']);
const numericFields = new Set(['id', 'userId', 'dinerId', 'franchiseId', 'storeId', 'menuId', 'objectId', 'price', 'totalRevenue', 'page', 'quantity']);
const objectFields = new Set(['order', 'orders', 'items', 'user', 'users', 'diner', 'admins', 'stores', 'roles', 'franchises']);
const safeMessages = new Set([
  'welcome to JWT Pizza', 'unknown endpoint', 'unauthorized', 'user deleted',
  'logout successful', 'franchise deleted', 'store deleted', 'Failed to fulfill order at factory',
  'name, email, and password are required',
]);

function sanitizeBody(body, depth = 0) {
  if (body === undefined || body === null) return null;
  if (depth >= 8) return '[truncated]';
  if (Array.isArray(body)) {
    const entries = body.slice(0, 25).map((entry) => sanitizeBody(entry, depth + 1));
    if (body.length > 25) entries.push('[truncated]');
    return entries;
  }
  if (typeof body !== 'object') return '[redacted]';

  const safe = {};
  let redacted = 0;
  for (const [key, value] of Object.entries(body)) {
    if (numericFields.has(key) && typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (objectFields.has(key)) safe[key] = sanitizeBody(value, depth + 1);
    else if (key === 'more' && typeof value === 'boolean') safe[key] = value;
    else if (key === 'role' && ['admin', 'diner', 'franchisee'].includes(value)) safe[key] = value;
    else if (key === 'message' && safeMessages.has(value)) safe[key] = value;
    else if (key === 'version' && typeof value === 'string' && /^\d{8}\.\d{6}$/.test(value)) safe[key] = value;
    else redacted++;
  }
  if (redacted) safe.redactedFields = redacted;
  return safe;
}

async function sendLog(event, fields) {
  const { source, endpointUrl, accountId, apiKey } = config.logging || {};
  if (!source || !endpointUrl || !accountId || !apiKey) return;
  const timestamp = (BigInt(Date.now()) * 1000000n).toString();
  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${accountId}:${apiKey}`).toString('base64')}`,
      },
      body: JSON.stringify({
        streams: [{ stream: { source, event }, values: [[timestamp, JSON.stringify(fields)]] }],
      }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) console.error('Loki rejected log delivery with status', response.status);
  } catch {
    console.error('Unable to deliver log to Loki');
  }
}

function requestFields(req, res) {
  const pathname = req.originalUrl.split('?')[0].toLowerCase();
  const prefix = pathname.split('/').slice(0, 3).join('/');
  const route = req.route?.path;
  let path = 'unmatched';
  if (pathname === '/') path = '/';
  else if (prefix === '/api/docs') path = prefix;
  else if (apiPrefixes.has(prefix)) path = route && route !== '*' && route !== '/' ? prefix + route : prefix;
  return {
    method: req.method,
    path,
    status: res.statusCode,
    hasAuthorization: Object.hasOwn(req.headers, 'authorization'),
    userId: Number.isSafeInteger(req.user?.id) ? req.user.id : null,
  };
}

function httpLogger(req, res, next) {
  const context = { req, requestBody: null, responseBody: null };
  const send = res.send;
  res.send = function (body) {
    if (typeof body === 'string' && this.getHeader('Content-Type')?.startsWith('application/json')) {
      try {
        context.responseBody = sanitizeBody(JSON.parse(body));
      } catch {
        context.responseBody = '[redacted]';
      }
    }
    return Reflect.apply(send, this, arguments);
  };
  res.once('finish', () => {
    void sendLog('http', {
      ...requestFields(req, res),
      requestBody: context.requestBody,
      responseBody: req.method === 'HEAD' || res.statusCode === 304 ? null : context.responseBody,
    });
  });
  requests.run(context, next);
}

function captureRequestBody(req, res, next) {
  requests.getStore().requestBody = sanitizeBody(req.body);
  next();
}

function databaseQuery(sql) {
  const userId = requests.getStore()?.req.user?.id;
  void sendLog('db', { sql, userId: Number.isSafeInteger(userId) ? userId : null });
}

function factoryCall(userId, requestBody, responseBody, status) {
  void sendLog('factory', {
    userId: Number.isSafeInteger(userId) ? userId : null,
    status: status ?? null,
    requestBody: sanitizeBody(requestBody),
    responseBody: sanitizeBody(responseBody),
  });
}

function exception(error, req, res) {
  const errorType = error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError' : 'Error';
  void sendLog('exception', {
    ...(req && res ? requestFields(req, res) : {}),
    errorType,
  });
}

module.exports = { httpLogger, captureRequestBody, databaseQuery, factoryCall, exception };
