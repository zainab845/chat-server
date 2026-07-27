import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';

import { socketAuthMiddleware } from './middleware/socketAuth';
import { registerChatHandlers } from './handlers/chatHandlers';
import Conversation from './models/Conversation';

dotenv.config();

const app = express();
const server = http.createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

// Socket.io with CORS for Next.js origin
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());

// ── REST endpoints (for initial data loads without sockets) ─────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Admin: get all conversations (REST fallback)
app.get('/conversations', async (_req, res) => {
  try {
    const conversations = await Conversation.find()
      .sort({ lastMessageAt: -1 })
      .lean();
    res.json({ conversations });
  } catch {
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ── Socket.io auth middleware ────────────────────────────────────────
io.use(socketAuthMiddleware as any);

// ── Socket.io connection ─────────────────────────────────────────────
io.on('connection', socket => {
  registerChatHandlers(io, socket as any);
});

// ── MongoDB connection ───────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI!;

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not defined in .env');
  process.exit(1);
}

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log('MongoDB connected');

    const PORT = process.env.PORT || 3001;
    server.listen(PORT, () => {
      console.log(`Chat server running on port ${PORT}`);
      console.log(`Accepting connections from: ${CLIENT_URL}`);
    });
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => {
    mongoose.connection.close();
    console.log('Chat server shut down');
  });
});