jest.mock('./service', () => ({ listen: jest.fn((port, callback) => callback()) }));
jest.mock('./database/database', () => ({ Role: { Admin: 'admin' }, DB: { addUser: jest.fn().mockResolvedValue({ id: 1 }) } }));
const originalArgv = process.argv;
beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { process.argv = originalArgv; jest.restoreAllMocks(); });
test.each([[[]], [['4000']]])('server listens on default or requested port %j', args => {
  process.argv = ['node', 'index.js', ...args];
  jest.isolateModules(() => {
    const app = require('./service');
    require('./index');
    expect(app.listen).toHaveBeenCalledWith(args[0] || 3000, expect.any(Function));
  });
});
test('admin initializer passes supplied credentials and role', async () => {
  process.argv = ['node', 'init.js', 'Admin', 'admin@test.com', 'secret'];
  jest.isolateModules(() => {
    const { DB } = require('./database/database');
    require('./init');
    expect(DB.addUser).toHaveBeenCalledWith({ name: 'Admin', email: 'admin@test.com', password: 'secret', roles: [{ role: 'admin' }] });
  });
  await Promise.resolve();
  expect(console.log).toHaveBeenCalledWith('created user: ', { id: 1 });
});
test('admin initializer exits with usage when arguments are missing', () => {
  process.argv = ['node', 'init.js'];
  jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  expect(() => jest.isolateModules(() => require('./init'))).toThrow('exit');
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
});
