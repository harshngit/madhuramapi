
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/routes/po.js');
const content = fs.readFileSync(filePath, 'utf8');

console.log('=== src/routes/po.js content (lines 89-200) ===');
const lines = content.split('\n');
for (let i = 88; i < 200; i++) {
  console.log(`${i+1}: |${lines[i]}|`);
}
