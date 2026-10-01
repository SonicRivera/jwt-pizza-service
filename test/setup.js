// Never load developer credentials or connect to a real database in this suite.
jest.mock('../src/config.js', () => ({
  jwtSecret: 'jest-only-secret',
  db: { connection: { host: 'unused', user: 'test', password: 'test', database: 'pizza_test', connectTimeout: 1000 }, listPerPage: 10 },
  factory: { url: 'https://factory.invalid', apiKey: 'test-key' },
}), { virtual: true });
