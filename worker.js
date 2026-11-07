// Функция для проверки подписи Telegram (защита от подделки пользователя)
async function validateTelegramData(initData, botToken) {
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    if (!hash) return false;
    urlParams.delete('hash');
    
    const dataCheckString = [...urlParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      'raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));
    
    const key = await crypto.subtle.importKey(
      'raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(dataCheckString));
    
    const hashHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hash === hashHex;
  } catch (e) {
    return false;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Секретный маршрут для установки вебхука (токен остается на сервере)
    if (url.pathname === '/api/setup-webhook') {
      const webhookUrl = `https://lucky-roger-slot.qx420.workers.dev/api/webhook`;
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      const data = await res.json();
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    }

    // 1. Получить баланс игрока
    if (url.pathname === '/api/balance' && request.method === 'POST') {
      try {
        const { initData } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) {
          return new Response(JSON.stringify({ error: 'Invalid auth' }), { status: 403 });
        }
        
        const userId = new URLSearchParams(initData).get('user') ? JSON.parse(new URLSearchParams(initData).get('user')).id : null;
        if (!userId) throw new Error('No user ID');

        let balance = await env.LUCKY_DB.get(`user_${userId}`);
        if (balance === null) {
          balance = 1000; // Бонус новичку при первом входе
          await env.LUCKY_DB.put(`user_${userId}`, balance.toString());
        }
        return new Response(JSON.stringify({ balance: parseInt(balance) }), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) { 
        return new Response(JSON.stringify({ error: e.message }), { status: 500 }); 
      }
    }

    // 2. Синхронизировать баланс (после спина)
    if (url.pathname === '/api/sync' && request.method === 'POST') {
      try {
        const { initData, balance } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) {
          return new Response('Forbidden', { status: 403 });
        }
        const userId = JSON.parse(new URLSearchParams(initData).get('user')).id;
        await env.LUCKY_DB.put(`user_${userId}`, balance.toString());
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) { 
        return new Response(JSON.stringify({ error: e.message }), { status: 500 }); 
      }
    }

    // 3. Создать счет на оплату (Stars)
    if (url.pathname === '/api/invoice' && request.method === 'POST') {
      try {
        const { initData, packageId } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) {
          return new Response('Forbidden', { status: 403 });
        }
        const userId = JSON.parse(new URLSearchParams(initData).get('user')).id;

        const ALLOWED = { 
          p100: { s: 100, c: 1000 }, 
          p500: { s: 500, c: 6000 }, 
          p2000: { s: 2000, c: 30000 }, 
          p10000: { s: 10000, c: 200000 } 
        };
        const pkg = ALLOWED[packageId];
        if (!pkg) return new Response('Invalid package', { status: 400 });

        const tgResponse = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createInvoiceLink`, {
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `${pkg.c} монет — Lucky Roger`, 
            description: 'Пакет игровой валюты', 
            payload: JSON.stringify({ userId: userId, coins: pkg.c }), 
            currency: 'XTR',
            prices: [{ label: 'Монеты', amount: pkg.s }]
          })
        });
        
        const data = await tgResponse.json();
        return new Response(JSON.stringify({ invoiceLink: data.result }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      } catch(e) { 
        return new Response(JSON.stringify({ error: e.message }), { status: 500 }); 
      }
    }

    // 4. ВЕБХУК ОТ TELEGRAM (зачисление монет после оплаты)
    if (url.pathname === '/api/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        if (update.message && update.message.successful_payment) {
          const payload = JSON.parse(update.message.successful_payment.invoice_payload);
          const userId = payload.userId;
          const coins = payload.coins;
          
          let balance = await env.LUCKY_DB.get(`user_${userId}`) || '0';
          await env.LUCKY_DB.put(`user_${userId}`, (parseInt(balance) + coins).toString());
        }
        return new Response('ok');
      } catch(e) { 
        return new Response('ok'); 
      }
    }

    // Если запрос не к API — отдаем игру (index.html)
    return env.ASSETS.fetch(request);
  }
};
