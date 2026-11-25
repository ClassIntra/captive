/**
 * Hotspot HTTPS Redirect Service
 *
 * Features:
 *   1. DNS server (UDP 53) — intercepts spark.changyan.com -> hotspot host IP
 *   2. HTTPS reverse proxy (TCP 443) — TLS termination -> localhost:9110
 *
 * Requires Administrator privileges (bind ports 53 and 443)
 */

'use strict';

const dgram = require('dgram');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ============================================================
// Config
// ============================================================
const CONFIG = {
  // 支持多个域名拦截
  interceptDomains: ['spark.changyan.com', 'ai.changyan.com', 'www.wjx.cn'],
  hotspotIP: '192.168.137.1',
  dnsPort: 53,
  httpsPort: 443,
  upstreamDNS: '223.5.5.5',
  targetHost: 'localhost',
  targetPort: 9110,
  certDir: path.join(__dirname, 'certs'),
};

const CERT_PATH = path.join(CONFIG.certDir, 'cert.pem');
const KEY_PATH = path.join(CONFIG.certDir, 'key.pem');

// ============================================================
// DNS packet utilities
// ============================================================

/**
 * Parse domain name from DNS query packet
 */
function parseDNSName(buf, offset) {
  const labels = [];
  let jumped = false;
  let jumpOffset = offset;
  let pos = offset;

  while (buf[pos] !== 0) {
    // Check for compression pointer
    if ((buf[pos] & 0xC0) === 0xC0) {
      const pointer = ((buf[pos] & 0x3F) << 8) | buf[pos + 1];
      if (!jumped) {
        jumpOffset = pos + 2;
      }
      pos = pointer;
      jumped = true;
    } else {
      const len = buf[pos];
      labels.push(buf.toString('utf8', pos + 1, pos + 1 + len).toLowerCase());
      pos += len + 1;
    }
  }

  if (!jumped) {
    jumpOffset = pos + 1;
  }

  return { name: labels.join('.'), offset: jumpOffset };
}

/**
 * Build DNS A-record response packet
 */
function buildDNSResponse(requestBuf, ipAddress) {
  const response = Buffer.alloc(requestBuf.length + 16);

  requestBuf.copy(response, 0, 0, requestBuf.length);

  // Flags: QR=1(response), OPCODE=0, AA=0, TC=0, RD=1
  response[2] = 0x81;
  response[3] = 0x80; // RA=1, Z=0, RCODE=0(no error)

  // Answer count = 1
  response[6] = 0x00;
  response[7] = 0x01;

  // Find end of question section
  const { offset: questionEnd } = parseDNSName(requestBuf, 12);
  const answerOffset = questionEnd + 4; // skip QTYPE(2) + QCLASS(2)

  // Build answer section
  let pos = answerOffset;
  // Name pointer to question domain (offset 12)
  response[pos++] = 0xC0;
  response[pos++] = 0x0C;

  // TYPE: A = 0x0001
  response[pos++] = 0x00;
  response[pos++] = 0x01;

  // CLASS: IN = 0x0001
  response[pos++] = 0x00;
  response[pos++] = 0x01;

  // TTL: 300 seconds
  response[pos++] = 0x00;
  response[pos++] = 0x00;
  response[pos++] = 0x01;
  response[pos++] = 0x2C;

  // RDLENGTH: 4
  response[pos++] = 0x00;
  response[pos++] = 0x04;

  // RDATA: IP address
  const octets = ipAddress.split('.').map(Number);
  response[pos++] = octets[0];
  response[pos++] = octets[1];
  response[pos++] = octets[2];
  response[pos++] = octets[3];

  return response.slice(0, pos);
}

// ============================================================
// DNS Server
// ============================================================

function createDNSServer() {
  const server = dgram.createSocket('udp4');
  const upstreamAddr = CONFIG.upstreamDNS;
  const upstreamPort = 53;

  server.on('error', (err) => {
    console.error(`[DNS] Server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error('[DNS] Port 53 is in use. Run as Administrator first.');
    }
  });

  server.on('message', async (msg, rinfo) => {
    try {
      const { name } = parseDNSName(msg, 12);

      // 检查是否需要拦截
      const shouldIntercept = CONFIG.interceptDomains.some(domain =>
        name === domain || name.endsWith('.' + domain)
      );

      if (shouldIntercept) {
        // Intercepted - return hotspot IP
        const response = buildDNSResponse(msg, CONFIG.hotspotIP);
        server.send(response, rinfo.port, rinfo.address, (err) => {
          if (!err) {
            console.log(`[DNS] HIT  ${name} -> ${CONFIG.hotspotIP}  (from ${rinfo.address})`);
          }
        });
      } else {
        // Forward to upstream DNS
        const upstreamSocket = dgram.createSocket('udp4');
        const timeout = setTimeout(() => {
          upstreamSocket.close();
        }, 5000);

        upstreamSocket.on('message', (upMsg) => {
          clearTimeout(timeout);
          server.send(upMsg, rinfo.port, rinfo.address, (err) => {
            if (err) console.error(`[DNS] Forward response failed: ${err.message}`);
          });
          upstreamSocket.close();
        });

        upstreamSocket.on('error', (err) => {
          clearTimeout(timeout);
          upstreamSocket.close();
          console.error(`[DNS] Upstream error: ${err.message}`);
        });

        upstreamSocket.send(msg, upstreamPort, upstreamAddr, (err) => {
          if (err) {
            clearTimeout(timeout);
            upstreamSocket.close();
            console.error(`[DNS] Forward failed: ${err.message}`);
          }
        });
      }
    } catch (err) {
      // Ignore unparseable packets
    }
  });

  server.on('listening', () => {
    const addr = server.address();
    console.log(`[DNS] Listening on ${addr.address}:${addr.port}`);
    console.log(`[DNS] Intercept rules:`);
    CONFIG.interceptDomains.forEach(domain => {
      console.log(`[DNS]   *.${domain} -> ${CONFIG.hotspotIP}`);
    });
    console.log(`[DNS] Upstream: ${CONFIG.upstreamDNS}`);
  });

  return server;
}

// ============================================================
// HTTPS Reverse Proxy
// ============================================================

// 全屏 iframe 跳转子域：阅读器页面（https）用 iframe 打开跳转目标时，
// http 目标直接嵌会被浏览器当混合内容拦掉，于是统一改写成
//   https://t<端口>-<主机名里的点换成两个减号>.spark.changyan.com
// 例：http://192-168-40-90.nip.io:9001/x
//   → https://t9001-192-168-40-90--nip--io.spark.changyan.com/x
// 本服务按 SNI 解析回 http://<主机>:<端口> 反代，并剥掉目标站的
// X-Frame-Options / CSP frame-ancestors，iframe 才能全屏嵌入。
// （与 index.html 里的 jumpFrameUrl() 约定一致，改动需两边同步）
const JUMP_HOST_RE = /^t(\d{1,5})-([a-z0-9-]+)\.spark\.changyan\.com$/i;

function parseJumpServername(servername) {
  const m = JUMP_HOST_RE.exec(servername || '');
  if (!m) return null;
  const port = parseInt(m[1], 10);
  if (port < 1 || port > 65535) return null;
  // 标签里的两个减号是编码后的点（原主机名含 "--" 的情况阅读器侧已拒绝编码）
  let host = m[2].toLowerCase().replace(/--/g, '.');
  // nip.io 的 IP 型域名（点是原样、IP 段内是减号）本地直接换算，断外网也能反代
  const nip = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.nip\.io$/.exec(host);
  if (nip) host = nip[1] + '.' + nip[2] + '.' + nip[3] + '.' + nip[4];
  return { host: host, port: port };
}

// 跳转目标嵌进 https iframe 后，页面里注入的 window.__WS_PORT__="10001" 会让
// WebSocket 走 wss://…:10001 —— 10001 是明文端口，TLS 握手必失败。这里把注入值
// 改写成 443，让 WS 也走本代理的 443 升级通道（配合 upgrade 里的端口回退）。
// 只动 HTML、且页面确实注入了该变量时才改写，其它响应原样通过。
function rewriteJumpHtml(raw, headers) {
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  let text;
  if (enc === 'gzip' || enc === 'x-gzip') text = zlib.gunzipSync(raw).toString('utf8');
  else if (enc === 'deflate') text = zlib.inflateSync(raw).toString('utf8');
  else if (enc === 'br') text = zlib.brotliDecompressSync(raw).toString('utf8');
  else text = raw.toString('utf8');

  if (text.indexOf('window.__WS_PORT__=') < 0) return { body: raw, headers: headers };

  const body = Buffer.from(
    text.replace(/window\.__WS_PORT__="\d+"/g, 'window.__WS_PORT__="443"'),
    'utf8'
  );
  delete headers['content-encoding'];          // 改写后统一按明文发
  delete headers['transfer-encoding'];
  headers['content-length'] = String(body.length);
  return { body: body, headers: headers };
}

function createHTTPSProxy() {
  let tlsOptions;
  try {
    tlsOptions = {
      cert: fs.readFileSync(CERT_PATH),
      key: fs.readFileSync(KEY_PATH),
    };
    console.log(`[TLS] Certificate loaded: ${CERT_PATH}`);
  } catch (err) {
    console.error(`[TLS] Failed to load certificate: ${err.message}`);
    console.error('[TLS] Run cert generation first.');
    process.exit(1);
  }

  const proxy = https.createServer(tlsOptions, (clientReq, clientRes) => {
    // SNI 决定上游：t<端口>-<主机> 子域 → 原跳转目标；其余 → 阅读器后端
    const jump = parseJumpServername(clientReq.socket.servername);
    const options = {
      hostname: jump ? jump.host : CONFIG.targetHost,
      port: jump ? jump.port : CONFIG.targetPort,
      path: clientReq.url,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        'X-Forwarded-For': clientReq.socket.remoteAddress,
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': clientReq.headers.host || CONFIG.targetDomain,
      },
    };

    console.log(
      `[HTTPS] ${clientReq.method} ${clientReq.url}  (from ${clientReq.socket.remoteAddress})` +
        (jump ? `  [jump -> http://${jump.host}:${jump.port}]` : '')
    );

    // Track if we've already sent a response to prevent double-send
    let responded = false;
    const respond = (statusCode, body) => {
      if (responded) return;
      responded = true;
      if (!clientRes.headersSent) {
        clientRes.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      clientRes.end(body);
    };

    const proxyReq = http.request(options, (proxyRes) => {
      const jumpHtml =
        jump &&
        proxyRes.statusCode === 200 &&
        /text\/html/i.test(String(proxyRes.headers['content-type'] || ''));

      if (jumpHtml) {
        // 跳转 HTML 先缓冲：剥防嵌入头 + 改写 WS 端口，再一次发出
        const chunks = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('error', (err) => {
          console.error(`[HTTPS] Response stream error: ${err.message}`);
          clientRes.destroy();
        });
        proxyRes.on('end', () => {
          if (responded) return;
          responded = true;
          try {
            const headers = { ...proxyRes.headers };
            // 跳转目标是嵌进 iframe 的：防嵌入响应头剥掉，否则 SAMEORIGIN 会拦白屏
            delete headers['x-frame-options'];
            delete headers['content-security-policy'];
            delete headers['content-security-policy-report-only'];
            const { body, headers: outHeaders } = rewriteJumpHtml(Buffer.concat(chunks), headers);
            clientRes.writeHead(proxyRes.statusCode, outHeaders);
            clientRes.end(body);
          } catch (err) {
            console.error(`[HTTPS] Jump HTML rewrite failed: ${err.message}`);
            if (!clientRes.headersSent) clientRes.writeHead(500);
            clientRes.end();
          }
        });
        return;
      }

      // Forward response status and headers
      if (!responded) {
        responded = true;
        const headers = { ...proxyRes.headers };
        if (jump) {
          // 跳转目标是嵌进 iframe 的：防嵌入响应头剥掉，否则 SAMEORIGIN 会拦白屏
          delete headers['x-frame-options'];
          delete headers['content-security-policy'];
          delete headers['content-security-policy-report-only'];
        }
        clientRes.writeHead(proxyRes.statusCode, headers);
      }
      // Pipe response body, with error handling
      proxyRes.on('error', (err) => {
        console.error(`[HTTPS] Response stream error: ${err.message}`);
        clientRes.destroy();
      });
      proxyRes.pipe(clientRes);
    });

    // Handle proxy request errors (ECONNREFUSED, ECONNRESET, etc.)
    proxyReq.on('error', (err) => {
      console.error(`[HTTPS] Backend unreachable: ${err.message}`);
      respond(502, `Backend service unavailable: ${err.message}`);
    });

    // Handle client errors (disconnect, timeout, etc.)
    clientReq.on('error', (err) => {
      console.error(`[HTTPS] Client request error: ${err.message}`);
      proxyReq.destroy();
    });

    clientRes.on('error', (err) => {
      console.error(`[HTTPS] Client response error: ${err.message}`);
      proxyReq.destroy();
    });

    // Pipe client request body to backend
    clientReq.pipe(proxyReq);
  });

  // WebSocket upgrade support
  proxy.on('upgrade', (clientReq, clientSocket, head) => {
    const jump = parseJumpServername(clientReq.socket.servername);
    // 跳转目标的 WebSocket 常在「HTTP 端口 +1000」（ClassIntra：9001 → 10001）。
    // 页面里注入的 __WS_PORT__ 已被改写成 443，升级请求因此落到本端口：
    // 先按原端口试，被拒再回退 +1000；阅读器路由只用配置端口。
    const ports = jump
      ? [jump.port, jump.port + 1000].filter((p, i, a) => p <= 65535 && a.indexOf(p) === i)
      : [CONFIG.targetPort];

    console.log(
      `[HTTPS] WS upgrade ${clientReq.url}` +
        (jump ? `  [jump -> http://${jump.host}:${ports.join(' or ')}]` : '')
    );

    let currentReq = null;
    clientSocket.on('error', (err) => {
      console.error(`[HTTPS] WS client socket error: ${err.message}`);
      if (currentReq) currentReq.destroy();
    });

    const tryUpgrade = (idx) => {
      const options = {
        hostname: jump ? jump.host : CONFIG.targetHost,
        port: ports[idx],
        path: clientReq.url,
        method: clientReq.method,
        headers: {
          ...clientReq.headers,
          'X-Forwarded-For': clientReq.socket.remoteAddress,
          'X-Forwarded-Proto': 'https',
        },
      };

      const proxyReq = http.request(options);
      currentReq = proxyReq;

      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        // Handle WebSocket stream errors (most likely during backend restart)
        clientSocket.on('error', (err) => {
          console.error(`[HTTPS] WS client error: ${err.message}`);
          proxySocket.destroy();
        });
        proxySocket.on('error', (err) => {
          console.error(`[HTTPS] WS backend error: ${err.message}`);
          clientSocket.destroy();
        });

        clientSocket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
            Object.keys(proxyRes.headers)
              .map((k) => `${k}: ${proxyRes.headers[k]}`)
              .join('\r\n') +
            '\r\n\r\n'
        );
        clientSocket.pipe(proxySocket).pipe(clientSocket);
      });

      // 上游不接受升级、回了普通响应：还有备选端口就换一个，否则原样转给客户端
      proxyReq.on('response', (res) => {
        if (idx + 1 < ports.length) {
          console.log(`[HTTPS] WS port ${ports[idx]} answered ${res.statusCode}, trying ${ports[idx + 1]}`);
          res.resume();
          tryUpgrade(idx + 1);
          return;
        }
        const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage || ''}`.trim()];
        for (const k of Object.keys(res.headers)) lines.push(`${k}: ${res.headers[k]}`);
        clientSocket.write(lines.join('\r\n') + '\r\n\r\n');
        res.pipe(clientSocket);
      });

      proxyReq.on('error', (err) => {
        if (idx + 1 < ports.length) {
          console.log(`[HTTPS] WS port ${ports[idx]} refused (${err.message}), trying ${ports[idx + 1]}`);
          tryUpgrade(idx + 1);
          return;
        }
        console.error(`[HTTPS] WS proxy error: ${err.message}`);
        clientSocket.end();
      });

      proxyReq.end();
    };

    tryUpgrade(0);
  });

  proxy.on('listening', () => {
    const addr = proxy.address();
    console.log(`[HTTPS] Listening on ${addr.address}:${addr.port}`);
    console.log(`[HTTPS] Target: http://${CONFIG.targetHost}:${CONFIG.targetPort}`);
  });

  return proxy;
}

// ============================================================
// Main
// ============================================================

function main() {
  console.log('');
  console.log('================================================');
  console.log('  Hotspot HTTPS Redirect Service');
  console.log('  Intercept domains:');
  CONFIG.interceptDomains.forEach(domain => {
    console.log(`    - https://${domain}`);
  });
  console.log(`  Target: localhost:${CONFIG.targetPort}`);
  console.log('================================================');
  console.log('');

  const dnsServer = createDNSServer();
  dnsServer.bind(CONFIG.dnsPort, '0.0.0.0', () => {
    console.log(`[DNS] Bound 0.0.0.0:${CONFIG.dnsPort}`);
  });

  const httpsProxy = createHTTPSProxy();
  httpsProxy.listen(CONFIG.httpsPort, '0.0.0.0', () => {
    console.log(`[HTTPS] Bound 0.0.0.0:${CONFIG.httpsPort}`);
  });

  console.log('');
  console.log('------------------------------------------------');
  console.log('  Service running. Press Ctrl+C to stop.');
  console.log('------------------------------------------------');
  console.log('');
  console.log('  Client steps:');
  console.log('  1. Connect to this PC hotspot');
  console.log('  2. Visit intercepted domains:');
  CONFIG.interceptDomains.forEach(domain => {
    console.log(`     https://${domain}`);
  });
  console.log('  3. Accept the self-signed certificate warning');
  console.log('');
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

// Global error handling — network errors should never crash the process
process.on('uncaughtException', (err) => {
  console.error(`[ERROR] Uncaught: ${err.message}`);
  console.error(err.stack);
  if (err.code === 'EACCES') {
    console.error('Insufficient privileges! Run as Administrator.');
    process.exit(1);
  }
  if (err.code === 'EADDRINUSE') {
    console.error('Port already in use! Close the conflicting program first.');
    console.error(`Run: netstat -ano | findstr :${err.port || 'PORT'}`);
    process.exit(1);
  }
  // All other errors (ECONNRESET, EPIPE, etc.) are non-fatal — keep running
  console.error('[ERROR] Non-fatal error, service continues running.');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled rejection:', reason);
  // Non-fatal — keep running
});

main();
