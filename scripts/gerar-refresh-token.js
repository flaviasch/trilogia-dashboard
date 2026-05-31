/**
 * Script para gerar novo GOOGLE_REFRESH_TOKEN para o Drive API.
 * Execute: node gerar-refresh-token.js
 */
const https   = require('https');
const http    = require('http');
const url     = require('url');

// Obtenha em: console.cloud.google.com → APIs → Credenciais → trilogia-provisionar-web
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || 'SEU_CLIENT_ID_AQUI';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'SEU_CLIENT_SECRET_AQUI';
const REDIRECT_URI  = 'http://localhost:3000/callback';
const SCOPES        = 'https://www.googleapis.com/auth/drive.file';

const authUrl = `https://accounts.google.com/o/oauth2/auth?` +
  `client_id=${CLIENT_ID}&` +
  `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
  `response_type=code&` +
  `scope=${encodeURIComponent(SCOPES)}&` +
  `access_type=offline&` +
  `prompt=consent`;

console.log('\n=== GERADOR DE REFRESH TOKEN ===\n');
console.log('Abrindo servidor local na porta 3000...\n');
console.log('Abra este link no navegador (logada com flaviasch@gmail.com):\n');
console.log(authUrl);
console.log('\n');

// Servidor temporário para capturar o código
const server = http.createServer((req, res) => {
  const params = new url.URL(req.url, 'http://localhost:3000').searchParams;
  const code   = params.get('code');
  const error  = params.get('error');

  if (error) {
    res.end('<h2>Erro: ' + error + '</h2><p>Feche esta aba.</p>');
    server.close();
    console.error('Erro na autorização:', error);
    process.exit(1);
  }

  if (!code) {
    res.end('<p>Aguardando...</p>');
    return;
  }

  res.end('<h2 style="font-family:sans-serif;color:green">✅ Autorizado! Volte ao terminal.</h2><p>Pode fechar esta aba.</p>');
  server.close();

  // Troca o código pelo refresh token
  const postData = new URLSearchParams({
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    grant_type:    'authorization_code',
  }).toString();

  const reqToken = https.request({
    hostname: 'oauth2.googleapis.com',
    path:     '/token',
    method:   'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  }, (tokenRes) => {
    let body = '';
    tokenRes.on('data', (chunk) => body += chunk);
    tokenRes.on('end', () => {
      const data = JSON.parse(body);
      if (data.refresh_token) {
        console.log('\n✅ NOVO REFRESH TOKEN:\n');
        console.log(data.refresh_token);
        console.log('\n→ Cole este valor no Secret Manager → GOOGLE_REFRESH_TOKEN → Nova versão.\n');
      } else {
        console.error('\n❌ Erro ao obter token:', JSON.stringify(data, null, 2));
      }
      process.exit(0);
    });
  });

  reqToken.write(postData);
  reqToken.end();
});

server.listen(3000, () => {
  console.log('Servidor rodando em http://localhost:3000 — aguardando autorização...\n');
});
