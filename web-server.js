const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9110;
const HTML_PATH = 'D:\\NetWork\\Integration\\ClassIntra\\Resources\\else\\index.html';

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  
  // Serve the HTML for all routes (SPA-style)
  if (url === '/' || url === '/index.html' || !path.extname(url)) {
    try {
      const html = fs.readFileSync(HTML_PATH, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end('Internal Server Error: ' + err.message);
    }
    return;
  }

  // Try to serve static files relative to the HTML file's directory
  const staticDir = path.dirname(HTML_PATH);
  const filePath = path.join(staticDir, url);
  
  // Prevent path traversal
  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.pdf': 'application/pdf',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } else {
      // Fallback to HTML for unknown paths
      const html = fs.readFileSync(HTML_PATH, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    }
  } catch (err) {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WebServer] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[WebServer] Serving: ${HTML_PATH}`);
});

server.on('error', (err) => {
  console.error(`[WebServer] Error: ${err.message}`);
  process.exit(1);
});
