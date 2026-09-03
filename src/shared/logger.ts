type LogFields = Record<string, unknown>;

function write(level: string, message: string, fields?: LogFields): void {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  console.log(JSON.stringify(entry));
}

export const logger = {
  info(message: string, fields?: LogFields): void {
    write('INFO', message, fields);
  },
  warn(message: string, fields?: LogFields): void {
    write('WARN', message, fields);
  },
  error(message: string, fields?: LogFields): void {
    write('ERROR', message, fields);
  },
};
