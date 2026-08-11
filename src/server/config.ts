// Server configuration.
//
// All configuration comes from environment variables. Missing required keys
// abort startup with a clear error rather than silently defaulting. This keeps
// deployments explicit and makes it hard to run the API against the wrong
// database or with insecure defaults.

export interface ServerConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly httpPort: number;
  readonly httpHost: string;
  readonly databaseUrl: string;
  readonly databaseSchema: string;
  readonly redisUrl: string;
  readonly jwtPublicKey?: string;
  readonly signingSecret: string;
  readonly telemetryServiceName: string;
  readonly telemetryLogLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly featureFlagsDefaultOff: boolean;
  readonly jobBusDriver: 'bullmq' | 'kafka' | 'inprocess';
  readonly kafkaBrokers: readonly string[];
  readonly kafkaClientId: string;
}

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v === '') throw new ConfigError(`Missing required env: ${key}`);
  return v;
}
function opt(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}
function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(`Env ${key} must be numeric`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnvRaw = opt(env, 'NODE_ENV', 'development');
  const nodeEnv = nodeEnvRaw === 'production' || nodeEnvRaw === 'test' ? nodeEnvRaw : 'development';
  const logLevelRaw = opt(env, 'HH_LOG_LEVEL', 'info');
  const telemetryLogLevel = (['debug', 'info', 'warn', 'error'] as const).includes(logLevelRaw as 'info') ? (logLevelRaw as ServerConfig['telemetryLogLevel']) : 'info';
  return {
    nodeEnv,
    httpPort: num(env, 'HH_HTTP_PORT', 8080),
    httpHost: opt(env, 'HH_HTTP_HOST', '0.0.0.0'),
    databaseUrl: nodeEnv === 'production' ? req(env, 'HH_DATABASE_URL') : opt(env, 'HH_DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/healthcare_harness'),
    databaseSchema: opt(env, 'HH_DATABASE_SCHEMA', 'harness'),
    redisUrl: nodeEnv === 'production' ? req(env, 'HH_REDIS_URL') : opt(env, 'HH_REDIS_URL', 'redis://localhost:6379'),
    ...(env['HH_JWT_PUBLIC_KEY'] ? { jwtPublicKey: env['HH_JWT_PUBLIC_KEY'] } : {}),
    signingSecret: nodeEnv === 'production' ? req(env, 'HH_SIGNING_SECRET') : opt(env, 'HH_SIGNING_SECRET', 'dev-secret-do-not-use-in-prod'),
    telemetryServiceName: opt(env, 'HH_SERVICE_NAME', 'healthcare-harness'),
    telemetryLogLevel,
    featureFlagsDefaultOff: opt(env, 'HH_FLAGS_DEFAULT_OFF', 'true') === 'true',
    jobBusDriver: ((): 'bullmq' | 'kafka' | 'inprocess' => {
      const raw = opt(env, 'HH_JOBBUS_DRIVER', 'bullmq');
      if (raw === 'bullmq' || raw === 'kafka' || raw === 'inprocess') return raw;
      throw new ConfigError(`HH_JOBBUS_DRIVER must be bullmq|kafka|inprocess, got ${raw}`);
    })(),
    kafkaBrokers: opt(env, 'HH_KAFKA_BROKERS', 'localhost:9092').split(',').map((s) => s.trim()).filter(Boolean),
    kafkaClientId: opt(env, 'HH_KAFKA_CLIENT_ID', 'healthcare-harness'),
  };
}
