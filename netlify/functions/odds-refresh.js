const { buildOdds } = require('./odds-lib');

exports.handler = async () => {
  try {
    const mod = await import('@netlify/blobs');
    const store = mod.getStore({
      name: 'board-state',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_AUTH_TOKEN
    });
    const payload = await buildOdds();
    await store.setJSON('odds', payload);
    return { statusCode: 200, body: JSON.stringify({ ok: true, count: payload.count, updatedAt: payload.updatedAt }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
