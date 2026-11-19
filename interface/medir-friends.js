// Mede o Friends (opção C) e o painel de modos nos 4 idiomas (pt-BR, en, es, fr) no Chrome headless por CDP em 360, 768 e 1440 px: rolagem horizontal, alvos de toque < 44 px,
// elementos fora da janela e erro de script. Serve a raiz do repo numa porta livre de 127.0.0.1 (fora de :8770 o plugin TrackSave
// não existe, então a seção é forçada a aparecer) e força estados/textos longos para exercitar o layout. NÃO é portão do ./testar.sh (precisa de Chrome).
// Rodar: node interface/medir-friends.js [saida.png]  — a captura (opcional) é do 1440 px.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const RAIZ = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const tipos = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  const arq = path.join(RAIZ, path.normalize(decodeURIComponent(new URL(q.url, 'http://x').pathname)));
  if (!arq.startsWith(RAIZ + path.sep) || /\.(mp3|wav|aiff?)$/i.test(arq) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': tipos[path.extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(fs.readFileSync(arq));
});
const MEDIR = `(() => {
  const sai = [], pequeno = [];
  for (const e of document.querySelectorAll('button, a[href], input, label, summary, select')) {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    if (!r.width || !r.height || cs.visibility === 'hidden') continue;
    if (e.tagName === 'INPUT' && e.type === 'checkbox') { const l = e.closest('label'); if (l) continue; }
    if (e.tagName === 'LABEL' && e.querySelector('input') === null) continue;
    if (Math.min(r.width, r.height) < 44 - 0.5) pequeno.push(e.tagName + '#' + (e.id || e.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    if (r.right > innerWidth + 0.5 || r.left < -0.5) sai.push((e.id || e.className || e.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
  }
  const fundo = document.getElementById('fr-fundo');   // o fundo em mosaico (friends-fundo.js) só existe no Friends
  return { rolagem: document.documentElement.scrollWidth - innerWidth, sai, pequeno, fundo: fundo ? fundo.querySelectorAll('.fr-peca svg').length : -1 };
})()`;
(async () => {
  await new Promise((ok, no) => { srv.once('error', no); srv.listen(0, '127.0.0.1', ok); });
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'vbmx-medir-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + perfil, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let falhou = false;
  try {
    const dt = path.join(perfil, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !(fs.existsSync(dt) && fs.readFileSync(dt, 'utf8').includes('\n')); i++) await espera(100);
    const [p, cam] = fs.readFileSync(dt, 'utf8').trim().split('\n');
    const ws = new WebSocket(`ws://127.0.0.1:${p}${cam}`); await new Promise((ok) => { ws.onopen = ok; });
    let seq = 0; const pend = new Map(), erros = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') erros.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') erros.push('console.error ' + JSON.stringify(m.params.args.map((a) => a.value || a.description)).slice(0, 200)); };
    const env = (method, params, sessionId) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); });
    const { targetId } = await env('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await env('Target.attachToTarget', { targetId, flatten: true });
    const ev = async (x) => (await env('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
    await env('Page.enable', {}, sessionId); await env('Runtime.enable', {}, sessionId);
    await env('Page.navigate', { url: 'http://127.0.0.1:' + srv.address().port + '/interface/friends.html' }, sessionId);
    for (let i = 0; i < 100 && !(await ev('document.readyState === "complete" && typeof VbMxTrackSave === "object"')); i++) await espera(100);
    await espera(500);
    // estados: mostra os estados visuais forçando data-fase e o X, sem tocar áudio (o motor não é tocado)
    for (const lang of ['pt-BR', 'en', 'es', 'fr']) for (const fase of ['vazio', 'mixando']) {
      await ev(`VbMxI18n.definir(${JSON.stringify(lang)})`);   // a troca ao vivo: refaz o HTML marcado e o texto montado pelo script
      for (const [w, h] of [[360, 800], [768, 1000], [1440, 900]]) {
        await env('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
        await ev(`document.querySelector('.friends').dataset.fase = ${JSON.stringify(fase)}; document.getElementById('fr-aviso').hidden = false; document.getElementById('fr-aviso').textContent = 'aviso de erro de exemplo, bem longo, para medir a quebra de linha no celular sem estourar a coluna'; document.getElementById('fr-ts').hidden = false; document.getElementById('ts-form').hidden = false; document.getElementById('ts-capa-linha').hidden = false; document.getElementById('ts-capa-nota').hidden = false; document.getElementById('agora-capa').src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 4 4%22%3E%3Crect width=%224%22 height=%224%22 fill=%22white%22/%3E%3C/svg%3E'; document.getElementById('seguir-titulo').textContent = 'Uma faixa com um título bem comprido para testar a quebra — Artista Também Comprido'; document.getElementById('agora-titulo').textContent = 'Título Muito Comprido Para Medir A Quebra De Linha'; { const I = VbMxI18n; document.getElementById('seguir-quando').textContent = I.t('seguir.sync', { falta: '3:45', n: 16, s: 30, limite: I.t('seguir.limite', { n: 64 }) }); document.getElementById('fr-duracao-info').textContent = I.t('duracao.lim-sync', { base: I.t('duracao.base', { n: 64, s: 120, ref: '' }), n: 16, s: 30 }); document.getElementById('agora-sub').textContent = 'Artista · 128 BPM · 8A · pitch -0,5%'; document.getElementById('fr-fase').textContent = I.t('fase.mixando'); document.getElementById('ts-dica').hidden = false; document.getElementById('fr-ts').hidden = false; } for (const id of ['fr-biblioteca','fr-historico']) document.getElementById(id).innerHTML = '<li class="fr-tocando fr-marcada"><span class="fr-nome">Faixa muito comprida de teste <small>Artista</small></span><span class="mono fr-dado">124,0 · 8A</span><span class="fr-selo">' + VbMxI18n.t('biblioteca.tocando') + '</span></li><li><span class="fr-nome">Outra</span><span class="mono fr-dado">126 · 9A</span><button type="button" class="botao-pasta">' + VbMxI18n.t('biblioteca.a-seguir') + '</button></li>';`);
        await espera(150);
        const m = await ev(MEDIR);
        const ok = m.rolagem <= 0 && !m.sai.length && !m.pequeno.length && m.fundo === 4;   // com o fundo montado (4 peças) por cima do layout
        if (!ok) falhou = true;
        console.log(`${ok ? '✓' : '✗'} ${lang} ${fase} ${w}px: rolagem ${m.rolagem}${m.fundo === 4 ? '' : ' fundo: ' + m.fundo + ' peças'}${m.sai.length ? ' fora: ' + m.sai.join(', ') : ''}${m.pequeno.length ? ' < 44px: ' + m.pequeno.join(', ') : ''}`);
        if (process.argv[2] && w === 1440 && fase === 'mixando' && lang === 'pt-BR') { const s = await env('Page.captureScreenshot', { format: 'png' }, sessionId); fs.writeFileSync(process.argv[2], Buffer.from(s.data, 'base64')); }
        if (process.argv[2] && w === 360 && fase === 'mixando' && lang === 'pt-BR') { const s = await env('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId); fs.writeFileSync(process.argv[2].replace('.png', '-360.png'), Buffer.from(s.data, 'base64')); }
      }
    }
    // o painel de modos (index.html), nos 4 idiomas e 3 larguras
    await env('Page.navigate', { url: 'http://127.0.0.1:' + srv.address().port + '/interface/index.html?escolher' }, sessionId);
    for (let i = 0; i < 100 && !(await ev('document.readyState === "complete" && typeof VbMxModos === "object"')); i++) await espera(100);
    await espera(300);
    for (const lang of ['pt-BR', 'en', 'es', 'fr']) {
      await ev(`VbMxI18n.definir(${JSON.stringify(lang)})`);
      for (const [w, h] of [[360, 800], [768, 1000], [1440, 900]]) {
        await env('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
        await espera(100);
        const m = await ev(MEDIR), lg = await ev('document.documentElement.lang');
        const ok = m.rolagem <= 0 && !m.sai.length && !m.pequeno.length && lg === lang;
        if (!ok) falhou = true;
        console.log(`${ok ? '✓' : '✗'} painel ${lang} ${w}px: rolagem ${m.rolagem}${m.sai.length ? ' fora: ' + m.sai.join(', ') : ''}${m.pequeno.length ? ' < 44px: ' + m.pequeno.join(', ') : ''}${lg === lang ? '' : ' lang=' + lg}`);
      }
    }
    const reais = erros.filter((e) => !/fonts\.g|net::ERR|Failed to load resource/.test(e));
    if (reais.length) { falhou = true; console.log('✗ erros de script: ' + reais.slice(0, 3).join(' ‖ ')); } else console.log('✓ nenhum erro de script');
  } catch (e) { falhou = true; console.error(e); }
  finally { chrome.kill('SIGKILL'); srv.close(); await espera(300); try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) {} process.exit(falhou ? 1 : 0); }
})();
