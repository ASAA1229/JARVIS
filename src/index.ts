import { loadLocalEnvironmentFile, ownerEnrollmentStatusMessage, readRuntimeConfig } from './config/runtimeConfig.js';

async function main() {
  loadLocalEnvironmentFile();
  const config = readRuntimeConfig();
  const { JarvisServer } = await import('./server/server.js');
  const server = new JarvisServer(config.port, config.auditPath, config.deviceStatePath);

  if (config.ownerTokenStatus !== 'configured') {
    console.warn(`${ownerEnrollmentStatusMessage(config.ownerTokenStatus)} Run node scripts/configure-owner-token.mjs after copying .env.example to .env.`);
  }

  console.log('----------------------------------------------------');
  console.log('🤖 Starting JARVIS Secure Personal AI Assistant POC');
  console.log('----------------------------------------------------');
  console.log(`- Architecture: Modular Monolith`);
  console.log(`- Security: Default-Deny Policy Gateway & Tamper-Evident Audit`);
  console.log(`- Host: Windows 11 Home`);
  console.log(`- Companion Endpoint: http://127.0.0.1:${config.port}`);
  console.log('----------------------------------------------------');

  await server.start();
  console.log(`✅ JARVIS Core service is listening on http://127.0.0.1:${config.port}`);

  // Optional personal AI gateway for websites (OpenAI-compatible /v1 on its own port).
  const gatewayPort = process.env.JARVIS_SITE_GATEWAY_PORT;
  if (gatewayPort) {
    const port = Number(gatewayPort);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || port === config.port) {
      throw new Error('JARVIS_SITE_GATEWAY_PORT must be a free TCP port different from PORT');
    }
    const [{ SiteAiGateway }, { SiteClientStore }, { getModelEndpoint }] = await Promise.all([
      import('./gateway/siteAiGateway.js'),
      import('./gateway/siteClientStore.js'),
      import('./conversation/agentModelAdapter.js'),
    ]);
    const gateway = new SiteAiGateway({
      store: new SiteClientStore(process.env.JARVIS_SITE_CLIENTS_PATH || './data/site-clients.json'),
      audit: server.getService().audit,
      modelEndpoint: getModelEndpoint,
    });
    await gateway.start(port);
    console.log(`✅ JARVIS site AI gateway is listening on http://127.0.0.1:${port}/v1 (site keys: npm run site-key -- list)`);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : 'Unknown startup error';
  console.error('Fatal initialization error:', message);
  process.exit(1);
});
