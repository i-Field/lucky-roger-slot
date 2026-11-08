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

    // ТАБЛИЦА ЛИДЕРОВ (теперь с именами)
    if (url.pathname === '/api/leaderboard') {
      try {
        const list = await env.LUCKY_DB.list({ prefix: 'user_' });
        let users = [];
        for (let key of list.keys) {
          let bal = await env.LUCKY_DB.get(key.name);
          let name = await env.LUCKY_DB.get(`name_${key.name.replace('user_', '')}`);
          if (bal) users.push({ id: key.name.replace('user_', ''), balance: parseInt(bal), name: name || 'Пират' });
        }
        users.sort((a, b) => b.balance - a.balance);
        return new Response(JSON.stringify(users.slice(0, 10)), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) { return new Response('[]', { headers: { 'Content-Type': 'application/json' } }); }
    }

    if (url.pathname === '/api/connect_wallet' && request.method === 'POST') {
      try {
        const { initData, wallet } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) return new Response('Forbidden', { status: 403 });
        const userId = JSON.parse(new URLSearchParams(initData).get('user')).id;
        await env.LUCKY_DB.put(`wallet_${userId}`, wallet);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    // КОЛЕСО ФОРТУНЫ
    if (url.pathname === '/api/wheel' && request.method === 'POST') {
      try {
        const { initData } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) return new Response('Forbidden', { status: 403 });
        const userId = JSON.parse(new URLSearchParams(initData).get('user')).id;
        
        let lastWheel = parseInt(await env.LUCKY_DB.get(`wheel_${userId}`) || '0');
        if (Date.now() - lastWheel < 24 * 3600 * 1000) {
          return new Response(JSON.stringify({ error: 'Wait 24h' }), { status: 400 });
        }
        
        let balance = parseInt(await env.LUCKY_DB.get(`user_${userId}`) || '1000');
        const prizes = [100, 200, 500, 1000, 2000, 5000, 10000];
        const prize = prizes[Math.floor(Math.random() * prizes.length)];
        
        balance += prize;
        await env.LUCKY_DB.put(`user_${userId}`, balance.toString());
        await env.LUCKY_DB.put(`wheel_${userId}`, Date.now().toString());
        
        return new Response(JSON.stringify({ ok: true, prize, balance }), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (url.pathname === '/api/balance' && request.method === 'POST') {
      try {
        const { initData, startParam } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) return new Response('Forbidden', { status: 403 });
        
        const userObj = JSON.parse(new URLSearchParams(initData).get('user'));
        const userId = userObj.id;
        
        // Сохраняем имя игрока для ТОПа
        if (userObj.first_name) {
          await env.LUCKY_DB.put(`name_${userId}`, userObj.first_name);
        }

        let balance = await env.LUCKY_DB.get(`user_${userId}`);
        
        if (balance === null) {
          balance = 1000;
          await env.LUCKY_DB.put(`user_${userId}`, balance.toString());
          
          if (startParam && startParam.startsWith('ref_')) {
            const referrerId = startParam.replace('ref_', '');
            if (referrerId !== userId.toString()) {
              let refBal = parseInt(await env.LUCKY_DB.get(`user_${referrerId}`) || '0');
              await env.LUCKY_DB.put(`user_${referrerId}`, (refBal + 5000).toString());
              let refCount = parseInt(await env.LUCKY_DB.get(`refcount_${referrerId}`) || '0');
              await env.LUCKY_DB.put(`refcount_${referrerId}`, (refCount + 1).toString());
            }
          }
        }
        
        let jackpot = await env.LUCKY_DB.get('global_jackpot');
        if (jackpot === null) { jackpot = 50000; await env.LUCKY_DB.put('global_jackpot', jackpot.toString()); }
        
        let wallet = await env.LUCKY_DB.get(`wallet_${userId}`) || '';
        let refCount = await env.LUCKY_DB.get(`refcount_${userId}`) || '0';
        let spins = await env.LUCKY_DB.get(`spins_${userId}`) || '0';
        let lastWheel = parseInt(await env.LUCKY_DB.get(`wheel_${userId}`) || '0');
        let wheelAvailable = (Date.now() - lastWheel > 24 * 3600 * 1000);

        return new Response(JSON.stringify({ 
          balance: parseInt(balance), 
          jackpot: parseInt(jackpot),
          wallet: wallet,
          refCount: parseInt(refCount),
          spins: parseInt(spins),
          wheelAvailable: wheelAvailable
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (url.pathname === '/api/spin' && request.method === 'POST') {
      try {
        let { initData, newBalance, betAmount } = await request.json();
        if (!await validateTelegramData(initData, env.BOT_TOKEN)) return new Response('Forbidden', { status: 403 });
        const userId = JSON.parse(new URLSearchParams(initData).get('user')).id;
        
        let spins = parseInt(await env.LUCKY_DB.get(`spins_${userId}`) || '0');
        await env.LUCKY_DB.put(`spins_${userId}`, (spins + 1).toString());

        let jackpot = parseInt(await env.LUCKY_DB.get('global_jackpot') || '50000');
        jackpot += Math.floor(betAmount * 0.02); 
        
        let jackpotWon = false;
        let winAmount = 0;
        
        if (Math.random() < 0.001) { 
          jackpotWon = true;
          winAmount = jackpot;
          newBalance += jackpot;
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

    // ВЕБХУК (ОТВЕТ НА /start И ОПЛАТА)
    if (url.pathname === '/api/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();

        // ОТВЕТ НА КОМАНДУ /start
        if (update.message && update.message.text && update.message.text.startsWith('/start')) {
          const chatId = update.message.chat.id;
          const gameUrl = 'https://lucky-roger-slot.qx420.workers.dev/?v=999'; // Твоя ссылка

          const replyMarkup = {
            inline_keyboard: [[
              { text: "🏴‍☠️ Открыть Lucky Roger", web_app: { url: gameUrl } }
            ]]
          };

          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: "🏴‍☠️ **Добро пожаловать на борт, пират!**\n\nТебя ждет пиратский слот, огромный джекпот и сокровища! На старт мы выдаем тебе **1000 монет**.\n\nЖми кнопку ниже и испытай удачу!",
              parse_mode: 'Markdown',
              reply_markup: replyMarkup
            })
          });
        }

        // ОБРАБОТКА ОПЛАТЫ
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
