import { Server } from 'socket.io';
import { AuthSocket } from '../middleware/socketAuth';
import Conversation from '../models/Conversation';
import Message from '../models/Message';

// Admin's socket ID — we keep track so we can ping the admin room
const adminSockets = new Set<string>();

export function registerChatHandlers(io: Server, socket: AuthSocket) {
  const userId = socket.userId!;
  const userName = socket.userName!;
  const userEmail = socket.userEmail!;
  const userRole = socket.userRole!;

  // ── Admin connects ────────────────────────────────────────────────
  if (userRole === 'admin') {
    adminSockets.add(socket.id);
    socket.join('admin-room');
    console.log(`Admin ${userName} connected (${socket.id})`);

    // Admin joins all open conversations so they receive messages from any user
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
      console.log(`Admin ${userName} disconnected`);
    });
  }

  // ── User connects ─────────────────────────────────────────────────
  if (userRole === 'user') {
    console.log(`User ${userName} connected (${socket.id})`);

    // Join their personal room immediately
    socket.join(`user:${userId}`);

    // Find or create this user's conversation
    Conversation.findOneAndUpdate(
      { userId },
      {
        $setOnInsert: { userId, userName, userEmail },
      },
      { upsert: true, new: true }
    ).then(conversation => {
      if (conversation) {
        socket.join(`conversation:${conversation._id}`);
        // Tell the user their conversation ID
        socket.emit('conversation_ready', { conversationId: conversation._id });
      }
    });

    socket.on('disconnect', () => {
      console.log(`User ${userName} disconnected`);
    });
  }

  // ── Send message ──────────────────────────────────────────────────
  socket.on(
    'send_message',
    async (data: { conversationId: string; content: string }) => {
      const { conversationId, content } = data;

      if (!content?.trim()) return;

      try {
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          socket.emit('error', { message: 'Conversation not found' });
          return;
        }

        // Save message to MongoDB
        const message = await Message.create({
          conversationId,
          senderId: userId,
          senderName: userName,
          senderRole: userRole === 'admin' ? 'admin' : 'user',
          content: content.trim(),
          read: false,
        });

        // Update conversation's last message
        if (userRole === 'user') {
          await Conversation.findByIdAndUpdate(conversationId, {
            lastMessage: content.trim(),
            lastMessageAt: new Date(),
            $inc: { unreadByAdmin: 1 },
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
          _id: message._id,
          conversationId,
          senderId: userId,
          senderName: userName,
          senderRole: message.senderRole,
          content: message.content,
          read: false,
          createdAt: message.createdAt,
        };

        // Broadcast to everyone in this conversation room
        io.to(`conversation:${conversationId}`).emit(
          'new_message',
          messagePayload
        );

        // If the message is from a user, also notify the admin room
        if (userRole === 'user') {
          io.to('admin-room').emit('conversation_updated', {
            conversationId,
            lastMessage: content.trim(),
            lastMessageAt: new Date(),
            unreadByAdmin: conversation.unreadByAdmin + 1,
          });

          // Make sure all admins are joined to this conversation room
          // (in case admin connected before this conversation existed)
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
    }
  );

  // ── Admin opens a conversation ────────────────────────────────────
  // Join a specific user's conversation room and mark messages as read
  socket.on(
    'admin_open_conversation',
    async (data: { conversationId: string }) => {
      if (userRole !== 'admin') return;

      const { conversationId } = data;
      socket.join(`conversation:${conversationId}`);

      try {
        // Mark all user messages in this conversation as read
        await Message.updateMany(
          { conversationId, senderRole: 'user', read: false },
          { read: true }
        );

        // Reset unread count
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
          messages: messages.reverse(),
        });

        // Tell everyone in the room the messages are now read
        io.to(`conversation:${conversationId}`).emit('messages_read', {
          conversationId,
          readBy: 'admin',
        });
      } catch (error) {
        console.error('admin_open_conversation error:', error);
      }
    }
  );

  // ── User loads their message history ─────────────────────────────
  socket.on(
    'load_history',
    async (data: { conversationId: string }) => {
      const { conversationId } = data;

      try {
        const messages = await Message.find({ conversationId })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean();

        socket.emit('message_history', {
          conversationId,
          messages: messages.reverse(),
        });

        // Mark admin messages as read by user
        await Message.updateMany(
          { conversationId, senderRole: 'admin', read: false },
          { read: true }
        );

        await Conversation.findByIdAndUpdate(conversationId, {
          unreadByUser: 0,
        });
      } catch (error) {
        console.error('load_history error:', error);
      }
    }
  );

  // ── Typing indicators ─────────────────────────────────────────────
  socket.on(
    'typing_start',
    async (data: { conversationId: string }) => {
      const { conversationId } = data;

      if (userRole === 'user') {
        await Conversation.findByIdAndUpdate(conversationId, {
          userTyping: true,
        });
      } else {
        await Conversation.findByIdAndUpdate(conversationId, {
          adminTyping: true,
        });
      }

      // Broadcast to the other party only
      socket.to(`conversation:${conversationId}`).emit('typing_update', {
        conversationId,
        who: userRole,
        typing: true,
      });
    }
  );

  socket.on(
    'typing_stop',
    async (data: { conversationId: string }) => {
      const { conversationId } = data;

      if (userRole === 'user') {
        await Conversation.findByIdAndUpdate(conversationId, {
          userTyping: false,
        });
      } else {
        await Conversation.findByIdAndUpdate(conversationId, {
          adminTyping: false,
        });
      }

      socket.to(`conversation:${conversationId}`).emit('typing_update', {
        conversationId,
        who: userRole,
        typing: false,
      });
    }
  );

  // ── Admin fetches all conversations ──────────────────────────────
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

  // ── Admin closes a conversation ───────────────────────────────────
  socket.on(
    'close_conversation',
    async (data: { conversationId: string }) => {
      if (userRole !== 'admin') return;

      await Conversation.findByIdAndUpdate(data.conversationId, {
        status: 'closed',
      });

      io.to(`conversation:${data.conversationId}`).emit(
        'conversation_closed',
        { conversationId: data.conversationId }
      );
    }
  );
}