import mongoose, { Schema, Document } from 'mongoose';

export interface IConversation extends Document {
  userId: string;
  userName: string;
  userEmail: string;
  status: 'open' | 'closed';
  lastMessage: string;
  lastMessageAt: Date;
  unreadByAdmin: number;   // messages user sent that admin hasn't read
  unreadByUser: number;    // messages admin sent that user hasn't read
  adminTyping: boolean;
  userTyping: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>(
  {
    userId: { type: String, required: true, unique: true },
    userName: { type: String, required: true },
    userEmail: { type: String, required: true },
    status: {
      type: String,
      enum: ['open', 'closed'],
      default: 'open',
    },
    lastMessage: { type: String, default: '' },
    lastMessageAt: { type: Date, default: Date.now },
    unreadByAdmin: { type: Number, default: 0 },
    unreadByUser: { type: Number, default: 0 },
    adminTyping: { type: Boolean, default: false },
    userTyping: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model<IConversation>('Conversation', ConversationSchema);