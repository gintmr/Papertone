import { isIP } from 'node:net';

const PATHS = new Set(['/Papertone/']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOT = /bot\b|crawler|spider|slurp|headless|lighthouse|pagespeed|preview|curl\/|wget\/|python-requests|go-http-client/i;
const COUNTRY_CODES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
const encoder = new TextEncoder();

export function normalizeIp(value) {
  if (typeof value !== 'string' || value.length > 64 || value.includes(',')) return null;
  const ip = value.trim();
  const version = isIP(ip);
  if (!version) return null;
  if (version === 4) return ip;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  // IPv4-mapped IPv6 must share exclusions and daily identity with IPv4.
  const mapped = canonical.match(/^::ffff:([\da-f]+):([\da-f]+)$/);
  if (mapped) {
    const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return canonical;
}

export function isPublicIp(ip) {
  if (!ip) return false;
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  // Global unicast only; exclude documentation space within 2000::/3.
  return /^[23]/.test(ip) && !ip.startsWith('2001:db8:');
}

export function normalizeCountry(code) {
  return typeof code === 'string' && COUNTRY_CODES.has(code.toUpperCase()) ? code.toUpperCase() : null;
}

function validOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin && !url.username &&
      !/^(localhost|127\.|\[::1\])/.test(url.hostname) && !/\.(local|localhost|test|invalid)$/.test(url.hostname);
  } catch { return false; }
}

export function readConfig(get) {
  const origins = (get('VISITOR_ALLOWED_ORIGINS') || '').split(',').map(x => x.trim()).filter(Boolean);
  const secret = get('VISITOR_HASH_SECRET') || '';
  const ipHeader = (get('VISITOR_CLIENT_IP_HEADER') || '').trim().toLowerCase();
  const supabaseUrl = (get('SUPABASE_URL') || '').replace(/\/$/, '');
  const serviceKey = get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const geoProvider = get('VISITOR_GEO_PROVIDER') || 'none';
  const geoToken = get('IPINFO_TOKEN') || '';
  const countryHeader = (get('VISITOR_COUNTRY_HEADER') || '').trim().toLowerCase();
  // Require explicit proxy verification. No client-controlled fallback header.
  const proxyVerified = get('VISITOR_PROXY_HEADERS_VERIFIED') === 'true';
  const excludedIps = new Set((get('VISITOR_EXCLUDED_IPS') || '').split(',').map(normalizeIp).filter(Boolean));
  const ready = origins.length > 0 && origins.every(validOrigin) && secret.length >= 32 &&
    /^[a-z0-9-]+$/.test(ipHeader) && proxyVerified &&
    /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(supabaseUrl) && !!serviceKey &&
    ['none', 'proxy-header', 'country-is', 'ipinfo'].includes(geoProvider) && (geoProvider !== 'ipinfo' || !!geoToken) &&
    (geoProvider !== 'proxy-header' || /^[a-z0-9-]+$/.test(countryHeader));
  return { origins: new Set(origins), secret, ipHeader, supabaseUrl, serviceKey, geoProvider, geoToken, countryHeader, excludedIps, ready };
}

export async function dailyHashes(secret, ip, userAgent, day) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hash = async (parts) => {
    const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(parts)));
    return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
  };
  const [visitorHash, ipHash] = await Promise.all([
    hash(['visitor-v1', day, ip, userAgent]), hash(['rate-v1', day, ip]),
  ]);
  return { visitorHash, ipHash };
}

export function validateEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 2 || !UUID.test(body.eventId) || !PATHS.has(body.path)) return null;
  return { eventId: body.eventId.toLowerCase(), path: body.path };
}

const validCursor = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;

function readView(request) {
  const query = new URL(request.url).search;
  if (!query) return { view: 'summary' };
  if (request.method !== 'GET' || query.length > 80) return null;
  const params = new URLSearchParams(query);
  const keys = [...params.keys()];
  if (keys.some(key => !['view', 'before', 'page', 'snapshot'].includes(key)) ||
      params.getAll('view').length !== 1 || params.get('view') !== 'activity' ||
      ['before', 'page', 'snapshot'].some(key => params.getAll(key).length > 1)) return null;
  if (params.has('page')) {
    const page = params.get('page');
    const snapshot = params.get('snapshot');
    if (params.has('before') || !/^[1-9][0-9]{0,6}$/.test(page) || Number(page) > 1000000 ||
        (snapshot !== null && !validCursor(snapshot))) return null;
    return { view: 'activity-page', page: Number(page), snapshot };
  }
  if (params.has('snapshot')) return null;
  const before = params.get('before');
  if (before !== null && !validCursor(before)) return null;
  return { view: 'activity', before };
}

function publicActivityRecords(records, limit) {
  if (!Array.isArray(records) || records.length > limit) throw new Error('Invalid activity records');
  return records.map(row => {
    if (typeof row?.visitedAt !== 'string' || row.visitedAt.length > 40 ||
        !Number.isFinite(Date.parse(row.visitedAt)) ||
        (row.countryCode !== null && normalizeCountry(row.countryCode) !== row.countryCode) ||
        (row.path !== null && !PATHS.has(row.path))) throw new Error('Invalid activity record');
    // Explicit projection keeps internal IDs and any future private fields out.
    return { visitedAt: row.visitedAt, countryCode: row.countryCode, path: row.path };
  });
}

function publicActivity(data) {
  if (data?.version !== 1 || (data.nextCursor !== null && !validCursor(data.nextCursor))) {
    throw new Error('Invalid activity result');
  }
  return { version: 1, records: publicActivityRecords(data.records, 25), nextCursor: data.nextCursor };
}

function publicActivityPage(data, requested) {
  if (data?.version !== 2 || data.pageSize !== 20 ||
      !Number.isSafeInteger(data.totalRecords) || data.totalRecords < 0 ||
      !Number.isSafeInteger(data.totalPages) || data.totalPages !== Math.ceil(data.totalRecords / 20) ||
      !Number.isInteger(data.page) || data.page < 1 || data.page > 1000000 ||
      data.page !== Math.min(requested.page, Math.max(1, data.totalPages)) ||
      (data.totalRecords === 0 ? data.snapshot !== null : !validCursor(data.snapshot)) ||
      (data.snapshot !== null && requested.snapshot !== null && BigInt(data.snapshot) > BigInt(requested.snapshot))) {
    throw new Error('Invalid activity page');
  }
  const records = publicActivityRecords(data.records, 20);
  if (records.length !== Math.min(20, data.totalRecords - (data.page - 1) * 20)) {
    throw new Error('Invalid activity page length');
  }
  return {
    version: 2, records, page: data.page, pageSize: 20,
    totalRecords: data.totalRecords, totalPages: data.totalPages, snapshot: data.snapshot,
  };
}

async function readSmallJson(request) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw { status: 415 };
  }
  if (Number(request.headers.get('content-length')) > 512) throw { status: 413 };
  if (!request.body) throw { status: 400 };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 512) { await reader.cancel(); throw { status: 413 }; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw { status: 400 }; }
}

export function createHandler(config, dependencies = {}) {
  const fetcher = dependencies.fetch || fetch;
  const now = dependencies.now || (() => new Date());
  let summaryCache = null;
  const countryCache = new Map();
  const rpc = dependencies.rpc || (async (name, args) => {
    const response = await fetcher(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` },
      body: JSON.stringify(args), signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error('Statistics database unavailable');
    return response.json();
  });
  const countryFor = async (ip, ipHash, timestamp) => {
    if (!['country-is', 'ipinfo'].includes(config.geoProvider)) return null;
    const cached = countryCache.get(ipHash);
    if (cached && cached.expires > timestamp) return cached.country;
    let country = null;
    try {
      const countryIs = config.geoProvider === 'country-is';
      const url = new URL(countryIs
        ? `https://api.country.is/${encodeURIComponent(ip)}`
        : `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}`);
      if (!countryIs) url.searchParams.set('token', config.geoToken);
      const response = await fetcher(url, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      if (response.ok) {
        const data = await response.json();
        if (!countryIs || normalizeIp(data.ip) === ip) {
          country = normalizeCountry(countryIs ? data.country : data.country_code);
        }
      }
    } catch { /* Unknown location must not prevent counting a valid pageview. */ }
    if (countryCache.size >= 1000) countryCache.delete(countryCache.keys().next().value);
    countryCache.set(ipHash, { country, expires: timestamp + (country ? 3600000 : 300000) });
    return country;
  };

  return async (request) => {
    const origin = request.headers.get('origin');
    const allowed = !!origin && config.origins.has(origin);
    const publicRead = request.method === 'GET' || (request.method === 'OPTIONS' &&
      request.headers.get('access-control-request-method')?.toUpperCase() === 'GET');
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Origin', 'x-content-type-options': 'nosniff' };
    if (publicRead) headers['access-control-allow-origin'] = '*';
    else if (allowed) headers['access-control-allow-origin'] = origin;
    const json = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...headers, ...extra } });
    if (!publicRead && !allowed) return json(403, { error: 'Origin not allowed' });
    if (request.method === 'OPTIONS') return json(204, null, {
      'access-control-allow-methods': publicRead ? 'GET, OPTIONS' : 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400',
    });
    if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'Method not allowed' }, { allow: 'GET, POST, OPTIONS' });
    const read = readView(request);
    if (!read) return json(400, { error: 'Invalid query parameters' });
    if (!config.ready) return json(503, { error: 'Statistics are not configured' });

    try {
      const userAgent = request.headers.get('user-agent') || '';
      if (request.method === 'POST' && (request.headers.get('dnt') === '1' || request.headers.get('sec-gpc') === '1' ||
          !userAgent || userAgent.length > 1024 || BOT.test(userAgent))) return json(204, null);
      const ip = normalizeIp(request.headers.get(config.ipHeader));
      if (!ip) return json(503, { error: 'Verified client address unavailable' });
      if (!isPublicIp(ip)) return request.method === 'POST'
        ? json(204, null) : json(403, { error: 'Statistics unavailable for this request' });
      if (request.method === 'POST' && config.excludedIps.has(ip)) return json(204, null);
      const instant = now();
      const day = instant.toISOString().slice(0, 10);
      const { visitorHash, ipHash } = await dailyHashes(config.secret, ip, userAgent, day);
      const kind = request.method === 'GET' ? 'summary' : 'track';
      const event = kind === 'track' ? validateEvent(await readSmallJson(request)) : null;
      if (kind === 'track' && !event) return json(400, { error: 'Invalid event' });
      if (!await rpc('papertone_analytics_rate_limit', { p_ip_hash: ipHash, p_kind: kind })) {
        return json(429, { error: 'Too many requests' }, { 'retry-after': '60' });
      }
      if (kind === 'summary') {
        if (read.view === 'activity-page') {
          return json(200, publicActivityPage(await rpc('papertone_analytics_activity_page', {
            p_page: read.page, p_snapshot: read.snapshot,
          }), read));
        }
        if (read.view === 'activity') {
          return json(200, publicActivity(await rpc('papertone_analytics_activity', { p_before: read.before })));
        }
        if (!summaryCache || summaryCache.expires <= instant.getTime() || summaryCache.day !== day) {
          summaryCache = { data: await rpc('papertone_analytics_summary', {}), expires: instant.getTime() + 60000, day };
        }
        return json(200, summaryCache.data, { 'cache-control': 'public, max-age=60' });
      }
      const country = config.geoProvider === 'proxy-header'
        ? normalizeCountry(request.headers.get(config.countryHeader))
        : await countryFor(ip, ipHash, instant.getTime());
      await rpc('papertone_analytics_track_v2', {
        p_event_id: event.eventId, p_visitor_hash: visitorHash, p_day: day,
        p_country_code: country, p_path: event.path,
      });
      return json(202, { ok: true });
    } catch (error) {
      const status = [400, 413, 415].includes(error?.status) ? error.status : 503;
      // Do not log request headers, IPs, query URLs, tokens or backend errors.
      return json(status, { error: status === 503 ? 'Statistics temporarily unavailable' : 'Invalid request body' });
    }
  };
}
