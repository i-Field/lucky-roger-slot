async function validateTelegramData(initData, botToken) {
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    if (!hash) return false;
    urlParams.delete('hash');
    const dataCheckString = [...urlParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(dataCheckString));
    const hashHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hash === hashHex;
  } catch (e) { return false; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/setup-webhook') {
      const webhookUrl = `https://lucky-roger-slot.qx420.workers.dev/api/webhook`;
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      return new Response(JSON.stringify(await res.json()), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/api/leaderboard') {
      try {
        const list = await env.LUCKY_DB.list({ prefix: 'user_' });
        let users = [];
        for (let key of list.keys) {
          let bal = await env.LUCKY_DB.get(key.name);
          if (bal) users.push({ id: key.name.replace('user_', ''), balance: parseInt(bal) });
        }
        users.sort((a, b) => b.balance - a.balance);
        return new Response(JSON.stringify(users.slice(0, 10)), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) { return new Response('[]', { headers: { 'Content-Type': 'application/json' } }); }
    }

    if (url.pathname === '/api/balance' && request.method === 'POST') {
      try {
        const { initData } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) return new Response('Forbidden', { status: 403 });
        const userId = JSON.parse(new URLSearchParams(initData).get('user')).id;
        
        let balance = await env.LUCKY_DB.get(`user_${userId}`);
        if (balance === null) { balance = 1000; await env.LUCKY_DB.put(`user_${userId}`, balance.toString()); }
        
        let jackpot = await env.LUCKY_DB.get('global_jackpot');
        if (jackpot === null) { jackpot = 50000; await env.LUCKY_DB.put('global_jackpot', jackpot.toString()); }

        return new Response(JSON.stringify({ balance: parseInt(balance), jackpot: parseInt(jackpot) }), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (url.pathname === '/api/spin' && request.method === 'POST') {
      try {
        // 🔥 ИСПРАВЛЕНИЕ ЗДЕСЬ: заменили const на let, чтобы можно было прибавить джекпот
        let { initData, newBalance, betAmount } = await request.json();
        
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) return new Response('Forbidden', { status: 403 });
        const userId = JSON.parse(new URLSearchParams(initData).get('user')).id;
        
        let jackpot = parseInt(await env.LUCKY_DB.get('global_jackpot') || '50000');
        jackpot += Math.floor(betAmount * 0.02); // 2% в джекпот
        
        let jackpotWon = false;
        let winAmount = 0;
        
        // Шанс выиграть джекпот (0.1%)
        if (Math.random() < 0.001) { 
          jackpotWon = true;
          winAmount = jackpot;
          newBalance += jackpot; // Теперь это работает, т.к. newBalance - это let
          jackpot = 50000; 
        }
        
        await env.LUCKY_DB.put(`user_${userId}`, newBalance.toString());
        await env.LUCKY_DB.put('global_jackpot', jackpot.toString());

        return new Response(JSON.stringify({ ok: true, jackpot, jackpotWon, winAmount, newBalance }), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (url.pathname === '/api/invoice' && request.method === 'POST') {
      try {
        const { initData, packageId } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) return new Response('Forbidden', { status: 403 });
        const userId = JSON.parse(new URLSearchParams(initData).get('user')).id;
        const ALLOWED = { p100: { s: 100, c: 1000 }, p500: { s: 500, c: 6000 }, p2000: { s: 2000, c: 30000 }, p10000: { s: 10000, c: 200000 } };
        const pkg = ALLOWED[packageId];
        if (!pkg) return new Response('Invalid', { status: 400 });
        const tgResponse = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createInvoiceLink`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: `${pkg.c} монет`, description: 'Пакет монет', payload: JSON.stringify({ userId, coins: pkg.c }), currency: 'XTR', prices: [{ label: 'Монеты', amount: pkg.s }] })
        });
        const data = await tgResponse.json();
        return new Response(JSON.stringify({ invoiceLink: data.result }), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (url.pathname === '/api/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        if (update.message?.successful_payment) {
          const payload = JSON.parse(update.message.successful_payment.invoice_payload);
          let balance = parseInt(await env.LUCKY_DB.get(`user_${payload.userId}`) || '0');
          await env.LUCKY_DB.put(`user_${payload.userId}`, (balance + payload.coins).toString());
        }
        return new Response('ok');
      } catch(e) { return new Response('ok'); }
    }

    return env.ASSETS.fetch(request);
  }
};
