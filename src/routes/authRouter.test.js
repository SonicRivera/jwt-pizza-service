const request = require('supertest');
const jwt = require('jsonwebtoken');
jest.mock('../database/database', () => ({
  Role: jest.requireActual('../model/model').Role,
  DB: Object.fromEntries(['addUser', 'getUser', 'loginUser', 'logoutUser', 'isLoggedIn', 'updateUser', 'getMenu', 'addMenuItem', 'getOrders', 'addDinerOrder', 'getFranchises', 'getUserFranchises', 'createFranchise', 'deleteFranchise', 'getFranchise', 'createStore', 'deleteStore'].map(name => [name, jest.fn()])),
}));
const { DB } = require('../database/database');
const config = require('../config');
const app = require('../service');
const user = { id: 7, name: 'pizza diner', email: 'reg@test.com', roles: [{ role: 'diner' }] };
const token = (role = 'diner', id = 7) => jwt.sign({ ...user, id, roles: [{ role }] }, config.jwtSecret);
const authorized = (method, path, role = 'diner', id = 7) => request(app)[method](path).set('Authorization', `Bearer ${token(role, id)}`);
beforeEach(() => {
  jest.resetAllMocks();
  DB.isLoggedIn.mockResolvedValue(true);
  DB.addUser.mockResolvedValue(user);
  DB.getUser.mockResolvedValue(user);
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected factory call'));
});
afterEach(() => jest.restoreAllMocks());

test('registration and login return a verifiable JWT and public user', async () => {
  const credentials = { name: user.name, email: user.email, password: 'a' };
  for (const method of ['post', 'put']) {
    const res = await request(app)[method]('/api/auth').send(credentials);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(user);
    expect(jwt.verify(res.body.token, config.jwtSecret)).toMatchObject(user);
    expect(DB.loginUser).toHaveBeenCalledWith(user.id, res.body.token);
  }
  expect(DB.addUser).toHaveBeenCalledWith({ ...credentials, roles: user.roles });
  expect(DB.getUser).toHaveBeenCalledWith(user.email, 'a');
});
test.each([{}, { name: 'n' }, { name: 'n', email: 'e' }])('registration rejects missing fields %j', async body => {
  expect((await request(app).post('/api/auth').send(body)).status).toBe(400);
  expect(DB.addUser).not.toHaveBeenCalled();
});
test('login errors propagate through the error handler', async () => {
  DB.getUser.mockRejectedValue(Object.assign(new Error('unknown user'), { statusCode: 404 }));
  const res = await request(app).put('/api/auth').send({ email: 'bad', password: 'bad' });
  expect(res.status).toBe(404);
  expect(res.body.message).toBe('unknown user');
});
test('logout revokes the authenticated token', async () => {
  const value = token();
  expect((await request(app).delete('/api/auth').set('Authorization', `Bearer ${value}`)).body).toEqual({ message: 'logout successful' });
  expect(DB.logoutUser).toHaveBeenCalledWith(value);
});
test.each([undefined, 'Bearer malformed', 'Bearer', `Bearer ${jwt.sign(user, 'wrong-secret')}`])('invalid authorization is rejected: %s', async header => {
  const req = request(app).get('/api/user/me');
  if (header) req.set('Authorization', header);
  expect((await req).status).toBe(401);
});
test('revoked tokens and database errors cannot authenticate', async () => {
  DB.isLoggedIn.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('offline'));
  expect((await authorized('get', '/api/user/me')).status).toBe(401);
  expect((await authorized('get', '/api/user/me')).status).toBe(401);
});
test('user can read their profile and update it with a new token', async () => {
  expect((await authorized('get', '/api/user/me')).body).toMatchObject(user);
  DB.updateUser.mockResolvedValue({ ...user, name: 'new' });
  const res = await authorized('put', '/api/user/7').send({ name: 'new', email: user.email, password: 'new-password' });
  expect(res.status).toBe(200);
  expect(DB.updateUser).toHaveBeenCalledWith(7, 'new', user.email, 'new-password');
  expect(jwt.verify(res.body.token, config.jwtSecret).name).toBe('new');
});
test('only administrators can update another user', async () => {
  expect((await authorized('put', '/api/user/8').send({ name: 'new' })).status).toBe(403);
  expect(DB.updateUser).not.toHaveBeenCalled();
  DB.updateUser.mockResolvedValue(user);
  expect((await authorized('put', '/api/user/8', 'admin').send({ name: 'new' })).status).toBe(200);
});
test('placeholder user endpoints retain their documented responses', async () => {
  expect((await authorized('get', '/api/user')).body).toEqual({ message: 'not implemented', users: [], more: false });
  expect((await authorized('delete', '/api/user/7')).body).toEqual({ message: 'not implemented' });
});
test('public endpoints return version, documentation, CORS and not-found responses', async () => {
  const res = await request(app).get('/').set('Origin', 'https://example.test');
  expect(res.body.version).toBe(require('../version.json').version);
  expect(res.headers['access-control-allow-origin']).toBe('https://example.test');
  const docs = await request(app).get('/api/docs');
  expect(docs.body.endpoints).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/api/auth' })]));
  expect(docs.headers['access-control-allow-origin']).toBe('*');
  expect((await request(app).get('/missing')).status).toBe(404);
});
test('menu is public but only administrators may add items', async () => {
  const menu = [{ id: 1, title: 'Veggie', price: 5 }];
  DB.getMenu.mockResolvedValue(menu);
  expect((await request(app).get('/api/order/menu')).body).toEqual(menu);
  expect((await authorized('put', '/api/order/menu').send(menu[0])).status).toBe(403);
  expect(DB.addMenuItem).not.toHaveBeenCalled();
  expect((await authorized('put', '/api/order/menu', 'admin').send(menu[0])).body).toEqual(menu);
  expect(DB.addMenuItem).toHaveBeenCalledWith(menu[0]);
});
test('orders are fetched for the authenticated diner and requested page', async () => {
  DB.getOrders.mockResolvedValue({ dinerId: 7, orders: [], page: 2 });
  expect((await authorized('get', '/api/order?page=2')).body.orders).toEqual([]);
  expect(DB.getOrders).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), '2');
});
test.each([true, false])('factory response is handled when ok=%s', async ok => {
  const order = { id: 4, franchiseId: 1, storeId: 2, items: [] };
  DB.addDinerOrder.mockResolvedValue(order);
  global.fetch.mockResolvedValue({ ok, json: async () => ({ jwt: 'pizza-token', reportUrl: 'https://report.test' }) });
  const res = await authorized('post', '/api/order').send(order);
  expect(res.status).toBe(ok ? 200 : 500);
  expect(res.body.followLinkToEndChaos).toBe('https://report.test');
  if (ok) expect(res.body).toMatchObject({ order, jwt: 'pizza-token' });
  else expect(res.body.message).toBe('Failed to fulfill order at factory');
  expect(global.fetch).toHaveBeenCalledWith(`${config.factory.url}/api/order`, expect.objectContaining({
    method: 'POST', body: JSON.stringify({ diner: { id: user.id, name: user.name, email: user.email }, order }),
    headers: expect.objectContaining({ authorization: 'Bearer test-key' }),
  }));
});
test('network failures become server errors', async () => {
  DB.addDinerOrder.mockResolvedValue({ id: 1 });
  const res = await authorized('post', '/api/order').send({ items: [] });
  expect(res.status).toBe(500);
  expect(res.body.message).toBe('Unexpected factory call');
});
test('franchise listing forwards filters and pagination', async () => {
  DB.getFranchises.mockResolvedValue([[{ id: 1 }], true]);
  expect((await request(app).get('/api/franchise?page=2&limit=3&name=Pizza*')).body).toEqual({ franchises: [{ id: 1 }], more: true });
  expect(DB.getFranchises).toHaveBeenCalledWith(undefined, '2', '3', 'Pizza*');
});
test('personal franchises are visible only to their user or an administrator', async () => {
  DB.getUserFranchises.mockResolvedValue([{ id: 1 }]);
  expect((await authorized('get', '/api/franchise/7')).body).toEqual([{ id: 1 }]);
  expect((await authorized('get', '/api/franchise/8')).body).toEqual([]);
  expect((await authorized('get', '/api/franchise/8', 'admin')).body).toEqual([{ id: 1 }]);
  expect(DB.getUserFranchises).toHaveBeenCalledTimes(2);
});
test('franchise creation requires administrator role', async () => {
  expect((await authorized('post', '/api/franchise').send({ name: 'Pizza' })).status).toBe(403);
  expect(DB.createFranchise).not.toHaveBeenCalled();
  DB.createFranchise.mockResolvedValue({ id: 3, name: 'Pizza' });
  expect((await authorized('post', '/api/franchise', 'admin').send({ name: 'Pizza' })).body).toEqual({ id: 3, name: 'Pizza' });
  expect(DB.createFranchise).toHaveBeenCalledWith({ name: 'Pizza' });
});
test('franchise deletion forwards numeric id', async () => {
  expect((await authorized('delete', '/api/franchise/3', 'admin')).body).toEqual({ message: 'franchise deleted' });
  expect(DB.deleteFranchise).toHaveBeenCalledWith(3);
});
describe.each(['post', 'delete'])('store %s authorization', method => {
  const path = method === 'post' ? '/api/franchise/3/store' : '/api/franchise/3/store/4';
  test.each([null, { id: 3, admins: [{ id: 8 }] }])('denies missing franchise or unrelated diner', async franchise => {
    DB.getFranchise.mockResolvedValue(franchise);
    expect((await authorized(method, path).send({ name: 'SLC' })).status).toBe(403);
    expect(DB.createStore).not.toHaveBeenCalled();
    expect(DB.deleteStore).not.toHaveBeenCalled();
  });
  test.each(['admin', 'franchisee'])('allows %s with appropriate access', async role => {
    DB.getFranchise.mockResolvedValue({ id: 3, admins: [{ id: 7 }] });
    DB.createStore.mockResolvedValue({ id: 4, name: 'SLC' });
    const res = await authorized(method, path, role).send({ name: 'SLC' });
    expect(res.status).toBe(200);
    if (method === 'post') {
      expect(res.body).toEqual({ id: 4, name: 'SLC' });
      expect(DB.createStore).toHaveBeenCalledWith(3, { name: 'SLC' });
    } else {
      expect(res.body).toEqual({ message: 'store deleted' });
      expect(DB.deleteStore).toHaveBeenCalledWith(3, 4);
    }
  });
});
