// ============================================================
// SADIE HARTLEY - Agent (Durable Object)
// Version: 3.0.0 - Magic Link + Trial System
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { 
  buildPrompt, 
  CHARACTER_INFO 
} from './personality';
import {
  initializeUserMemory,
  loadHotMemory,
  formatMemoryForPrompt,
  HotMemory
} from './memory';
import { runExtractions } from './extraction';

interface Env {
  MEMORY: R2Bucket;
  ANTHROPIC_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  RESEND_API_KEY: string;
  BILLING_URL: string; // e.g., https://topfivefriends.com or billing worker URL
}

type UserStatus = 'new' | 'trial' | 'awaiting_email' | 'pending_payment' | 'active' | 'paused' | 'churned';

interface User {
  chat_id: string;
  telegram_id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  status: UserStatus;
  email?: string;
  account_id?: string;
  message_count: number;
  trial_messages_remaining: number;
  created_at: string;
  last_message_at: string;
  last_outreach_at?: string;
  timezone_offset?: number;
  ref_code?: string;
}

interface PendingLink {
  id: string;
  chat_id: string;
  email: string;
  token: string;
  character: string;
  created_at: string;
  expires_at: string;
  used: number;
}

interface Session {
  id: string;
  chat_id: string;
  started_at: string;
  ended_at?: string;
  summary?: string;
  message_count: number;
}

const TRIAL_MESSAGE_LIMIT = 25;
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const EXTRACTION_DELAY_MS = 15 * 60 * 1000; // 15 minutes of silence
const MAGIC_LINK_EXPIRY_HOURS = 24;
const CHARACTER_NAME = 'sadie';
const CHARACTER_DISPLAY = 'Sadie';

// Email regex pattern
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export class SadieAgent {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.initDatabase();
  }

  private initDatabase() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        chat_id TEXT PRIMARY KEY,
        telegram_id INTEGER,
        first_name TEXT,
        last_name TEXT,
        username TEXT,
        status TEXT DEFAULT 'new',
        email TEXT,
        account_id TEXT,
        message_count INTEGER DEFAULT 0,
        trial_messages_remaining INTEGER DEFAULT ${TRIAL_MESSAGE_LIMIT},
        created_at TEXT,
        last_message_at TEXT,
        last_outreach_at TEXT,
        timezone_offset INTEGER,
        ref_code TEXT
      );
      
      CREATE TABLE IF NOT EXISTS pending_links (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        email TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        character TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT,
        message_count INTEGER DEFAULT 0,
        extraction_done INTEGER DEFAULT 0
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id);
      CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
      CREATE INDEX IF NOT EXISTS idx_users_last_message ON users(last_message_at);
      CREATE INDEX IF NOT EXISTS idx_pending_links_token ON pending_links(token);
      CREATE INDEX IF NOT EXISTS idx_pending_links_chat ON pending_links(chat_id);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    try {
      if (url.pathname === '/message' && request.method === 'POST') {
        const data = await request.json() as {
          content: string;
          chatId: string;
          user: { id: number; firstName: string; lastName?: string; username?: string };
          refCode?: string;
          isNewUser?: boolean;
        };
        await this.handleMessage(data);
        return new Response('OK');
      }
      
      // Endpoint for billing system to verify/activate user
      if (url.pathname === '/billing/activate' && request.method === 'POST') {
        const data = await request.json() as { chat_id: string; account_id: string; email: string };
        await this.activateUser(data.chat_id, data.account_id, data.email);
        return this.jsonResponse({ success: true });
      }
      
      // Endpoint to check user status (for billing system)
      if (url.pathname.startsWith('/billing/status/')) {
        const chatId = url.pathname.split('/').pop();
        const userResult = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).toArray();
        if (userResult.length === 0) return this.jsonResponse({ error: 'User not found' }, 404);
        const user = userResult[0] as User;
        return this.jsonResponse({ 
          status: user.status, 
          email: user.email,
          account_id: user.account_id,
          trial_remaining: user.trial_messages_remaining
        });
      }
      
      // Endpoint for billing system to look up pending link by token
      if (url.pathname.startsWith('/billing/pending/')) {
        const token = url.pathname.split('/billing/pending/')[1];
        const linkResult = this.sql.exec(`
          SELECT pl.*, u.first_name 
          FROM pending_links pl
          JOIN users u ON pl.chat_id = u.chat_id
          WHERE pl.token = ? AND pl.used = 0 AND pl.expires_at > ?
        `, token, new Date().toISOString()).toArray();
        
        if (linkResult.length === 0) return this.jsonResponse({ error: 'Not found' }, 404);
        return this.jsonResponse(linkResult[0]);
      }
      
      if (url.pathname === '/rhythm/checkAllUsers') {
        await this.checkAllUsersForOutreach();
        return new Response('OK');
      }
      
      if (url.pathname === '/rhythm/processExtractions') {
        await this.processStaleExtractions();
        return new Response('OK');
      }
      
      if (url.pathname === '/rhythm/cleanup') {
        await this.cleanup();
        return new Response('OK');
      }
      
      if (url.pathname === '/admin/users') {
        const users = this.sql.exec(`SELECT * FROM users ORDER BY last_message_at DESC LIMIT 100`).toArray();
        return this.jsonResponse({ users, count: users.length });
      }
      
      if (url.pathname === '/admin/pending-links') {
        const links = this.sql.exec(`SELECT * FROM pending_links WHERE used = 0 ORDER BY created_at DESC LIMIT 50`).toArray();
        return this.jsonResponse({ links, count: links.length });
      }
      
      if (url.pathname.startsWith('/admin/users/')) {
        const chatId = url.pathname.split('/').pop();
        const userResult = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).toArray();
        if (userResult.length === 0) return this.jsonResponse({ error: 'User not found' }, 404);
        const user = userResult[0];
        
        const sessions = this.sql.exec(`SELECT * FROM sessions WHERE chat_id = ? ORDER BY started_at DESC LIMIT 10`, chatId).toArray();
        const recentMessages = this.sql.exec(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 20`, chatId).toArray();
        
        const memory = await loadHotMemory(this.env.MEMORY, chatId as string);
        
        return this.jsonResponse({ user, sessions, recentMessages, memory });
      }
      
      if (url.pathname === '/debug/stats') {
        const userCount = this.sql.exec(`SELECT COUNT(*) as count FROM users`).toArray()[0];
        const messageCount = this.sql.exec(`SELECT COUNT(*) as count FROM messages`).toArray()[0];
        const sessionCount = this.sql.exec(`SELECT COUNT(*) as count FROM sessions`).toArray()[0];
        const statusBreakdown = this.sql.exec(`SELECT status, COUNT(*) as count FROM users GROUP BY status`).toArray();
        const pendingLinks = this.sql.exec(`SELECT COUNT(*) as count FROM pending_links WHERE used = 0`).toArray()[0];
        
        return this.jsonResponse({
          users: userCount?.count || 0,
          messages: messageCount?.count || 0,
          sessions: sessionCount?.count || 0,
          pendingLinks: pendingLinks?.count || 0,
          byStatus: statusBreakdown
        });
      }
      
      if (url.pathname === '/debug/test-r2') {
        try {
          const testKey = `test/connection_${Date.now()}.json`;
          await this.env.MEMORY.put(testKey, JSON.stringify({ test: true, timestamp: new Date().toISOString() }));
          const result = await this.env.MEMORY.get(testKey);
          const data = result ? await result.json() : null;
          await this.env.MEMORY.delete(testKey);
          return this.jsonResponse({ success: true, wrote: true, read: data });
        } catch (e) {
          return this.jsonResponse({ success: false, error: String(e) }, 500);
        }
      }
      
      if (url.pathname === '/debug/test-email') {
        // Test email sending
        const testEmail = url.searchParams.get('email');
        if (!testEmail) return this.jsonResponse({ error: 'Provide ?email=...' }, 400);
        
        const result = await this.sendMagicLinkEmail(testEmail, 'test-token-123', 'Test User');
        return this.jsonResponse({ success: result, email: testEmail });
      }
      
      if (url.pathname.startsWith('/debug/init-memory/')) {
        const chatId = url.pathname.split('/').pop();
        const userResult = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).toArray();
        if (userResult.length === 0) return this.jsonResponse({ error: 'User not found' }, 404);
        const user = userResult[0] as User;
        
        await initializeUserMemory(this.env.MEMORY, chatId!, user.first_name);
        const memory = await loadHotMemory(this.env.MEMORY, chatId!);
        
        return this.jsonResponse({ success: true, initialized: true, memory });
      }
      
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('Agent error:', error);
      return this.jsonResponse({ error: String(error) }, 500);
    }
  }

  private async handleMessage(data: {
    content: string;
    chatId: string;
    user: { id: number; firstName: string; lastName?: string; username?: string };
    refCode?: string;
    isNewUser?: boolean;
  }): Promise<void> {
    const { content, chatId, user: telegramUser, refCode } = data;
    const now = new Date();
    
    // Get or create user
    const userResult = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).toArray();
    let user = userResult.length > 0 ? userResult[0] as User : null;
    const isFirstTimeUser = !user;
    
    if (!user) {
      this.sql.exec(`
        INSERT INTO users (chat_id, telegram_id, first_name, last_name, username, status, created_at, last_message_at, trial_messages_remaining, ref_code)
        VALUES (?, ?, ?, ?, ?, 'trial', ?, ?, ?, ?)
      `, chatId, telegramUser.id, telegramUser.firstName, telegramUser.lastName || null, 
         telegramUser.username || null, now.toISOString(), now.toISOString(), TRIAL_MESSAGE_LIMIT, refCode || null);
      
      const newUserResult = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).toArray();
      user = newUserResult[0] as User;
    }
    
    // ALWAYS ensure R2 memory exists
    await initializeUserMemory(this.env.MEMORY, chatId, user.first_name);
    
    // Handle /start command
    if (content === '__START__') {
      await this.sendWelcomeMessage(user, isFirstTimeUser);
      return;
    }
    
    // ========================================
    // MAGIC LINK FLOW - Check if awaiting email
    // ========================================
    if (user.status === 'awaiting_email') {
      // Check if this message looks like an email
      const trimmedContent = content.trim().toLowerCase();
      
      if (EMAIL_REGEX.test(trimmedContent)) {
        // Valid email - create magic link
        await this.handleEmailSubmission(user, trimmedContent);
        return;
      } else {
        // Not an email - remind them
        await this.sendMessage(chatId, 
          `hmm that doesn't look like an email address 🤔 just type your email and i'll send you a link to get set up!`
        );
        return;
      }
    }
    
    // Check if user already submitted email and is pending payment
    if (user.status === 'pending_payment') {
      // Allow re-sending if they type another email
      const trimmedContent = content.trim().toLowerCase();
      if (EMAIL_REGEX.test(trimmedContent)) {
        await this.handleEmailSubmission(user, trimmedContent);
        return;
      }
      
      await this.sendMessage(chatId,
        `i already sent you a magic link! check your inbox at ${user.email} 📬\n\nif you can't find it, just type your email again and i'll send a new one.`
      );
      return;
    }
    
    // ========================================
    // TRIAL LIMIT CHECK
    // ========================================
    if (user.status === 'trial' && user.trial_messages_remaining <= 0) {
      // Trial exhausted - ask for email
      this.sql.exec(`UPDATE users SET status = 'awaiting_email' WHERE chat_id = ?`, chatId);
      
      await this.sendMessage(chatId, 
        `hey ${user.first_name}! 💜 i've really loved getting to know you these past few conversations.\n\nto keep chatting, i just need your email so we can get you set up. what's a good email for you?`
      );
      return;
    }
    
    // ========================================
    // ACTIVE USER CHECK
    // ========================================
    if (user.status !== 'trial' && user.status !== 'active') {
      // User in weird state (paused, churned, etc) - check if they have active account
      // For now, let them through
    }
    
    // ========================================
    // NORMAL MESSAGE HANDLING
    // ========================================
    
    // Session management
    const lastSessionResult = this.sql.exec(`SELECT * FROM sessions WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1`, chatId).toArray();
    const lastSession = lastSessionResult.length > 0 ? lastSessionResult[0] as Session : null;
    
    const needsNewSession = !lastSession || 
      (now.getTime() - new Date(lastSession.started_at).getTime() > SESSION_TIMEOUT_MS);
    
    let sessionId: string;
    
    if (needsNewSession) {
      if (lastSession && !lastSession.ended_at) {
        await this.closeSession(lastSession.id, chatId, lastSession.message_count);
      }
      
      sessionId = `${chatId}_${Date.now()}`;
      this.sql.exec(`INSERT INTO sessions (id, chat_id, started_at, message_count) VALUES (?, ?, ?, 0)`, sessionId, chatId, now.toISOString());
    } else {
      sessionId = lastSession!.id;
    }
    
    // Store user message
    this.sql.exec(`INSERT INTO messages (chat_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)`, chatId, sessionId, content, now.toISOString());
    this.sql.exec(`UPDATE sessions SET message_count = message_count + 1 WHERE id = ?`, sessionId);
    
    // Decrement trial if applicable
    if (user.status === 'trial') {
      this.sql.exec(`UPDATE users SET message_count = message_count + 1, trial_messages_remaining = trial_messages_remaining - 1, last_message_at = ? WHERE chat_id = ?`, now.toISOString(), chatId);
    } else {
      this.sql.exec(`UPDATE users SET message_count = message_count + 1, last_message_at = ? WHERE chat_id = ?`, now.toISOString(), chatId);
    }
    
    // Generate response with memory
    const response = await this.generateResponse(chatId, sessionId, user);
    
    // Store assistant response
    this.sql.exec(`INSERT INTO messages (chat_id, session_id, role, content, timestamp) VALUES (?, ?, 'assistant', ?, ?)`, chatId, sessionId, response, new Date().toISOString());
    this.sql.exec(`UPDATE sessions SET message_count = message_count + 1 WHERE id = ?`, sessionId);
    
    // Send to Telegram
    await this.sendMessage(chatId, response);
    
    // Update user status if hooked
    this.updateUserStatus(chatId);
  }

  // ========================================
  // MAGIC LINK FUNCTIONS
  // ========================================

  private async handleEmailSubmission(user: User, email: string): Promise<void> {
    const now = new Date();
    const token = this.generateToken();
    const expiresAt = new Date(now.getTime() + MAGIC_LINK_EXPIRY_HOURS * 60 * 60 * 1000);
    
    // Create pending link record
    const linkId = `link_${user.chat_id}_${Date.now()}`;
    this.sql.exec(`
      INSERT INTO pending_links (id, chat_id, email, token, character, created_at, expires_at, used)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `, linkId, user.chat_id, email, token, CHARACTER_NAME, now.toISOString(), expiresAt.toISOString());
    
    // Update user status and store email
    this.sql.exec(`UPDATE users SET status = 'pending_payment', email = ? WHERE chat_id = ?`, email, user.chat_id);
    
    // Send magic link email
    const emailSent = await this.sendMagicLinkEmail(email, token, user.first_name);
    
    if (emailSent) {
      await this.sendMessage(user.chat_id,
        `perfect! 💌 i just sent a magic link to ${email}\n\nclick it to pick your plan and we can keep this going! check your spam folder if you don't see it in a minute.`
      );
    } else {
      // Email failed - revert status
      this.sql.exec(`UPDATE users SET status = 'awaiting_email' WHERE chat_id = ?`, user.chat_id);
      await this.sendMessage(user.chat_id,
        `hmm something went wrong sending that email 😅 can you double-check the address and try again?`
      );
    }
  }

  private generateToken(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let token = '';
    for (let i = 0; i < 32; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  }

  private async sendMagicLinkEmail(email: string, token: string, firstName: string): Promise<boolean> {
    const magicLink = `${this.env.BILLING_URL}/magic/${token}`;
    
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `${CHARACTER_DISPLAY} <no-reply@topfivefriends.com>`,
          to: [email],
          subject: `hey ${firstName}! your link to keep chatting 💬`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 40px 20px;">
              <h1 style="font-size: 24px; font-weight: 600; color: #1a1a1a; margin-bottom: 24px;">
                hey ${firstName}! 👋
              </h1>
              
              <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin-bottom: 16px;">
                it's ${CHARACTER_DISPLAY} — you clicked through! i'm so glad you want to keep talking.
              </p>
              
              <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin-bottom: 32px;">
                click the button below to pick your plan and we can get back to it:
              </p>
              
              <a href="${magicLink}" style="display: inline-block; background: #7c3aed; color: white; font-size: 16px; font-weight: 600; padding: 14px 32px; border-radius: 8px; text-decoration: none; margin-bottom: 32px;">
                Choose Your Plan →
              </a>
              
              <p style="font-size: 14px; color: #888; margin-top: 32px;">
                this link expires in 24 hours. if you didn't request this, you can ignore it.
              </p>
              
              <p style="font-size: 14px; color: #888; margin-top: 24px;">
                — ${CHARACTER_DISPLAY} 💜<br>
                <span style="color: #aaa;">Top Five Friends</span>
              </p>
            </div>
          `
        })
      });
      
      if (!response.ok) {
        const error = await response.text();
        console.error('Resend error:', error);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('Email send error:', error);
      return false;
    }
  }

  private async activateUser(chatId: string, accountId: string, email: string): Promise<void> {
    this.sql.exec(`
      UPDATE users 
      SET status = 'active', account_id = ?, email = ?
      WHERE chat_id = ?
    `, accountId, email, chatId);
    
    // Mark pending links as used
    this.sql.exec(`UPDATE pending_links SET used = 1 WHERE chat_id = ?`, chatId);
    
    // Send welcome back message
    const userResult = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).toArray();
    if (userResult.length > 0) {
      const user = userResult[0] as User;
      await this.sendMessage(chatId,
        `you're all set ${user.first_name}! 🎉 unlimited chats unlocked. so... where were we? 😊`
      );
    }
  }

  // ========================================
  // EXISTING FUNCTIONS (slightly modified)
  // ========================================

  private async sendWelcomeMessage(user: User, isFirstTime: boolean): Promise<void> {
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    
    const memory = await loadHotMemory(this.env.MEMORY, user.chat_id);
    const memoryContext = formatMemoryForPrompt(memory);
    
    let welcomeContext: string;
    
    if (user.status === 'active') {
      welcomeContext = `\n\n[CONTEXT: ${user.first_name} is a paying subscriber coming back. Be warm and excited to chat again!]`;
    } else if (isFirstTime) {
      welcomeContext = `\n\n[CONTEXT: ${user.first_name} just started chatting with you for the first time. Be warm, introduce yourself naturally, maybe ask what brings them here or what's on their mind. Keep it light. They have ${TRIAL_MESSAGE_LIMIT} free messages.]`;
    } else {
      welcomeContext = `\n\n[CONTEXT: ${user.first_name} is back! You've talked before. Be casual and welcoming, maybe reference something from your history if relevant.]`;
    }
    
    const systemPrompt = buildPrompt(
      '[new conversation starting]',
      new Date(),
      memory.relationship.phase
    ) + memoryContext + welcomeContext;
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: '[Send your opening message]' }]
    });
    
    const textBlock = response.content.find(b => b.type === 'text');
    if (textBlock?.text) {
      await this.sendMessage(user.chat_id, textBlock.text);
    }
  }

  private async generateResponse(chatId: string, sessionId: string, user: User): Promise<string> {
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    
    const recentMessages = this.sql.exec(`SELECT role, content FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 20`, chatId).toArray().reverse();
    
    const lastUserMessage = recentMessages.filter(m => m.role === 'user').pop();
    const messageContent = lastUserMessage?.content as string || '';
    
    const memory = await loadHotMemory(this.env.MEMORY, chatId);
    const memoryContext = formatMemoryForPrompt(memory);
    
    // Add trial countdown context if applicable
    let trialContext = '';
    if (user.status === 'trial') {
      const remaining = user.trial_messages_remaining - 1; // -1 because we already decremented
      if (remaining <= 5 && remaining > 0) {
        trialContext = `\n\n[SYSTEM NOTE: User has ${remaining} free messages remaining. Don't mention this unless natural.]`;
      }
    }
    
    const systemPrompt = buildPrompt(
      messageContent,
      new Date(),
      memory.relationship.phase
    ) + memoryContext + trialContext;
    
    const messages = recentMessages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content as string
    }));
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: systemPrompt,
      messages
    });
    
    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock?.text || "...";
  }

  private async sendMessage(chatId: string, content: string): Promise<void> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: content })
      }
    );
    
    if (!response.ok) {
      console.error('Telegram error:', await response.text());
    }
  }

  private updateUserStatus(chatId: string): void {
    const userResult = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).toArray();
    if (userResult.length === 0) return;
    const user = userResult[0] as User;
    
    // No longer updating to 'hooked' - keep trial until they hit limit
  }

  private async closeSession(sessionId: string, chatId: string, messageCount: number): Promise<void> {
    const now = new Date().toISOString();
    this.sql.exec(`UPDATE sessions SET ended_at = ? WHERE id = ?`, now, sessionId);
    
    if (messageCount >= 4) {
      const messages = this.sql.exec(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp`, sessionId).toArray();
      const transcript = messages.map(m => `${m.role}: ${m.content}`).join('\n');
      
      const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      
      try {
        const result = await runExtractions(
          this.env.MEMORY,
          anthropic,
          chatId,
          transcript,
          messageCount
        );
        
        console.log(`Extractions for ${chatId}:`, result);
        this.sql.exec(`UPDATE sessions SET extraction_done = 1 WHERE id = ?`, sessionId);
      } catch (e) {
        console.error('Extraction failed:', e);
      }
    }
  }

  private async processStaleExtractions(): Promise<void> {
    const cutoff = new Date(Date.now() - EXTRACTION_DELAY_MS).toISOString();
    
    const staleSessions = this.sql.exec(`
      SELECT s.*, u.chat_id as user_chat_id
      FROM sessions s
      JOIN users u ON s.chat_id = u.chat_id
      WHERE s.ended_at IS NOT NULL 
        AND s.ended_at < ?
        AND s.extraction_done = 0
        AND s.message_count >= 4
      LIMIT 5
    `, cutoff).toArray();
    
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    
    for (const session of staleSessions) {
      const messages = this.sql.exec(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp`, session.id).toArray();
      const transcript = messages.map(m => `${m.role}: ${m.content}`).join('\n');
      
      try {
        await runExtractions(
          this.env.MEMORY,
          anthropic,
          session.chat_id as string,
          transcript,
          session.message_count as number
        );
        
        this.sql.exec(`UPDATE sessions SET extraction_done = 1 WHERE id = ?`, session.id);
      } catch (e) {
        console.error(`Extraction failed for session ${session.id}:`, e);
      }
    }
  }

  private async checkAllUsersForOutreach(): Promise<void> {
    const cutoffStart = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const cutoffEnd = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    // Only reach out to trial or active users, not those awaiting email/payment
    const eligibleUsers = this.sql.exec(`
      SELECT * FROM users 
      WHERE status IN ('trial', 'active')
      AND last_message_at < ? AND last_message_at > ?
      AND (last_outreach_at IS NULL OR last_outreach_at < last_message_at)
      LIMIT 10
    `, cutoffEnd, cutoffStart).toArray() as User[];
    
    for (const user of eligibleUsers) {
      await this.sendProactiveMessage(user);
    }
  }

  private async sendProactiveMessage(user: User): Promise<void> {
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    
    const memory = await loadHotMemory(this.env.MEMORY, user.chat_id);
    const memoryContext = formatMemoryForPrompt(memory);
    
    const activeThreads = memory.threads.active_threads.filter(t => {
      const followUp = new Date(t.follow_up_after);
      return !t.resolved && followUp <= new Date();
    });
    
    let outreachContext = `\n\n[CONTEXT: It's been a day or two since ${user.first_name} messaged. Send a brief, natural check-in. `;
    
    if (activeThreads.length > 0) {
      outreachContext += `You have something to follow up on: "${activeThreads[0].prompt}"`;
    } else if (memory.relationship.inside_jokes.length > 0) {
      outreachContext += `Maybe reference something from your history together.`;
    } else {
      outreachContext += `Keep it light and casual.`;
    }
    outreachContext += `]`;
    
    const systemPrompt = buildPrompt(
      '[proactive outreach]',
      new Date(),
      memory.relationship.phase
    ) + memoryContext + outreachContext;
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: '[Send a casual check-in message]' }]
    });
    
    const textBlock = response.content.find(b => b.type === 'text');
    if (textBlock?.text) {
      await this.sendMessage(user.chat_id, textBlock.text);
      this.sql.exec(`UPDATE users SET last_outreach_at = ? WHERE chat_id = ?`, new Date().toISOString(), user.chat_id);
    }
  }

  private async cleanup(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    const oldSessions = this.sql.exec(`SELECT * FROM sessions WHERE ended_at < ?`, cutoff).toArray();
    
    if (oldSessions.length > 0) {
      const archiveKey = `archives/sessions_${new Date().toISOString().split('T')[0]}.json`;
      await this.env.MEMORY.put(archiveKey, JSON.stringify(oldSessions));
      
      for (const session of oldSessions) {
        this.sql.exec(`DELETE FROM messages WHERE session_id = ?`, session.id);
        this.sql.exec(`DELETE FROM sessions WHERE id = ?`, session.id);
      }
    }
    
    // Clean up expired pending links
    const linkCutoff = new Date().toISOString();
    this.sql.exec(`DELETE FROM pending_links WHERE expires_at < ? AND used = 0`, linkCutoff);
    
    // Update user statuses
    const pauseCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    this.sql.exec(`UPDATE users SET status = 'paused' WHERE status IN ('trial', 'active') AND last_message_at < ?`, pauseCutoff);
    this.sql.exec(`UPDATE users SET status = 'churned' WHERE status = 'paused' AND last_message_at < ?`, cutoff);
  }

  private jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
  }
}