import { Server } from 'socket.io';
import { AuthSocket } from '../middleware/socketAuth';
import Conversation from '../models/Conversation';
import Message from '../models/Message';
import { generateAIResponse } from '../services/geminiService';

const adminSockets = new Set<string>();
const adminActiveConversation = new Map<string, string>();

// Timer tracking — one timer per conversation
// Cancelled when admin replies, fires Gemini after 30 seconds
const aiResponseTimers = new Map<string, NodeJS.Timeout>();

async function triggerAIResponse(
  io: Server,
  conversationId: string,
  userMessage: string,
  userName: string,
  userId: string
) {
  try {
    const aiText = await generateAIResponse(conversationId, userMessage, userName);

    if (!aiText) {
      console.log(`[AI] No response generated for conversation ${conversationId}`);
      return;
    }

    // Double-check that no admin has replied since the timer started
    const lastMessage = await Message.findOne({ conversationId })
      .sort({ createdAt: -1 })
      .lean();

    if (lastMessage && lastMessage.senderRole === 'admin') {
      console.log('[AI] Admin already replied — skipping AI response');
      return;
    }

    // Save AI message to database
    const aiMessage = await Message.create({
      conversationId,
      senderId: 'ai-assistant',
      senderName: 'AI Assistant',
      senderRole: 'ai',
      content: aiText,
      read: false,
    });

    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: aiText,
      lastMessageAt: new Date(),
      $inc: { unreadByUser: 1 },
    });

    const messagePayload = {
      _id: aiMessage._id.toString(),
      conversationId,
      senderId: 'ai-assistant',
      senderName: 'AI Assistant',
      senderRole: 'ai' as const,
      content: aiText,
      read: false,
      createdAt: aiMessage.createdAt,
    };

    // Send to the conversation room (user sees it in real time)
    io.to(`conversation:${conversationId}`).emit('new_message', messagePayload);

    // Update admin sidebar with the AI's last message
    io.to('admin-room').emit('conversation_updated', {
      conversationId,
      lastMessage: aiText,
      lastMessageAt: new Date(),
      unreadByAdmin: 0,
    });

    console.log(`[AI] Responded to ${userName} in conversation ${conversationId}`);
  } catch (error) {
    console.error('[AI] Error generating response:', error);
  } finally {
    aiResponseTimers.delete(conversationId);
  }
}

function scheduleAIResponse(
  io: Server,
  conversationId: string,
  userMessage: string,
  userName: string,
  userId: string
) {
  // Cancel any existing timer for this conversation
  cancelAITimer(conversationId);

  const DELAY_SECONDS = 30;

  const timer = setTimeout(
    () => triggerAIResponse(io, conversationId, userMessage, userName, userId),
    DELAY_SECONDS * 1000
  );

  aiResponseTimers.set(conversationId, timer);
  console.log(`[AI] Timer set — will respond to ${userName} in ${DELAY_SECONDS}s if admin doesn't reply`);
}

function cancelAITimer(conversationId: string) {
  const existing = aiResponseTimers.get(conversationId);
  if (existing) {
    clearTimeout(existing);
    aiResponseTimers.delete(conversationId);
    console.log(`[AI] Timer cancelled for conversation ${conversationId} — admin replied`);
  }
}

export function registerChatHandlers(io: Server, socket: AuthSocket) {
  const userId = socket.userId!;
  const userName = socket.userName!;
  const userEmail = socket.userEmail || '';
  const userRole = socket.userRole!;

  // ── Admin connects ────────────────────────────────────────────────
  if (userRole === 'admin') {
    adminSockets.add(socket.id);
    socket.join('admin-room');

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
      { upsert: true, returnDocument: 'after' } 
    ).then(conversation => {
      if (conversation) {
        socket.join(`conversation:${conversation._id}`);
        socket.emit('conversation_ready', {
          conversationId: conversation._id.toString(),
        });
      }
    });

    socket.on('disconnect', () => {});
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

      const isAdminReadingThisConversation = [...adminActiveConversation.entries()].some(
        ([, convId]) => convId === conversationId
      );

      const message = await Message.create({
        conversationId,
        senderId: userId,
        senderName: userName,
        senderRole: userRole === 'admin' ? 'admin' : 'user',
        content: content.trim(),
        read: userRole === 'user' ? isAdminReadingThisConversation : false,
      });

      if (userRole === 'user') {
        await Conversation.findByIdAndUpdate(conversationId, {
          lastMessage: content.trim(),
          lastMessageAt: new Date(),
          $inc: { unreadByAdmin: isAdminReadingThisConversation ? 0 : 1 },
          userTyping: false,
        });
      } else {
        // Admin replied — cancel the AI timer immediately
        cancelAITimer(conversationId);

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

      io.to(`conversation:${conversationId}`).emit('new_message', messagePayload);

      if (userRole === 'user') {
        const updatedConv = await Conversation.findById(conversationId).lean();
        io.to('admin-room').emit('conversation_updated', {
          conversationId,
          lastMessage: content.trim(),
          lastMessageAt: new Date(),
          unreadByAdmin: updatedConv?.unreadByAdmin ?? 0,
        });

        if (isAdminReadingThisConversation) {
          io.to(`user:${userId}`).emit('messages_read', {
            conversationId,
            readBy: 'admin',
          });
        }

        for (const adminSocketId of adminSockets) {
          const adminSocket = io.sockets.sockets.get(adminSocketId);
          if (adminSocket) {
            adminSocket.join(`conversation:${conversationId}`);
          }
        }

        // ── Schedule AI response if admin is not actively in this conversation ─
        // Only trigger if no admin has this conversation open right now
        if (!isAdminReadingThisConversation) {
          scheduleAIResponse(io, conversationId, content.trim(), userName, userId);
        } else {
          // Admin is reading live — no AI needed
          console.log(`[AI] Admin is active in conversation — no AI timer needed`);
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

    // Admin opened the chat — cancel any pending AI timer
    cancelAITimer(conversationId);

    adminActiveConversation.set(socket.id, conversationId);
    socket.join(`conversation:${conversationId}`);

    try {
      await Message.updateMany(
        { conversationId, senderRole: 'user', read: false },
        { read: true }
      );

      await Conversation.findByIdAndUpdate(conversationId, {
        unreadByAdmin: 0,
      });

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

      const conversation = await Conversation.findById(conversationId)
        .select('userId')
        .lean();

      if (conversation?.userId) {
        io.to(`conversation:${conversationId}`).emit('messages_read', {
          conversationId,
          readBy: 'admin',
        });

        io.to(`user:${conversation.userId}`).emit('messages_read', {
          conversationId,
          readBy: 'admin',
        });
      }
    } catch (error) {
      console.error('admin_open_conversation error:', error);
    }
  });

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

    // If admin starts typing, cancel the AI timer
    if (userRole === 'admin') {
      cancelAITimer(conversationId);
      await Conversation.findByIdAndUpdate(conversationId, { adminTyping: true });
    } else {
      await Conversation.findByIdAndUpdate(conversationId, { userTyping: true });
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

  // ── Get all conversations ─────────────────────────────────────────
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

    cancelAITimer(data.conversationId);
    adminActiveConversation.delete(socket.id);

    await Conversation.findByIdAndUpdate(data.conversationId, { status: 'closed' });

    io.to(`conversation:${data.conversationId}`).emit('conversation_closed', {
      conversationId: data.conversationId,
    });
  });

  // ── Reopen conversation ───────────────────────────────────────────
  socket.on('reopen_conversation', async (data: { conversationId: string }) => {
    if (userRole !== 'admin') return;

    try {
      await Conversation.findByIdAndUpdate(data.conversationId, { status: 'open' });

      io.to('admin-room').emit('conversation_reopened', {
        conversationId: data.conversationId,
      });

      io.to(`conversation:${data.conversationId}`).emit('conversation_reopened', {
        conversationId: data.conversationId,
      });
    } catch (error) {
      console.error('reopen_conversation error:', error);
    }
  });
}