// ============================================================
// SADIE HARTLEY - Character Worker
// ============================================================

import { SadieAgent } from './agent';

export { SadieAgent };

const VERSION = {
  version: '1.0.2',
  character: 'sadie',
  display_name: 'Sadie Hartley'
};

interface Env {
  MEMORY: R2Bucket;
  CHARACTER: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    date: number;
    text?: string;
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    const id = env.CHARACTER.idFromName('sadie-v1');
    const character = env.CHARACTER.get(id);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', ...VERSION }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/version') {
      return new Response(`${VERSION.display_name} v${VERSION.version}`);
    }

    if (url.pathname === '/telegram' && request.method === 'POST') {
      // Validate webhook is from Telegram
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        console.error('Invalid webhook secret');
        return new Response('Unauthorized', { status: 401 });
      }

      const update = await request.json() as TelegramUpdate;
      
      if (!update.message?.text) {
        return new Response('OK');
      }
      
      const chatId = update.message.chat.id.toString();
      const content = update.message.text;
      const user = update.message.from;

      const isStartCommand = content.startsWith('/start');
      let refCode: string | null = null;
      
      if (isStartCommand) {
        const parts = content.split(' ');
        if (parts.length > 1) {
          refCode = parts[1];
        }
      }

      ctx.waitUntil(
        fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, action: 'typing' })
        })
      );

      ctx.waitUntil(
        character.fetch(new Request('https://internal/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            content: isStartCommand ? '__START__' : content, 
            chatId,
            user: {
              id: user.id,
              firstName: user.first_name,
              lastName: user.last_name,
              username: user.username
            },
            refCode,
            isNewUser: isStartCommand
          })
        }))
      );

      return new Response('OK');
    }

    if (url.pathname === '/setup-webhook' && request.method === 'POST') {
      const webhookUrl = `${url.origin}/telegram`;
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            url: webhookUrl,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET
          })
        }
      );
      const result = await response.json();
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/webhook-info') {
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`
      );
      const result = await response.json();
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname.startsWith('/debug/') || url.pathname.startsWith('/admin/')) {
      return character.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};
