const fs = require('node:fs');
fs.copyFileSync('src/deployment/agent.py', 'build/deployment/agent.py');
