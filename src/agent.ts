// ============================================================
// SADIE HARTLEY - Agent (Durable Object)
// Version: 2.0.1 - Fixed R2 initialization for existing users
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
}

type UserStatus = 'new' | 'trial' | 'hooked' | 'active' | 'paused' | 'churned';

interface User {
  chat_id: string;
  telegram_id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  status: UserStatus;
  message_count: number;
  trial_messages_remaining: number;
  created_at: string;
  last_message_at: string;
  last_outreach_at?: string;
  timezone_offset?: number;
  ref_code?: string;
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
        message_count INTEGER DEFAULT 0,
        trial_messages_remaining INTEGER DEFAULT ${TRIAL_MESSAGE_LIMIT},
        created_at TEXT,
        last_message_at TEXT,
        last_outreach_at TEXT,
        timezone_offset INTEGER,
        ref_code TEXT
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
      
      if (url.pathname.startsWith('/admin/users/')) {
        const chatId = url.pathname.split('/').pop();
        const userResult = this.sql.exec(`SELECT * FROM users WHERE chat_id = ?`, chatId).toArray();
        if (userResult.length === 0) return this.jsonResponse({ error: 'User not found' }, 404);
        const user = userResult[0];
        
        const sessions = this.sql.exec(`SELECT * FROM sessions WHERE chat_id = ? ORDER BY started_at DESC LIMIT 10`, chatId).toArray();
        const recentMessages = this.sql.exec(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 20`, chatId).toArray();
        
        // Load R2 memory
        const memory = await loadHotMemory(this.env.MEMORY, chatId as string);
        
        return this.jsonResponse({ user, sessions, recentMessages, memory });
      }
      
      if (url.pathname === '/debug/stats') {
        const userCount = this.sql.exec(`SELECT COUNT(*) as count FROM users`).toArray()[0];
        const messageCount = this.sql.exec(`SELECT COUNT(*) as count FROM messages`).toArray()[0];
        const sessionCount = this.sql.exec(`SELECT COUNT(*) as count FROM sessions`).toArray()[0];
        const statusBreakdown = this.sql.exec(`SELECT status, COUNT(*) as count FROM users GROUP BY status`).toArray();
        
        return this.jsonResponse({
          users: userCount?.count || 0,
          messages: messageCount?.count || 0,
          sessions: sessionCount?.count || 0,
          byStatus: statusBreakdown
        });
      }
      
      // Debug endpoint to test R2 connection
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
      
      // Debug endpoint to manually initialize memory for a user
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
    
    // ALWAYS ensure R2 memory exists (fixes existing users who don't have it)
    await initializeUserMemory(this.env.MEMORY, chatId, user.first_name);
    
    // Handle /start command
    if (content === '__START__') {
      await this.sendWelcomeMessage(user, isFirstTimeUser);
      return;
    }
    
    // Check trial limit
    if (user.status === 'trial' && user.trial_messages_remaining <= 0) {
      await this.sendMessage(chatId, 
        `hey ${user.first_name}! you've used all your free messages. to keep chatting, upgrade to unlimited access 💬\n\n[link coming soon]`
      );
      return;
    }
    
    // Session management
    const lastSessionResult = this.sql.exec(`SELECT * FROM sessions WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1`, chatId).toArray();
    const lastSession = lastSessionResult.length > 0 ? lastSessionResult[0] as Session : null;
    
    const needsNewSession = !lastSession || 
      (now.getTime() - new Date(lastSession.started_at).getTime() > SESSION_TIMEOUT_MS);
    
    let sessionId: string;
    
    if (needsNewSession) {
      // Close previous session and run extractions
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
    this.sql.exec(`UPDATE users SET message_count = message_count + 1, trial_messages_remaining = trial_messages_remaining - 1, last_message_at = ? WHERE chat_id = ?`, now.toISOString(), chatId);
    
    // Generate response with memory
    const response = await this.generateResponse(chatId, sessionId, user);
    
    // Store assistant response
    this.sql.exec(`INSERT INTO messages (chat_id, session_id, role, content, timestamp) VALUES (?, ?, 'assistant', ?, ?)`, chatId, sessionId, response, new Date().toISOString());
    this.sql.exec(`UPDATE sessions SET message_count = message_count + 1 WHERE id = ?`, sessionId);
    
    // Send to Telegram
    await this.sendMessage(chatId, response);
    
    // Update user status
    this.updateUserStatus(chatId);
  }

  private async sendWelcomeMessage(user: User, isFirstTime: boolean): Promise<void> {
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    
    // Load memory for returning users
    const memory = await loadHotMemory(this.env.MEMORY, user.chat_id);
    const memoryContext = formatMemoryForPrompt(memory);
    
    const welcomeContext = isFirstTime 
      ? `\n\n[CONTEXT: ${user.first_name} just started chatting with you for the first time. Be warm, introduce yourself naturally, maybe ask what brings them here or what's on their mind. Keep it light.]`
      : `\n\n[CONTEXT: ${user.first_name} is back! You've talked before. Be casual and welcoming, maybe reference something from your history if relevant.]`;
    
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
    
    // Load conversation history
    const recentMessages = this.sql.exec(`SELECT role, content FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 20`, chatId).toArray().reverse();
    
    // Get the last user message for context detection
    const lastUserMessage = recentMessages.filter(m => m.role === 'user').pop();
    const messageContent = lastUserMessage?.content as string || '';
    
    // Load R2 memory
    const memory = await loadHotMemory(this.env.MEMORY, chatId);
    const memoryContext = formatMemoryForPrompt(memory);
    
    // Build dynamic prompt based on message content and phase
    const systemPrompt = buildPrompt(
      messageContent,
      new Date(),
      memory.relationship.phase
    ) + memoryContext;
    
    // Format messages for API
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
    
    if (user.status === 'trial' && user.message_count >= 10) {
      this.sql.exec(`UPDATE users SET status = 'hooked' WHERE chat_id = ?`, chatId);
    }
  }

  private async closeSession(sessionId: string, chatId: string, messageCount: number): Promise<void> {
    const now = new Date().toISOString();
    this.sql.exec(`UPDATE sessions SET ended_at = ? WHERE id = ?`, now, sessionId);
    
    // Run extractions if enough messages
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
    // Find sessions that ended more than 15 min ago without extractions
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
    
    const eligibleUsers = this.sql.exec(`
      SELECT * FROM users 
      WHERE status IN ('trial', 'hooked', 'active')
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
    
    // Load memory for context
    const memory = await loadHotMemory(this.env.MEMORY, user.chat_id);
    const memoryContext = formatMemoryForPrompt(memory);
    
    // Check for active threads to follow up on
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
    
    // Archive old sessions to R2
    const oldSessions = this.sql.exec(`SELECT * FROM sessions WHERE ended_at < ?`, cutoff).toArray();
    
    if (oldSessions.length > 0) {
      const archiveKey = `archives/sessions_${new Date().toISOString().split('T')[0]}.json`;
      await this.env.MEMORY.put(archiveKey, JSON.stringify(oldSessions));
      
      for (const session of oldSessions) {
        this.sql.exec(`DELETE FROM messages WHERE session_id = ?`, session.id);
        this.sql.exec(`DELETE FROM sessions WHERE id = ?`, session.id);
      }
    }
    
    // Update user statuses
    const pauseCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    this.sql.exec(`UPDATE users SET status = 'paused' WHERE status IN ('trial', 'hooked', 'active') AND last_message_at < ?`, pauseCutoff);
    this.sql.exec(`UPDATE users SET status = 'churned' WHERE status = 'paused' AND last_message_at < ?`, cutoff);
  }

  private jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
  }
}
