const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('mysql2/promise', () => ({ createConnection: jest.fn() }));
const mysql = require('mysql2/promise');
const config = require('./config.js');

const connection = {
  execute: jest.fn(),
  query: jest.fn().mockResolvedValue([]),
  end: jest.fn(),
};
mysql.createConnection.mockResolvedValue(connection);
connection.execute.mockResolvedValue([[{ SCHEMA_NAME: 'pizza_test' }]]);

const { DB } = require('./database/database.js');
const app = require('./service.js');
const endpointUrl = 'https://loki.invalid/loki/api/v1/push';
const source = 'jwt-pizza-service-test';
const user = { id: 7, name: 'PRIVATE_NAME', email: 'PRIVATE_EMAIL', roles: [{ role: 'diner' }] };
const authorization = `Bearer ${jwt.sign(user, config.jwtSecret)}`;

let fetchMock;

beforeAll(() => DB.initialized);
beforeEach(() => {
  config.logging = { source, endpointUrl, accountId: '42', apiKey: 'PRIVATE_API_KEY' };
  connection.execute.mockReset();
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 204 });
});
afterEach(() => {
  delete config.logging;
  jest.restoreAllMocks();
});

function events() {
  return fetchMock.mock.calls.filter(([url]) => url === endpointUrl).map(([, options]) => {
    const [stream] = JSON.parse(options.body).streams;
    const [[timestamp, line]] = stream.values;
    expect(stream.stream.source).toBe(source);
    expect(timestamp).toMatch(/^\d{19}$/);
    expect(options.headers.Authorization).toBe('Basic ' + Buffer.from('42:PRIVATE_API_KEY').toString('base64'));
    expect(line).not.toContain('PRIVATE_');
    expect(line).not.toContain(authorization);
    return { event: stream.stream.event, ...JSON.parse(line) };
  });
}

test('captures anonymous HTTP and SQL events, including sanitized response data', async () => {
  connection.execute.mockResolvedValueOnce([[{ id: 1, title: 'Veggie', description: 'PRIVATE_DESCRIPTION', price: 5 }]]);
  await request(app).get('/api/order/menu?key=PRIVATE_QUERY').expect(200);

  expect(events()).toEqual([
    { event: 'db', sql: 'SELECT * FROM menu', userId: null },
    {
      event: 'http', method: 'GET', path: '/api/order/menu', status: 200,
      hasAuthorization: false, userId: null, requestBody: {},
      responseBody: [{ id: 1, price: 5, redactedFields: 2 }],
    },
  ]);
});

test('records sanitized factory bodies and attributes SQL and HTTP to the verified diner', async () => {
  connection.execute
    .mockResolvedValueOnce([[{ userId: 7 }]])
    .mockResolvedValueOnce([{ insertId: 8 }])
    .mockResolvedValueOnce([[{ id: 3 }]])
    .mockResolvedValueOnce([{}]);
  fetchMock.mockImplementation(async (url) => url === endpointUrl
    ? { ok: true, status: 204 }
    : { ok: true, status: 200, json: async () => ({ jwt: 'PRIVATE_JWT', reportUrl: 'PRIVATE_URL', order: { id: 8 } }) });
  const order = { franchiseId: 1, storeId: 2, items: [{ menuId: 3, price: 5, description: 'PRIVATE_TEXT' }], password: 'PRIVATE_PASSWORD' };
  await request(app).post('/api/order').set('Authorization', authorization).send(order).expect(200);

  const records = events();
  expect(records).toContainEqual({ event: 'db', sql: 'SELECT id FROM menu WHERE id=?', userId: 7 });
  expect(records).toContainEqual({
    event: 'factory', userId: 7, status: 200,
    requestBody: { diner: { id: 7, redactedFields: 2 }, order: { id: 8, franchiseId: 1, storeId: 2, items: [{ menuId: 3, price: 5, redactedFields: 1 }], redactedFields: 1 } },
    responseBody: { order: { id: 8 }, redactedFields: 2 },
  });
  expect(records).toContainEqual(expect.objectContaining({
    event: 'http', method: 'POST', path: '/api/order', status: 200, hasAuthorization: true,
    userId: 7, requestBody: { franchiseId: 1, storeId: 2, items: [{ menuId: 3, price: 5, redactedFields: 1 }], redactedFields: 1 },
  }));
});

test('captures an unexpected error without exporting its message or stack', async () => {
  connection.execute.mockRejectedValueOnce(new TypeError('PRIVATE_DATABASE_ERROR'));
  await request(app).get('/api/order/menu').expect(500);

  expect(events()).toContainEqual({
    event: 'exception', method: 'GET', path: '/api/order/menu', status: 500,
    userId: null, hasAuthorization: false, errorType: 'TypeError',
  });
  expect(events()).toContainEqual(expect.objectContaining({ event: 'http', status: 500, responseBody: { redactedFields: 2 } }));
});

test('Loki rejection and network failures leave a successful HTTP response intact', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock.mockResolvedValueOnce({ ok: false, status: 429 }).mockRejectedValueOnce(new Error('PRIVATE_NETWORK_FAILURE'));
  await request(app).get('/').expect(200);
  await request(app).get('/').expect(200);
  expect(error.mock.calls).toEqual([
    ['Loki rejected log delivery with status', 429],
    ['Unable to deliver log to Loki'],
  ]);
});
