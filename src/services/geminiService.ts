import { GoogleGenerativeAI } from '@google/generative-ai';
import Message from '../models/Message';

// Initialize the Gemini client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Lazy-load Product and Category models — they live in your Next.js app's
// MongoDB database, same connection the chat server already uses
let ProductModel: any = null;
let CategoryModel: any = null;

async function getProductContext(): Promise<string> {
  try {
    // Dynamically import to avoid circular dependency issues
    if (!ProductModel) {
      const mongoose = await import('mongoose');

      const ProductSchema = new mongoose.Schema({
        name: String,
        description: String,
        price: Number,
        stock: Number,
        isFeatured: Boolean,
        isPremiumOnly: Boolean,
      });

      ProductModel = mongoose.models.Product ||
        mongoose.model('Product', ProductSchema);
    }

    const products = await ProductModel
      .find({ stock: { $gt: 0 } })
      .select('name description price stock isFeatured isPremiumOnly')
      .limit(20)
      .lean() as any[];

    if (!products.length) return 'No products currently in stock.';

    return products
      .map((p: any) =>
        `- ${p.name}: $${p.price}${p.isPremiumOnly ? ' (Premium members only)' : ''}${p.stock < 5 ? ' (Low stock)' : ''}`
      )
      .join('\n');
  } catch {
    return 'Product information temporarily unavailable.';
  }
}

async function getCategoryContext(): Promise<string> {
  try {
    if (!CategoryModel) {
      const mongoose = await import('mongoose');

      const CategorySchema = new mongoose.Schema({
        name: String,
        description: String,
      });

      CategoryModel = mongoose.models.Category ||
        mongoose.model('Category', CategorySchema);
    }

    const categories = await CategoryModel
      .find()
      .select('name description')
      .lean() as any[];

    if (!categories.length) return 'No categories available.';

    return categories
      .map((c: any) => `- ${c.name}${c.description ? `: ${c.description}` : ''}`)
      .join('\n');
  } catch {
    return 'Category information temporarily unavailable.';
  }
}

async function getRecentMessages(conversationId: string): Promise<string> {
  try {
    const messages = await Message
      .find({ conversationId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return messages
      .reverse()
      .map(m => `${m.senderRole === 'user' ? 'Customer' : 'Support'}: ${m.content}`)
      .join('\n');
  } catch {
    return '';
  }
}

export async function generateAIResponse(
  conversationId: string,
  userMessage: string,
  userName: string
): Promise<string | null> {
  try {
    if (!process.env.GEMINI_API_KEY) {
      console.warn('GEMINI_API_KEY not set — skipping AI response');
      return null;
    }

    const [productContext, categoryContext, conversationHistory] = await Promise.all([
      getProductContext(),
      getCategoryContext(),
      getRecentMessages(conversationId),
    ]);

    const systemPrompt = `You are an AI customer support assistant for E-Shop, an online e-commerce store. You are helping a customer named ${userName}.

STORE INFORMATION:
- We sell a variety of products online
- We offer a Premium membership ($9.99/month) that gives 10% off all orders and access to exclusive products
- Shipping is free on all orders
- Payment is processed securely through Stripe
- Orders can be tracked in the "My Orders" section after logging in
- Refunds are possible if the admin cannot fulfill the order

AVAILABLE CATEGORIES:
${categoryContext}

CURRENT PRODUCTS IN STOCK:
${productContext}

POLICIES:
- Refunds: If we cannot fulfill an order, a full refund is issued within 5-10 business days
- Cancellations: Orders can only be cancelled before they are accepted by admin
- Premium membership: Cancel anytime, keep access until end of billing period
- Contact: Customers can reach us through this chat or the contact form

CONVERSATION HISTORY:
${conversationHistory}

INSTRUCTIONS:
1. You are responding because a human support agent is currently unavailable
2. ALWAYS clearly identify yourself: start responses with "Hi ${userName}! I'm the E-Shop AI assistant."
3. Answer questions about products, orders, subscriptions, shipping, and policies using the information above
4. If you cannot answer a question confidently or it requires account-specific information (like order status), say: "I'm not sure about the details of your specific account. I've forwarded your question to one of our support representatives who will get back to you soon."
5. Keep responses friendly, concise, and helpful — under 100 words unless more detail is needed
6. Do not make up product names, prices, or policies not mentioned above
7. Do not discuss competitors or make promises the store has not made`;

const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

    const result = await model.generateContent([
      { text: systemPrompt },
      { text: `Customer message: ${userMessage}` },
    ]);

    const response = result.response.text().trim();

    if (!response) return null;

    return response;
  } catch (error) {
    console.error('Gemini API error:', error);
    return null;
  }
}