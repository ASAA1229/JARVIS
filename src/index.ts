import { JarvisServer } from './server/server.js';

async function main() {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const STATE_PATH = process.env.JARVIS_DEVICE_STATE_PATH || './data/devices.json';
  const AUDIT_PATH = process.env.JARVIS_AUDIT_PATH || './data/audit.log';
  const server = new JarvisServer(PORT, AUDIT_PATH, STATE_PATH);

  console.log('----------------------------------------------------');
  console.log('🤖 Starting JARVIS Secure Personal AI Assistant POC');
  console.log('----------------------------------------------------');
  console.log(`- Architecture: Modular Monolith`);
  console.log(`- Security: Default-Deny Policy Gateway & Tamper-Evident Audit`);
  console.log(`- Host: Windows 11 Home`);
  console.log(`- Companion Endpoint: http://127.0.0.1:${PORT}`);
  console.log('----------------------------------------------------');

  await server.start();
  console.log(`✅ JARVIS Core service is listening on http://127.0.0.1:${PORT}`);
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
