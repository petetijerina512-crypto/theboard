const https = require('https');

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'TheBoard/1.0' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const params = event.queryStringParameters || {};
  const series = (params.series || 'KXMLBGAME').replace(/[^A-Z0-9]/g, '');
  const cursor = params.cursor ? '&cursor=' + encodeURIComponent(params.cursor) : '';
  const url = 'https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=' + series + '&status=open&limit=200' + cursor;

  try {
    const { status, json } = await getJson(url);
    return { statusCode: status || 200, headers, body: JSON.stringify(json) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ markets: [], error: String(e.message || e) }) };
  }
};
