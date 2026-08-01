type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * One-line JSON logs. Deliberately dependency-free — swap for pino the day a
 * real observability story lands, not before.
 */
export function createLogger(minLevel: Level) {
  const emit = (level: Level, message: string, fields?: Record<string, unknown>) => {
    if (order[level] < order[minLevel]) return;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      msg: message,
      ...fields,
    });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  };

  return {
    debug: (message: string, fields?: Record<string, unknown>) => emit('debug', message, fields),
    info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
    error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
  };
}

export type Logger = ReturnType<typeof createLogger>;
