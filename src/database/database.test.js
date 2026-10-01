jest.mock('mysql2/promise', () => ({ createConnection: jest.fn() }));
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const connection = {
  execute: jest.fn().mockResolvedValue([[{ SCHEMA_NAME: 'pizza_test' }]]),
  query: jest.fn().mockResolvedValue([]), end: jest.fn(),
  beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(),
};
mysql.createConnection.mockResolvedValue(connection);
const log = jest.spyOn(console, 'log').mockImplementation(() => {});
const { DB, Role } = require('./database');

beforeAll(async () => { await DB.initialized; log.mockRestore(); });
beforeEach(() => {
  jest.clearAllMocks();
  connection.execute.mockReset().mockResolvedValue([[]]);
  connection.query.mockReset().mockResolvedValue([]);
  mysql.createConnection.mockReset().mockResolvedValue(connection);
});
afterEach(() => jest.restoreAllMocks());
const results = (...values) => values.forEach(value => connection.execute.mockResolvedValueOnce([value]));

test('menu rows and inserted ids are returned, and connections close', async () => {
  const item = { title: 'Veggie', description: 'greens', image: 'pizza.png', price: 5 };
  results([{ ...item, id: 2 }], { insertId: 3 });
  expect(await DB.getMenu()).toEqual([{ ...item, id: 2 }]);
  expect(await DB.addMenuItem(item)).toEqual({ ...item, id: 3 });
  expect(connection.execute).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO menu'), ['Veggie', 'greens', 'pizza.png', 5]);
  expect(connection.end).toHaveBeenCalledTimes(2);
});
test('query failures propagate and still close the connection', async () => {
  connection.execute.mockRejectedValueOnce(new Error('offline'));
  await expect(DB.getMenu()).rejects.toThrow('offline');
  expect(connection.end).toHaveBeenCalledTimes(1);
});
test('new users get hashed passwords and diner/franchise roles', async () => {
  const user = { name: 'Diner', email: 'd@test.com', password: 'secret', roles: [{ role: Role.Diner }, { role: Role.Franchisee, object: 'Pizza' }] };
  results({ insertId: 7 }, {}, [{ id: 3 }], {});
  expect(await DB.addUser(user)).toEqual({ ...user, id: 7, password: undefined });
  const storedPassword = connection.execute.mock.calls[0][1][2];
  expect(storedPassword).not.toBe('secret');
  expect(await bcrypt.compare('secret', storedPassword)).toBe(true);
  expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO userRole'), [7, Role.Diner, 0]);
  expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO userRole'), [7, Role.Franchisee, 3]);
});
test('user lookup checks password, maps roles, and hides password hash', async () => {
  const password = await bcrypt.hash('secret', 4);
  results([{ id: 7, email: 'd@test.com', password }], [{ role: Role.Diner, objectId: 0 }, { role: Role.Franchisee, objectId: 3 }]);
  expect(await DB.getUser('d@test.com', 'secret')).toEqual({ id: 7, email: 'd@test.com', password: undefined, roles: [{ role: Role.Diner, objectId: undefined }, { role: Role.Franchisee, objectId: 3 }] });
  expect(connection.end).toHaveBeenCalled();
});
test('unknown users and wrong passwords are rejected', async () => {
  results([], [{ password: await bcrypt.hash('secret', 4) }]);
  await expect(DB.getUser('missing', 'secret')).rejects.toMatchObject({ statusCode: 404 });
  await expect(DB.getUser('d@test.com', 'wrong')).rejects.toMatchObject({ statusCode: 404 });
  expect(connection.end).toHaveBeenCalledTimes(2);
});
test('internal user lookup supports omission of password', async () => {
  results([{ id: 7, password: 'hash' }], []);
  expect(await DB.getUser('d@test.com')).toEqual({ id: 7, password: undefined, roles: [] });
});
test('updating supplied fields hashes password and reloads user', async () => {
  const reload = jest.spyOn(DB, 'getUser').mockResolvedValue({ id: 7 });
  expect(await DB.updateUser(7, 'New', 'new@test.com', 'secret')).toEqual({ id: 7 });
  const sql = connection.execute.mock.calls[0][0];
  expect(sql).toContain("email='new@test.com'");
  expect(sql).toContain("name='New'");
  expect(sql).toContain('WHERE id=7');
  expect(await bcrypt.compare('secret', sql.match(/password='([^']+)'/)[1])).toBe(true);
  expect(reload).toHaveBeenCalledWith('new@test.com', 'secret');
});
test('an empty update does not issue UPDATE', async () => {
  jest.spyOn(DB, 'getUser').mockResolvedValue({ id: 7 });
  await DB.updateUser(7);
  expect(connection.execute).not.toHaveBeenCalled();
  expect(connection.end).toHaveBeenCalled();
});
test('authentication persists only token signatures and detects revoked tokens', async () => {
  results({}, [{ userId: 7 }], [], {});
  await DB.loginUser(7, 'header.payload.signature');
  expect(connection.execute).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO auth'), ['signature', 7]);
  expect(await DB.isLoggedIn('header.payload.signature')).toBe(true);
  expect(await DB.isLoggedIn('header.payload.signature')).toBe(false);
  await DB.logoutUser('header.payload.signature');
  expect(connection.execute).toHaveBeenLastCalledWith('DELETE FROM auth WHERE token=?', ['signature']);
  expect(DB.getTokenSignature('invalid')).toBe('');
});
test('orders include their items and correct pagination', async () => {
  results([{ id: 5, storeId: 2 }], [{ id: 9, menuId: 3, price: 5 }]);
  expect(await DB.getOrders({ id: 7 }, 2)).toEqual({ dinerId: 7, page: 2, orders: [{ id: 5, storeId: 2, items: [{ id: 9, menuId: 3, price: 5 }] }] });
  expect(connection.execute).toHaveBeenNthCalledWith(1, expect.stringContaining('LIMIT 10,10'), [7]);
  expect(await DB.getOrders({ id: 7 })).toEqual({ dinerId: 7, page: 1, orders: [] });
  expect(DB.getOffset(undefined, 10)).toBe(0);
});
test('new orders resolve menu references and insert items', async () => {
  const order = { franchiseId: 1, storeId: 2, items: [{ menuId: 3, description: 'Veggie', price: 5 }] };
  results({ insertId: 8 }, [{ id: 3 }], {});
  expect(await DB.addDinerOrder({ id: 7 }, order)).toEqual({ ...order, id: 8 });
  expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO dinerOrder'), [7, 1, 2]);
  expect(connection.execute).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO orderItem'), [8, 3, 'Veggie', 5]);
});
test('missing menu ids reject an order and release the connection', async () => {
  results({ insertId: 8 }, []);
  await expect(DB.addDinerOrder({ id: 7 }, { items: [{ menuId: 99 }] })).rejects.toThrow('No ID found');
  expect(connection.end).toHaveBeenCalled();
});
test('franchise creation resolves administrators and assigns franchise roles', async () => {
  results([{ id: 7, name: 'Owner' }], { insertId: 3 }, {});
  const franchise = { name: 'Pizza', admins: [{ email: 'owner@test.com' }] };
  expect(await DB.createFranchise(franchise)).toEqual({ id: 3, name: 'Pizza', admins: [{ id: 7, name: 'Owner', email: 'owner@test.com' }] });
  expect(connection.execute).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO userRole'), [7, Role.Franchisee, 3]);
});
test('unknown franchise administrators are rejected before insertion', async () => {
  await expect(DB.createFranchise({ name: 'Pizza', admins: [{ email: 'missing' }] })).rejects.toMatchObject({ statusCode: 404 });
  expect(connection.execute).toHaveBeenCalledTimes(1);
  expect(connection.end).toHaveBeenCalled();
});
test('franchise deletion commits all dependent deletes', async () => {
  await DB.deleteFranchise(3);
  expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
  expect(connection.execute.mock.calls.map(call => call[1])).toEqual([[3], [3], [3]]);
  expect(connection.commit).toHaveBeenCalledTimes(1);
  expect(connection.rollback).not.toHaveBeenCalled();
});
test('failed franchise deletion rolls back and closes the connection', async () => {
  connection.execute.mockRejectedValueOnce(new Error('constraint'));
  await expect(DB.deleteFranchise(3)).rejects.toMatchObject({ statusCode: 500, message: 'unable to delete franchise' });
  expect(connection.rollback).toHaveBeenCalledTimes(1);
  expect(connection.commit).not.toHaveBeenCalled();
  expect(connection.end).toHaveBeenCalled();
});
test('public franchise listing applies wildcard, limit and more flag', async () => {
  results([{ id: 3 }, { id: 4 }], [{ id: 5, name: 'SLC' }]);
  expect(await DB.getFranchises(undefined, 2, 1, 'Pizza*')).toEqual([[{ id: 3, stores: [{ id: 5, name: 'SLC' }] }], true]);
  expect(connection.execute).toHaveBeenNthCalledWith(1, expect.stringContaining('LIMIT 2 OFFSET 2'), ['Pizza%']);
});
test('admin listing includes franchise details while diner listing stays public', async () => {
  const details = jest.spyOn(DB, 'getFranchise').mockImplementation(async f => { f.admins = []; return f; });
  results([{ id: 3 }]);
  expect(await DB.getFranchises({ isRole: () => true })).toEqual([[{ id: 3, admins: [] }], false]);
  expect(details).toHaveBeenCalledWith({ id: 3, admins: [] });
  results([{ id: 4 }], []);
  expect(await DB.getFranchises({ isRole: () => false })).toEqual([[{ id: 4, stores: [] }], false]);
});
test('user franchise lookup handles no roles and expands matching franchises', async () => {
  expect(await DB.getUserFranchises(7)).toEqual([]);
  results([{ objectId: 3 }], [{ id: 3, name: 'Pizza' }], [{ id: 7 }], [{ id: 2, totalRevenue: 10 }]);
  expect(await DB.getUserFranchises(7)).toEqual([{ id: 3, name: 'Pizza', admins: [{ id: 7 }], stores: [{ id: 2, totalRevenue: 10 }] }]);
});
test('stores are created and deleted within their franchise', async () => {
  results({ insertId: 4 }, {});
  expect(await DB.createStore(3, { name: 'SLC' })).toEqual({ id: 4, franchiseId: 3, name: 'SLC' });
  await DB.deleteStore(3, 4);
  expect(connection.execute).toHaveBeenLastCalledWith('DELETE FROM store WHERE franchiseId=? AND id=?', [3, 4]);
});
test.each([true, false])('database initialization handles existing=%s', async exists => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const addUser = jest.spyOn(DB, 'addUser').mockResolvedValue({ id: 1 });
  results(exists ? [{ SCHEMA_NAME: 'pizza_test' }] : []);
  await DB.initializeDatabase();
  expect(connection.query).toHaveBeenCalledWith('CREATE DATABASE IF NOT EXISTS pizza_test');
  for (const sql of require('./dbModel').tableCreateStatements) expect(connection.query).toHaveBeenCalledWith(sql);
  expect(addUser).toHaveBeenCalledTimes(exists ? 0 : 1);
  if (!exists) expect(addUser).toHaveBeenCalledWith(expect.objectContaining({ roles: [{ role: Role.Admin }] }));
  expect(connection.end).toHaveBeenCalled();
});
test('initialization errors are reported and the connection closes', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  connection.execute.mockRejectedValueOnce(new Error('unavailable'));
  await DB.initializeDatabase();
  expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ message: 'Error initializing database', exception: 'unavailable' });
  expect(connection.end).toHaveBeenCalled();
});
