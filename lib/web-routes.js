/**
 * Web route helpers for the dsh-remote-workspace bundle.
 *
 * Raw WebServer routes do not inherit the page Connection's authentication
 * fence, so every route registers through authenticatedWebRoutes(): a missing
 * or disposing Connection is an assembly failure (503), never an invitation
 * to expose remote hosts or accept connect requests.
 */

/** Drain one JSON request body with a hard size cap. */
export async function readJsonRequest(req, maxBytes = 1_000_000) {
  const raw = await new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (error) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      if (error) {
        chunks.length = 0;
        req.once('error', () => {});
        req.resume();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    const onData = (chunk) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > maxBytes) finish(new RequestBodyError('request body is too large', 413));
      else chunks.push(part);
    };
    const onEnd = () => finish();
    const onAborted = () => finish(new RequestBodyError('request body was aborted', 400));
    const onError = () => finish(new RequestBodyError('invalid request body', 400));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
  });
  let value;
  try { value = raw.trim() === '' ? {} : JSON.parse(raw); }
  catch { throw new RequestBodyError('invalid JSON', 400); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestBodyError('body must be an object', 400);
  }
  return value;
}

export class RequestBodyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

/** Wrap `server.register` so each handler passes the page Connection gate first. */
export function authenticatedWebRoutes(server, connection) {
  return {
    register(route) {
      return server.register({
        ...route,
        async handler(req, res) {
          const gate = connection();
          const rejection = gate === undefined ? 503 : gate.requestRejection(req);
          if (rejection !== undefined) {
            sendJson(res, rejection, {
              error: rejection === 503 ? 'authentication unavailable'
                : rejection === 401 ? 'unauthorized' : 'forbidden',
            });
            return;
          }
          try {
            await route.handler(req, res);
          } catch (error) {
            const status = error instanceof RequestBodyError ? error.status : 500;
            sendJson(res, status, { error: String(error && error.message ? error.message : error) });
          }
        },
      });
    },
  };
}

export { sendJson };
