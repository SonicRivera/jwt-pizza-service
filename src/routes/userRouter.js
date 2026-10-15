const express = require('express');
const { asyncHandler } = require('../endpointHelper.js');
const { DB, Role } = require('../database/database.js');
const { authRouter, setAuth } = require('./authRouter.js');

const userRouter = express.Router();

userRouter.docs = [
  {
    method: 'GET',
    path: '/api/user?page=0&limit=10&name=*',
    requiresAuth: true,
    description: 'List users (admin only). Pages start at zero; limit is 1–100; * is a name wildcard.',
    example: `curl localhost:3000/api/user -H 'Authorization: Bearer tttttt'`,
    response: { users: [{ id: 1, name: 'Mama Ricci', email: 'a@jwt.com', roles: [{ role: 'admin' }] }], more: false },
  },
  {
    method: 'DELETE',
    path: '/api/user/:userId',
    requiresAuth: true,
    description: 'Delete any user and revoke their sessions (admin only)',
    example: `curl -X DELETE localhost:3000/api/user/2 -H 'Authorization: Bearer tttttt'`,
    response: { message: 'user deleted' },
  },
  {
    method: 'GET',
    path: '/api/user/me',
    requiresAuth: true,
    description: 'Get authenticated user',
    example: `curl -X GET localhost:3000/api/user/me -H 'Authorization: Bearer tttttt'`,
    response: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] },
  },
  {
    method: 'PUT',
    path: '/api/user/:userId',
    requiresAuth: true,
    description: 'Update user',
    example: `curl -X PUT localhost:3000/api/user/1 -d '{"name":"常用名字", "email":"a@jwt.com", "password":"admin"}' -H 'Content-Type: application/json' -H 'Authorization: Bearer tttttt'`,
    response: { user: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] }, token: 'tttttt' },
  },
];

// getUser
userRouter.get(
  '/me',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    res.json(req.user);
  })
);

// updateUser
userRouter.put(
  '/:userId',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    const userId = Number(req.params.userId);
    const user = req.user;
    if (user.id !== userId && !user.isRole(Role.Admin)) {
      return res.status(403).json({ message: 'unauthorized' });
    }

    const updatedUser = await DB.updateUser(userId, name, email, password);
    const auth = await setAuth(updatedUser);
    res.json({ user: updatedUser, token: auth });
  })
);

// deleteUser
userRouter.delete(
  '/:userId',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    if (!req.user.isRole(Role.Admin)) {
      return res.status(403).json({ message: 'unauthorized' });
    }
    const userId = Number(req.params.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'invalid user id' });
    }
    await DB.deleteUser(userId);
    res.json({ message: 'user deleted' });
  })
);

// listUsers
userRouter.get(
  '/',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    if (!req.user.isRole(Role.Admin)) {
      return res.status(403).json({ message: 'unauthorized' });
    }
    const page = Number(req.query.page ?? 0);
    const limit = Number(req.query.limit ?? 10);
    const name = req.query.name ?? '*';
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(page * limit) || typeof name !== 'string') {
      return res.status(400).json({ message: 'invalid pagination or name filter' });
    }
    const [users, more] = await DB.getUsers(page, limit, name);
    res.json({ users, more });
  })
);

module.exports = userRouter;
