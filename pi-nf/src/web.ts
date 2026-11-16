import { createServer, type Server } from "node:http";
import { Host } from "./host.js";

export type WebServerOptions = {
  db_path: string;
  port?: number;
  host?: string;
};

export type RunningWebServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

function html(status: unknown): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>pi-nf</title><style>body{font:14px ui-monospace,monospace;margin:2rem;background:#111;color:#eee}pre{white-space:pre-wrap}</style></head><body><h1>pi-nf</h1><pre>${JSON.stringify(status, null, 2).replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre></body></html>`;
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/api/status") {
        const status = await Host.status(options.db_path);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(status));
        return;
      }
      if (request.url === "/" || request.url === "/index.html") {
        const status = await Host.status(options.db_path);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html(status));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    url: `http://${host}:${port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
