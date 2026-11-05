/** An error we expect and can explain to the client: status code, stable machine code, human message. */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details; // optional, e.g. per-line problems in an order
  }
}

/** Last middleware: turns any thrown error into a JSON response. Unknown errors never leak internals. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    const error = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    return res.status(err.status).json({ error });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'too_large', message: 'Request body is too large' } });
  }
  console.error('[unhandled]', err);
  return res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
}
