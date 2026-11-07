export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { stars, coins, packageId } = body;

    // Защита от подмены цены
    const ALLOWED = {
      p100:   { stars: 100,   coins: 1000 },
      p500:   { stars: 500,   coins: 6000 },
      p2000:  { stars: 2000,  coins: 30000 },
      p10000: { stars: 10000, coins: 200000 }
    };
    
    const pkg = ALLOWED[packageId];
    if (!pkg || pkg.stars !== stars) {
      return new Response(JSON.stringify({ error: 'Invalid package' }), { status: 400 });
    }

    // Запрос к Telegram для создания счета
    const tgResponse = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `${pkg.coins} монет — Lucky Roger`,
        description: 'Пакет игровой валюты',
        payload: packageId,
        currency: 'XTR',
        prices: [{ label: 'Монеты', amount: pkg.stars }]
      })
    });

    const data = await tgResponse.json();
    
    if (!data.ok) {
      throw new Error(data.description || 'Telegram API error');
    }

    return new Response(JSON.stringify({ invoiceLink: data.result }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' } 
    });
  }
}
