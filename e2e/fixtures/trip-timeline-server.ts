import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(here, "../..");
const rawPort = Number(process.env.PLAYWRIGHT_TRIP_FIXTURE_PORT ?? "4179");
const port = Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535 ? rawPort : 4179;

const contentTypes: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/fixture.js": "text/javascript; charset=utf-8",
  "/fixture.css": "text/css; charset=utf-8",
};

const csp = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'self'",
  "form-action 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

const fixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Trip timeline fixture</title>
    <link rel="stylesheet" href="/fixture.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="/fixture.js" defer></script>
  </body>
</html>`;

async function main() {
  const outputDir = await mkdtemp(join(tmpdir(), "jarvis-trip-timeline-fixture-"));

  await build({
  absWorkingDir: projectRoot,
  bundle: true,
  define: { "process.env.NODE_ENV": JSON.stringify("test") },
  entryNames: "fixture",
  entryPoints: { fixture: join(projectRoot, "e2e/fixtures/trip-timeline.browser.tsx") },
  format: "iife",
  jsx: "automatic",
  loader: { ".css": "css", ".svg": "dataurl" },
  logLevel: "warning",
  minify: false,
  outdir: outputDir,
  platform: "browser",
  sourcemap: false,
  target: ["es2020"],
  tsconfig: join(projectRoot, "tsconfig.json"),
  });

  const fixtureJsPath = join(outputDir, "fixture.js");
  const fixtureCssPath = join(outputDir, "fixture.css");
  await Promise.all([access(fixtureJsPath), access(fixtureCssPath)]);

  const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Security-Policy": csp });
    response.end();
    return;
  }

  if (!(pathname in contentTypes)) {
    response.writeHead(404, { "Content-Security-Policy": csp });
    response.end();
    return;
  }

  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", csp);
  response.setHeader("Content-Type", contentTypes[pathname]);
  if (method === "HEAD") {
    response.writeHead(200);
    response.end();
    return;
  }

  if (pathname === "/") {
    response.writeHead(200);
    response.end(fixtureHtml);
    return;
  }

  response.writeHead(200);
  response.end(await readFile(pathname === "/fixture.js" ? fixtureJsPath : fixtureCssPath));
  });

  const cleanup = async () => {
    await rm(outputDir, { force: true, recursive: true });
  };

  const shutdown = (exitCode: number) => {
    server.close(() => {
      void cleanup().finally(() => process.exit(exitCode));
    });
    setTimeout(() => process.exit(exitCode), 3_000).unref();
  };

  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));

  server.listen(port, "127.0.0.1", () => {
    console.log(`Trip timeline fixture listening on http://127.0.0.1:${port}`);
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
