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
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : 'Unknown startup error';
  console.error('Fatal initialization error:', message);
  process.exit(1);
});
