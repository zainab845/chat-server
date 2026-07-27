import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

export interface AuthSocket extends Socket {
  userId?: string;
  userName?: string;
  userEmail?: string;
  userRole?: 'user' | 'admin';
}

export function socketAuthMiddleware(
  socket: AuthSocket,
  next: (err?: Error) => void
) {
  // Token can come from auth header or handshake query
  // Next.js sends it via socket.io auth option
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.replace('Bearer ', '');

  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: string;
      name: string;
      email: string;
      role: 'user' | 'admin';
    };

    socket.userId = decoded.id;
    socket.userName = decoded.name;
    socket.userEmail = decoded.email;
    socket.userRole = decoded.role;

    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
}