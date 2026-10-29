/** Environment validation. Throws one error listing every problem (never prints secret values). */
export function loadConfig(env = process.env, overrides = {}) {
  const errors = [];
  const nodeEnv = env.NODE_ENV || 'development';
  const prod = nodeEnv === 'production';

  const need = (name, { min = 1, msg } = {}) => {
    const val = env[name];
    if (!val || val.length < min) errors.push(msg || `${name} is required${min > 1 ? ` (min ${min} characters)` : ''}`);
    return val;
  };

  const jwtSecret = need('JWT_SECRET', { min: 32 });
  const analyticsSalt = need('ANALYTICS_SALT', { min: 16 });
  const adminEmail = need('ADMIN_EMAIL');
  const adminPassword = need('ADMIN_PASSWORD', { min: 10 });
  if (adminEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) errors.push('ADMIN_EMAIL is not a valid email');
  const analystEmail = env.ANALYST_EMAIL || null;
  const analystPassword = env.ANALYST_PASSWORD || null;
  if (analystEmail && (!analystPassword || analystPassword.length < 10)) errors.push('ANALYST_PASSWORD (min 10 chars) is required when ANALYST_EMAIL is set');

  const mongoUri = env.MONGODB_URI || null;
  if (prod && !mongoUri) errors.push('MONGODB_URI is required when NODE_ENV=production');

  const port = Number(env.PORT || 4000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push('PORT must be 0-65535');

  const corsOrigins = (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const o of corsOrigins) {
    if (o === '*') errors.push('CORS_ORIGINS must list explicit origins; "*" is not allowed');
    else if (!/^https?:\/\/[^/\s]+$/.test(o)) errors.push(`CORS_ORIGINS entry "${o}" is not a valid origin (scheme://host[:port])`);
  }

  if (errors.length) {
    const err = new Error(`Invalid environment configuration:\n - ${errors.join('\n - ')}`);
    err.configErrors = errors;
    throw err;
  }

  return {
    nodeEnv,
    prod,
    port,
    jwtSecret,
    analyticsSalt,
    jwtTtlSeconds: Number(env.JWT_TTL_SECONDS || 8 * 3600),
    adminEmail: adminEmail.toLowerCase(),
    adminPassword,
    analystEmail: analystEmail ? analystEmail.toLowerCase() : null,
    analystPassword,
    mongoUri,
    corsOrigins,
    baseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    trustProxy: env.TRUST_PROXY === 'true',
    tzOffsetMin: Number(env.TZ_OFFSET_MIN || 330),
    staticDir: env.STATIC_DIR || null,
    gemini: {
      apiKey: env.GEMINI_API_KEY || null,
      model: env.GEMINI_MODEL || 'gemini-2.5-flash',
      timeoutMs: Number(env.GEMINI_TIMEOUT_MS || 15000),
    },
    rateLimits: {
      public: { max: 120, windowMs: 60_000 },
      register: { max: 30, windowMs: 10 * 60_000 },
      login: { max: 10, windowMs: 15 * 60_000 },
      api: { max: 300, windowMs: 60_000 },
      ai: { max: 20, windowMs: 60_000 },
    },
    now: () => new Date(),
    ...overrides,
  };
}
