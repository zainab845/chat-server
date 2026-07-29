import { Server } from 'socket.io';
import { AuthSocket } from '../middleware/socketAuth';
import Conversation from '../models/Conversation';
import Message from '../models/Message';

const adminSockets = new Set<string>();

// Track which conversation each admin has open right now
// so we can auto-mark messages as read in real time
const adminActiveConversation = new Map<string, string>(); // socketId → conversationId

export function registerChatHandlers(io: Server, socket: AuthSocket) {
  const userId = socket.userId!;
  const userName = socket.userName!;
  const userEmail = socket.userEmail || '';
  const userRole = socket.userRole!;

  // ── Admin connects ────────────────────────────────────────────────
  if (userRole === 'admin') {
    adminSockets.add(socket.id);
    socket.join('admin-room');

    // Join all open conversation rooms
    Conversation.find({ status: 'open' })
      .select('_id')
      .lean()
      .then(conversations => {
        conversations.forEach(conv => {
          socket.join(`conversation:${conv._id}`);
        });
      });

    socket.on('disconnect', () => {
      adminSockets.delete(socket.id);
      adminActiveConversation.delete(socket.id);
    });
  }

  // ── User connects ─────────────────────────────────────────────────
  if (userRole === 'user') {
    socket.join(`user:${userId}`);

    Conversation.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, userName, userEmail } },
      { upsert: true, new: true }
    ).then(conversation => {
      if (conversation) {
        socket.join(`conversation:${conversation._id}`);
        socket.emit('conversation_ready', {
          conversationId: conversation._id.toString(),
        });
      }
    });

    socket.on('disconnect', () => {
      // nothing extra needed
    });
  }

  // ── Send message ──────────────────────────────────────────────────
  socket.on('send_message', async (data: { conversationId: string; content: string }) => {
    const { conversationId, content } = data;
    if (!content?.trim()) return;

    try {
      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        socket.emit('error', { message: 'Conversation not found' });
        return;
      }

      // Check if any admin has THIS conversation open right now
      // If yes, mark the message as immediately read
      const isAdminReadingThisConversation = [...adminActiveConversation.entries()].some(
        ([, convId]) => convId === conversationId
      );

      const message = await Message.create({
        conversationId,
        senderId: userId,
        senderName: userName,
        senderRole: userRole === 'admin' ? 'admin' : 'user',
        content: content.trim(),
        // Auto-mark as read if admin has the conversation open
        read: userRole === 'user' ? isAdminReadingThisConversation : false,
      });

      if (userRole === 'user') {
        await Conversation.findByIdAndUpdate(conversationId, {
          lastMessage: content.trim(),
          lastMessageAt: new Date(),
          // Don't increment unread if admin is already reading
          $inc: { unreadByAdmin: isAdminReadingThisConversation ? 0 : 1 },
          userTyping: false,
        });
      } else {
        await Conversation.findByIdAndUpdate(conversationId, {
          lastMessage: content.trim(),
          lastMessageAt: new Date(),
          $inc: { unreadByUser: 1 },
          adminTyping: false,
        });
      }

      const messagePayload = {
        _id: message._id.toString(),
        conversationId,
        senderId: userId,
        senderName: userName,
        senderRole: message.senderRole,
        content: message.content,
        read: message.read,
        createdAt: message.createdAt,
      };

      // Broadcast to conversation room
      io.to(`conversation:${conversationId}`).emit('new_message', messagePayload);

      if (userRole === 'user') {
        // Notify admin sidebar
        const updatedConv = await Conversation.findById(conversationId).lean();
        io.to('admin-room').emit('conversation_updated', {
          conversationId,
          lastMessage: content.trim(),
          lastMessageAt: new Date(),
          unreadByAdmin: updatedConv?.unreadByAdmin ?? 0,
        });

        // If admin already has this conversation open, send immediate read receipt
        if (isAdminReadingThisConversation) {
          // Tell the user their message was instantly read
          io.to(`user:${userId}`).emit('messages_read', {
            conversationId,
            readBy: 'admin',
          });
        }

        // Make sure all admin sockets are in this conversation room
        for (const adminSocketId of adminSockets) {
          const adminSocket = io.sockets.sockets.get(adminSocketId);
          if (adminSocket) {
            adminSocket.join(`conversation:${conversationId}`);
          }
        }
      }
    } catch (error) {
      console.error('send_message error:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // ── Admin opens a conversation ────────────────────────────────────
  socket.on('admin_open_conversation', async (data: { conversationId: string }) => {
    if (userRole !== 'admin') return;

    const { conversationId } = data;

    // Track which conversation this admin has open
    adminActiveConversation.set(socket.id, conversationId);

    socket.join(`conversation:${conversationId}`);

    try {
      // Mark all unread user messages as read
      await Message.updateMany(
        { conversationId, senderRole: 'user', read: false },
        { read: true }
      );

      await Conversation.findByIdAndUpdate(conversationId, {
        unreadByAdmin: 0,
      });

      // Fetch last 50 messages
      const messages = await Message.find({ conversationId })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      socket.emit('message_history', {
        conversationId,
        messages: messages.reverse().map(m => ({
          ...m,
          _id: m._id.toString(),
          conversationId: m.conversationId.toString(),
        })),
      });

      // ── THIS IS THE KEY FIX ──────────────────────────────────────
      // Find who owns this conversation and send them a read receipt
      const conversation = await Conversation.findById(conversationId)
        .select('userId')
        .lean();

      if (conversation?.userId) {
        // Emit to the conversation room (catches user if they're there)
        io.to(`conversation:${conversationId}`).emit('messages_read', {
          conversationId,
          readBy: 'admin',
        });

        // Also emit directly to user's personal room as a guaranteed fallback
        io.to(`user:${conversation.userId}`).emit('messages_read', {
          conversationId,
          readBy: 'admin',
        });
      }
    } catch (error) {
      console.error('admin_open_conversation error:', error);
    }
  });

  // Admin closes/changes conversation — stop tracking it as active
  socket.on('admin_close_active', () => {
    if (userRole !== 'admin') return;
    adminActiveConversation.delete(socket.id);
  });

  // ── User loads history ────────────────────────────────────────────
  socket.on('load_history', async (data: { conversationId: string }) => {
    const { conversationId } = data;

    try {
      const messages = await Message.find({ conversationId })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      socket.emit('message_history', {
        conversationId,
        messages: messages.reverse().map(m => ({
          ...m,
          _id: m._id.toString(),
          conversationId: m.conversationId.toString(),
        })),
      });

      // Mark admin messages as read by user
      await Message.updateMany(
        { conversationId, senderRole: { $in: ['admin', 'ai'] }, read: false },
        { read: true }
      );

      await Conversation.findByIdAndUpdate(conversationId, {
        unreadByUser: 0,
      });
    } catch (error) {
      console.error('load_history error:', error);
    }
  });

  // ── Typing indicators ─────────────────────────────────────────────
  socket.on('typing_start', async (data: { conversationId: string }) => {
    const { conversationId } = data;

    if (userRole === 'user') {
      await Conversation.findByIdAndUpdate(conversationId, { userTyping: true });
    } else {
      await Conversation.findByIdAndUpdate(conversationId, { adminTyping: true });
    }

    socket.to(`conversation:${conversationId}`).emit('typing_update', {
      conversationId,
      who: userRole,
      typing: true,
    });
  });

  socket.on('typing_stop', async (data: { conversationId: string }) => {
    const { conversationId } = data;

    if (userRole === 'user') {
      await Conversation.findByIdAndUpdate(conversationId, { userTyping: false });
    } else {
      await Conversation.findByIdAndUpdate(conversationId, { adminTyping: false });
    }

    socket.to(`conversation:${conversationId}`).emit('typing_update', {
      conversationId,
      who: userRole,
      typing: false,
    });
  });

  // ── Get all conversations (admin) ─────────────────────────────────
  socket.on('get_conversations', async () => {
    if (userRole !== 'admin') return;

    try {
      const conversations = await Conversation.find()
        .sort({ lastMessageAt: -1 })
        .lean();

      socket.emit('conversations_list', { conversations });
    } catch (error) {
      console.error('get_conversations error:', error);
    }
  });

  // ── Close conversation ────────────────────────────────────────────
  socket.on('close_conversation', async (data: { conversationId: string }) => {
    if (userRole !== 'admin') return;

    await Conversation.findByIdAndUpdate(data.conversationId, { status: 'closed' });
    adminActiveConversation.delete(socket.id);

    io.to(`conversation:${data.conversationId}`).emit('conversation_closed', {
      conversationId: data.conversationId,
    });
  });

  // ── Reopen conversation ───────────────────────────────────────────
  socket.on('reopen_conversation', async (data: { conversationId: string }) => {
    if (userRole !== 'admin') return;

    try {
      await Conversation.findByIdAndUpdate(data.conversationId, { status: 'open' });
      
      // Notify the admin sidebar so it removes the "Closed" badge
      io.to('admin-room').emit('conversation_reopened', {
        conversationId: data.conversationId,
      });

      // Notify the conversation room so the chat unlocks for the user
      io.to(`conversation:${data.conversationId}`).emit('conversation_reopened', {
        conversationId: data.conversationId,
      });
    } catch (error) {
      console.error('reopen_conversation error:', error);
    }
  });
}