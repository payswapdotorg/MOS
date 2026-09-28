/**
 * API entrypoint: config → composition root → migrations → HTTP server.
 * Explicit config, graceful shutdown (SIGTERM/SIGINT).
 *
 * MKT-002: bootstraps the full application (platform services + identity
 * modules incl. the optional configured platform administrator).
 */

import { bootstrapApplication } from '../composition-root.ts';
import { buildApiRouter } from '../api/routes.ts';
import { createHttpServer } from '../platform/http/server.ts';
import { toAppError } from '../platform/errors/errors.ts';

async function main(): Promise<void> {
  const { services, modules } = await bootstrapApplication();
  const logger = services.observability.loggerFactory.forModule('platform.http');

  const router = buildApiRouter(services, modules);
  const server = createHttpServer({
    router,
    logger,
    clock: services.clock,
    ids: services.ids,
    maxBodyBytes: services.config.httpMaxBodyBytes,
  });

  const handle = await server.listen(services.config.httpHost, services.config.httpPort);

  const shutdown = async (signal: string) => {
    logger.info('api.stopping', undefined, { signal });
    await handle.close();
    await services.db.close();
    process.exit(0);
  };
  // Register the graceful-shutdown handlers BEFORE the api.started line is
  // emitted: a SIGTERM that arrives while a watcher races on the started
  // line must never hit the default signal disposition (the LAB-001
  // delivery's added startup work made this start-to-registration window
  // deterministically hittable — the signal landed between the log write
  // and the handler registration and the control plane died by raw signal).
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('api.started', undefined, {
    host: services.config.httpHost,
    port: handle.port,
    env: services.config.env,
  });
}

main().catch((error: unknown) => {
  const appError = toAppError(error);
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      event: 'api.startup.failed',
      code: appError.code,
      message: appError.message,
      details: appError.details,
    })}\n`,
  );
  process.exit(1);
});
