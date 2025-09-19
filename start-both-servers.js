const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting both 1vs1 and 2vs2 servers...');

// Start 1vs1 server (port 3001)
const server1vs1 = spawn('node', ['socket-server.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, PORT: '3001' }
});

// Start 2vs2 server (port 3002)
const server2vs2 = spawn('node', ['socket-server-2vs2.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, PORT_2VS2: '3002' }
});

// Handle server exits
server1vs1.on('close', (code) => {
  console.log(`❌ 1vs1 server exited with code ${code}`);
  if (code !== 0) {
    process.exit(1);
  }
});

server2vs2.on('close', (code) => {
  console.log(`❌ 2vs2 server exited with code ${code}`);
  if (code !== 0) {
    process.exit(1);
  }
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down servers...');
  server1vs1.kill('SIGINT');
  server2vs2.kill('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down servers...');
  server1vs1.kill('SIGTERM');
  server2vs2.kill('SIGTERM');
  process.exit(0);
});

console.log('✅ Both servers started successfully!');
console.log('📡 1vs1 server running on port 3001');
console.log('📡 2vs2 server running on port 3002');
console.log('Press Ctrl+C to stop both servers');
