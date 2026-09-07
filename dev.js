// Local preview: node dev.js -> http://localhost:3000 (serves index.html + /api/pie).
const http = require('http'), fs = require('fs'), path = require('path');
const pie = require('./api/pie.js');

http.createServer((req, res) => {
  if (req.url.startsWith('/api/pie')) return pie(req, res);
  const file = req.url.split('?')[0] === '/' ? 'index.html' : path.basename(req.url.split('?')[0]);
  fs.readFile(path.join(__dirname, file), (err, body) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/plain' }).end(body);
  });
}).listen(3000, () => console.log('http://localhost:3000'));
