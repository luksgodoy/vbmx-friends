// Prova no Chrome headless (CDP) do Friends: forma de onda e plugin TrackSave. NÃO é portão do ./testar.sh
// (precisa de Chrome); o portão em Node é interface/testar-friends-tracksave.js.
//
// A página é aberta em http://127.0.0.1:8770 (a Origin que o contrato exige) SEM usar a rede: todo pedido é
// interceptado pelo CDP (Fetch.requestPaused). Os de 127.0.0.1:8770 são servidos do disco, os de 127.0.0.1:8771
// por um TrackSave FALSO daqui (nada é baixado do YouTube e os servidores reais nessas portas não são tocados).
// O Essentia (CDN, dentro de um Worker) é trocado por um Worker falso que devolve 124 BPM / Lá menor; a
// decodificação do áudio, a grade, o cache, a biblioteca, o automix e o canvas são os de verdade.
//
// Prova: 1. servidor no ar → o campo aparece; 2. dois links → duas faixas na biblioteca (progresso na tela);
// 3. tocar → a onda aparece, a cabeça anda, a marca da transição está onde o plano diz, e a mixagem pinta o
// trecho; 4. 360, 768 e 1440 px sem rolagem horizontal; 5. erros (link inválido, download que falha, servidor
// fora → dica com o comando → "tente de novo"); 6. fora de localhost o plugin não existe e nada é pedido;
// 7. o link só sai no corpo do POST /baixar; 3a. capa ao fundo (cadeia, opacidade, interruptor, Pages sem pedido); 8. as três páginas sem erro de script.
// Rodar: node interface/provar-friends-chrome.js
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const RAIZ = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const LOCAL = 'http://127.0.0.1:8770', TS = 'http://127.0.0.1:8771', PAGES = 'http://vbmx-publicado.test';
const PUB = 'https://luksgodoy.github.io';   // o Friends publicado de verdade (6b): servido do disco pelo CDP, sem rede

function wavSintetico(seg, taxa) {          // bumbo a 124 BPM sobre um zumbido baixo
  const n = seg * taxa, dados = Buffer.alloc(44 + n * 2), P = taxa * 60 / 124;
  dados.write('RIFF', 0); dados.writeUInt32LE(36 + n * 2, 4); dados.write('WAVEfmt ', 8); dados.writeUInt32LE(16, 16);
  dados.writeUInt16LE(1, 20); dados.writeUInt16LE(1, 22); dados.writeUInt32LE(taxa, 24); dados.writeUInt32LE(taxa * 2, 28);
  dados.writeUInt16LE(2, 32); dados.writeUInt16LE(16, 34); dados.write('data', 36); dados.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const f = (i % P) / taxa, v = 0.8 * Math.exp(-f * 18) * Math.sin(2 * Math.PI * 55 * f) + 0.05 * Math.sin(2 * Math.PI * 440 * i / taxa);
    dados.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return dados;
}
function cdp(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pend = new Map(), ouvintes = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.falha(new Error(JSON.stringify(m.error))) : p.ok(m.result); }
    else if (m.method) for (const f of ouvintes) f(m);
  };
  const pronto = new Promise((ok, falha) => { ws.onopen = ok; ws.onerror = falha; });
  const enviar = (method, params, sessionId) => new Promise((ok, falha) => { const id = ++seq; pend.set(id, { ok, falha }); ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); });
  return { pronto, enviar, aoEvento: (f) => ouvintes.push(f), fechar: () => ws.close() };
}
async function esperarArquivo(arq, ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (fs.existsSync(arq)) { const t = fs.readFileSync(arq, 'utf8'); if (t.includes('\n')) return t; } await espera(100); }
  throw new Error('o Chrome não abriu a porta de depuração');
}

// Worker falso no lugar do Essentia: mesma mensagem de saída do worker de biblioteca/painel.js.
const WORKER_FALSO = `window.Worker = class {
  constructor() { this.onmessage = null; }
  postMessage(m) {
    const ticks = []; for (let t = 0; t < m.pcm.length / 44100; t += 60 / 124) ticks.push(t);
    setTimeout(() => this.onmessage && this.onmessage({ data: { id: m.id, candidatos: [{ nome: 'multifeature', bpm: 124, ticks }, { nome: 'degara', bpm: 124, ticks }, { nome: 'percival', bpm: 124 }], graves: null, fluxo: null, nota: 'A', escala: 'minor', forca: 0.9 } }), 20);
  }
  terminate() {}
};`;
// cores do canvas (CORES_ONDA de modos/friends-tela.js, paleta noturna da opção C) contadas em pixels
const PIXELS = `(() => {
  const cv = document.getElementById('agora-onda'), d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let tocado = 0, resto = 0, mix = 0, cabeca = 0, xMix = -1, xCabeca = -1;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3], x = (i / 4) % cv.width;
    const perto = (R, G, B) => Math.abs(r - R) <= 4 && Math.abs(g - G) <= 4 && Math.abs(b - B) <= 4;
    if (a >= 100 && a < 250 && perto(110, 155, 230)) tocado++;   // traços translúcidos (alpha ~.6)
    else if (a >= 90 && a < 250 && perto(125, 120, 105)) resto++;   // (alpha ~.5)
    if (a < 250) continue;
    if (r === 242 && g === 185 && b === 15) { mix++; if (xMix < 0) xMix = x; }
    else if (r === 242 && g === 235 && b === 221) { cabeca++; if (xCabeca < 0) xCabeca = x; }
  }
  return { w: cv.width, h: cv.height, cw: cv.clientWidth, ch: cv.clientHeight, dpr: devicePixelRatio, estado: cv.dataset.estado, tocado, resto, mix, cabeca, xMix, xCabeca };
})()`;
const TELA = `(() => {
  const v = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.getClientRects().length > 0; };
  return { secao: v('fr-ts'), campo: v('ts-form'), dica: v('ts-dica'), status: document.getElementById('ts-status').textContent, erro: document.getElementById('ts-status').classList.contains('fr-ts-erro'),
    dicaTexto: document.getElementById('ts-dica').textContent.replace(/\\s+/g, ' '), ocupado: document.getElementById('ts-baixar').disabled, link: document.getElementById('ts-link').value,
    biblioteca: [...document.querySelectorAll('#fr-biblioteca li')].map((li) => li.textContent.replace(/\\s+/g, ' ')), pastas: document.getElementById('pastas').textContent.replace(/\\s+/g, ' ').slice(0, 200) };
})()`;

(async () => {
  const wav = wavSintetico(60, 22050);
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'vbmx-friends-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + perfil, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--lang=pt-BR', 'about:blank'], { stdio: 'ignore' });
  let c = null;
  const falhas = [], erros = [];
  let feitas = 0;
  const ok = (cond, texto) => { feitas += 1; if (!cond) falhas.push(texto); };

  // ---- o TrackSave falso e o registro de tudo que a página pediu ----
  const ts = { noAr: true, capas: [], pedidos: [], corpos: [], origens: new Set(), status: {} };
  const outros = [];   // pedidos a qualquer host que não seja a página nem o TrackSave
  const IDS = { 'aaaaaaaaaaa': '00000000000000a1', 'bbbbbbbbbbb': '00000000000000b2', 'falhadownld': '00000000000000ff' };
  const NOMES = { '00000000000000a1': ['Primeira do Link', 'Canal Um'], '00000000000000b2': ['Segunda do Link', 'Canal Dois'] };
  const tipos = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
  const b64 = (x) => Buffer.from(x).toString('base64');
  function responderTrackSave(req) {
    const u = new URL(req.url), cab = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const cors = [{ name: 'Access-Control-Allow-Origin', value: cab.origin === PUB ? PUB : LOCAL }, { name: 'Access-Control-Allow-Headers', value: 'Content-Type' }, { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' }, { name: 'Access-Control-Allow-Private-Network', value: 'true' }];
    const json = (st, o) => ({ responseCode: st, responseHeaders: cors.concat([{ name: 'Content-Type', value: 'application/json' }]), body: b64(JSON.stringify(o)) });
    if (req.method === 'OPTIONS') return { responseCode: 204, responseHeaders: cors };
    ts.pedidos.push(req.method + ' ' + u.pathname + u.search); ts.origens.add(cab.origin || '(sem Origin)');
    if (cab.origin !== LOCAL && cab.origin !== PUB) return json(403, { erro: { codigo: 'origem-invalida', mensagem: 'origem não permitida' } });
    if (u.pathname === '/saude') return json(200, { servico: 'tracksave', versao: 1, yt_dlp: 'falso', ffmpeg: true });
    if (u.pathname === '/baixar' && req.method === 'POST') {
      ts.corpos.push(req.postData || '');
      let url = ''; try { url = JSON.parse(req.postData).url; } catch (e) { return json(400, { erro: { codigo: 'corpo-invalido', mensagem: 'JSON inválido' } }); }
      const id = IDS[Object.keys(IDS).find((k) => String(url).includes(k))];
      if (!id) return json(400, { erro: { codigo: 'link-invalido', mensagem: 'link não reconhecido' } });
      ts.status[id] = 0;
      return json(202, { id, tipo: 'faixa', estado: 'na-fila' });
    }
    if (u.pathname === '/capa' && req.method === 'GET') {   // capa falsa: um PNG 1×1 (o mesmo para miniatura e pesquisa; o que muda é o pedido)
      ts.capas.push(u.search);
      if (u.searchParams.get('titulo') === 'Sem Capa Nenhuma' || u.searchParams.get('id') === 'zzzzzzzzzzz') return json(404, { erro: { codigo: 'capa-nao-encontrada', mensagem: 'sem capa' } });
      return { responseCode: 200, responseHeaders: cors.concat([{ name: 'Content-Type', value: 'image/png' }]), body: PNG_1X1 };
    }
    const m = /^\/(status|faixa|audio)\/([0-9a-f]{16})$/.exec(u.pathname);
    if (!m) return json(404, { erro: { codigo: 'nao-encontrado', mensagem: 'rota desconhecida' } });
    const [, rota, id] = m;
    if (rota === 'status') {
      const k = ++ts.status[id];
      if (id === IDS.falhadownld) return json(200, k < 2 ? { estado: 'baixando', fracao: 0.2, mensagem: 'baixando' } : { estado: 'falhou', erro: { codigo: 'download-falhou', mensagem: 'o vídeo não está disponível' } });
      return json(200, k < 2 ? { estado: 'baixando', fracao: 0.4, mensagem: 'baixando 40%' } : { estado: 'pronto', fracao: 1, mensagem: 'pronto' });
    }
    if (rota === 'faixa') return json(200, { id, titulo: NOMES[id][0], artista: NOMES[id][1], ano: 2025, origem: id === '00000000000000b2' ? { tipo: 'youtube', youtube_url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' } : { tipo: 'youtube', youtube_url: null }, arquivo: { nome: NOMES[id][0] + '.wav', bytes: wav.length, modificado_ms: 1700000000000 } });
    return { responseCode: 200, responseHeaders: cors.concat([{ name: 'Content-Type', value: 'audio/wav' }]), body: wav.toString('base64') };
  }
  function responderDisco(u) {
    const arq = path.join(RAIZ, path.normalize(decodeURIComponent(u.pathname)));
    if (!arq.startsWith(RAIZ + path.sep) || /\.(mp3|wav|aiff?|nml)$/i.test(arq) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) return { responseCode: 404, body: b64('não') };
    return { responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: tipos[path.extname(arq)] || 'application/octet-stream' }, { name: 'Cache-Control', value: 'no-store' }], body: fs.readFileSync(arq).toString('base64') };
  }

  try {
    const [p, caminho] = (await esperarArquivo(path.join(perfil, 'DevToolsActivePort'), 20000)).trim().split('\n');
    c = cdp(`ws://127.0.0.1:${p}${caminho}`);
    await c.pronto;
    let pagina = '';
    c.aoEvento((m) => {
      if (m.method === 'Runtime.exceptionThrown') erros.push(`${pagina}: ${(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text || '').slice(0, 300)}`);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') erros.push(`${pagina}: console.error ${JSON.stringify(m.params.args.map((a) => a.value || a.description)).slice(0, 300)}`);
      if (m.method === 'Fetch.requestPaused') {
        const { requestId, request } = m.params, u = new URL(request.url);
        let r;
        if (u.origin === TS) r = ts.noAr ? responderTrackSave(request) : null;
        else if (u.origin === LOCAL || u.origin === PAGES) r = responderDisco(u);
        else if (u.origin === PUB) r = responderDisco(new URL(u.pathname.replace(/^\/vbmx-friends(?=\/)/, ''), LOCAL));
        else { outros.push({ url: request.url, corpo: request.postData || '' }); r = /fonts\.googleapis/.test(u.host) ? { responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/css' }], body: '' } : null; }
        (r ? c.enviar('Fetch.fulfillRequest', Object.assign({ requestId }, r), m.sessionId) : c.enviar('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, m.sessionId)).catch(() => {});
      }
    });
    const abrir = async (url, pronta, largura) => {
      pagina = url;
      const { targetId } = await c.enviar('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await c.enviar('Target.attachToTarget', { targetId, flatten: true });
      const avaliar = async (expr) => {
        const r = await c.enviar('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
      };
      const tamanho = (w, h, dpr) => c.enviar('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr || 1, mobile: false }, sessionId);
      await tamanho(largura || 1440, 900, 1);
      await c.enviar('Page.enable', {}, sessionId);
      await c.enviar('Runtime.enable', {}, sessionId);
      await c.enviar('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
      await c.enviar('Page.addScriptToEvaluateOnNewDocument', { source: WORKER_FALSO }, sessionId);
      await c.enviar('Page.navigate', { url }, sessionId);
      for (let i = 0; i < 100 && !(await avaliar(pronta)); i++) await espera(100);
      await espera(400);
      const mouse = (type, x, y) => c.enviar('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : type === 'mouseMoved' ? 1 : 1, clickCount: 1 }, sessionId);
      const toque = async (type, pontos) => { await c.enviar('Input.dispatchTouchEvent', { type, touchPoints: pontos }, sessionId); };
      const tecla = async (key, code, vk, modifiers) => { for (const type of ['rawKeyDown', 'keyUp']) await c.enviar('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers: modifiers || 0 }, sessionId); };   // modifiers: 8 = Shift
      return { avaliar, enviar: (m, pr) => c.enviar(m, pr, sessionId), tamanho, mouse, toque, tecla, emularToque: (on) => c.enviar('Emulation.setTouchEmulationEnabled', { enabled: on, maxTouchPoints: 5 }, sessionId), fechar: () => c.enviar('Target.closeTarget', { targetId }) };
    };
    const ate = async (avaliar, expr, ms) => { const fim = Date.now() + ms; while (Date.now() < fim) { if (await avaliar(expr)) return true; await espera(150); } return false; };
    const PRONTA = 'document.readyState === "complete" && typeof VbMxTrackSave === "object"';
    const trazer = (pg, link) => pg.avaliar(`(() => { document.getElementById('ts-link').value = ${JSON.stringify(link)}; document.getElementById('ts-form').requestSubmit(); })()`);
    const LINK_A = 'https://www.youtube.com/watch?v=aaaaaaaaaaa', LINK_B = 'https://youtu.be/bbbbbbbbbbb';

    // ---- 1 e 2: servidor no ar, dois links até a biblioteca ----
    const pg = await abrir(LOCAL + '/interface/friends.html', PRONTA);
    await ate(pg.avaliar, `!document.getElementById('ts-form').hidden`, 5000);
    let t = await pg.avaliar(TELA);
    ok(t.secao && t.campo && !t.dica, `com o TrackSave no ar o campo do link aparece (seção ${t.secao}, campo ${t.campo}, dica ${t.dica})`);
    ok(ts.pedidos.join() === 'GET /saude', `a sonda é um GET /saude só (${ts.pedidos.join()})`);
    await trazer(pg, LINK_A);
    const viuProgresso = await ate(pg.avaliar, `!document.getElementById('ts-progresso').hidden && document.getElementById('ts-baixar').disabled`, 4000);
    ok(viuProgresso, 'durante o download o botão trava e a barra de progresso aparece');
    ok(await ate(pg.avaliar, `/entrou na biblioteca/.test(document.getElementById('ts-status').textContent)`, 30000), 'o 1º link termina com "entrou na biblioteca": ' + (await pg.avaliar(TELA)).status);
    t = await pg.avaliar(TELA);
    ok(/Primeira do Link.*124 BPM · 8A/.test(t.status) && !t.erro && t.link === '' && !t.ocupado, `a tela diz título, BPM e tom, e limpa o campo ("${t.status}")`);
    ok(t.biblioteca.length === 1 && /Primeira do Link/.test(t.biblioteca[0]) && /Canal Um/.test(t.biblioteca[0]) && /124 · 8A/.test(t.biblioteca[0]), `a faixa está na biblioteca do Friends com BPM e tom (${t.biblioteca[0]})`);
    ok(/TrackSave/.test(t.pastas), 'a pasta "TrackSave" aparece no painel de pastas');
    await trazer(pg, LINK_B);
    ok(await ate(pg.avaliar, `/Segunda do Link/.test(document.getElementById('ts-status').textContent)`, 30000), 'o 2º link também entra: ' + JSON.stringify(await pg.avaliar(TELA)).slice(0, 500));
    t = await pg.avaliar(TELA);
    ok(t.biblioteca.length === 2 && /2 de 2 prontas/.test(await pg.avaliar(`document.getElementById('lista-conta').textContent`)), `duas faixas prontas para o shuffle (${t.biblioteca.length})`);
    const seq = ts.pedidos.filter((x) => /00000000000000a1|baixar/.test(x)).slice(0, 5).join(' | ');
    ok(/^POST \/baixar \| GET \/status\/00000000000000a1 \| GET \/status\/00000000000000a1 \| GET \/faixa\/00000000000000a1 \| GET \/audio\/00000000000000a1$/.test(seq), `ordem do contrato: ${seq}`);

    // ---- 3: tocar → a onda, a cabeça e a marca da transição ----
    let px = await pg.avaliar(PIXELS);
    ok(px.estado === 'vazia' && px.tocado === 0 && px.resto > 0, `antes de tocar o canvas mostra só a linha (${px.estado})`);
    await pg.avaliar(`document.getElementById('fr-tocar').click()`);
    ok(await ate(pg.avaliar, `document.getElementById('agora-onda').dataset.estado === 'pronta' && /mixa em/.test(document.getElementById('seguir-quando').textContent)`, 20000), 'tocando: os picos ficam prontos e o plano de transição existe');
    await espera(1500);
    const px1 = await pg.avaliar(PIXELS);
    ok(px1.w === Math.round(px1.cw * px1.dpr) && px1.h === Math.round(px1.ch * px1.dpr) && px1.cw > 300, `o canvas tem os pixels do tamanho na tela (${px1.w}×${px1.h} para ${px1.cw}×${px1.ch} css)`);
    ok(px1.resto > px1.w * 4 && px1.tocado > 0 && px1.cabeca >= px1.h, `a forma de onda está desenhada (${px1.resto} px por tocar, ${px1.tocado} tocados, cabeça ${px1.cabeca} px)`);
    await espera(3000);
    const px2 = await pg.avaliar(PIXELS);
    const andou = (px2.xCabeca - px1.xCabeca) / px1.w * 60;
    ok(px2.xCabeca > px1.xCabeca && andou > 2 && andou < 4.5, `a cabeça acompanha a reprodução: andou ${andou.toFixed(2)} s de faixa em ~3 s (x ${px1.xCabeca} → ${px2.xCabeca})`);
    ok(px2.tocado > px1.tocado, 'o trecho já tocado cresce');
    const tempo = await pg.avaliar(`document.getElementById('agora-tempo').textContent`);
    const [mm, ss] = tempo.split(' / ')[0].split(':').map(Number);
    ok(Math.abs((mm * 60 + ss) - px2.xCabeca / px2.w * 60) < 1.5, `a cabeça bate com o relógio da tela (${tempo}, cabeça em ${(px2.xCabeca / px2.w * 60).toFixed(1)} s)`);
    const ponto = await pg.avaliar(`(() => { const i = document.getElementById('agora-ponto'); return i.hidden ? null : parseFloat(i.style.left); })()`);
    ok(ponto !== null && px2.mix >= px2.h && Math.abs(px2.xMix / px2.w * 100 - ponto) < 0.6, `a marca da transição está no inicioMix do plano (canvas ${(px2.xMix / px2.w * 100).toFixed(2)}%, plano ${ponto === null ? '—' : ponto.toFixed(2)}%)`);
    ok(px2.xMix > px2.xCabeca, 'a marca fica à frente da cabeça enquanto a mixagem não começou');

    // ---- 3a: fundo em mosaico "Compasso" (modos/friends-fundo.js): anda com o BPM, pausa = 0 quadro, reduced-motion estático,
    //      e o texto tem o MESMO contraste com o fundo e sem ele, em 129 quadros (4 compassos, passo de 1/8 de batida) ----
    const FUNDO = 'VbMxFundo.atual.leitura()';
    const f0 = await pg.avaliar(FUNDO); await espera(1000); const f1 = await pg.avaliar(FUNDO);
    ok(f0.rodando && f0.vel > 0.98 && Math.abs(f0.bpmEf - 124) < 1.5 && f1.fase > f0.fase && f1.quadros > f0.quadros, `fundo: tocando a 124 BPM o relógio anda (fase ${f0.fase.toFixed(2)} → ${f1.fase.toFixed(2)}, andamento ${f0.bpmEf.toFixed(1)}, ${f1.quadros - f0.quadros} quadros em 1 s)`);
    ok(f1.fase - f0.fase > 1.5 && f1.fase - f0.fase < 2.6, `fundo: ~2,07 batidas por segundo a 124 BPM (andou ${(f1.fase - f0.fase).toFixed(2)})`);
    ok(await pg.avaliar(`(() => { const e = document.getElementById('fr-fundo'), cs = getComputedStyle(e); return e.getAttribute('aria-hidden') === 'true' && cs.pointerEvents === 'none' && cs.position === 'fixed' && cs.zIndex === '-1' && !e.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2)) && !e.textContent.trim(); })()`), 'fundo: decorativo (aria-hidden, sem texto), fixo, atrás e sem pegar clique');
    await pg.avaliar(`document.getElementById('fr-tocar').click()`);   // pausa: o laço desliga
    ok(await ate(pg.avaliar, `/pausado|paused/i.test(document.querySelector('.friends').dataset.fase)`, 3000), 'fundo: a música pausou');
    await espera(1500);
    const p0 = await pg.avaliar(FUNDO); await espera(1500); const p1 = await pg.avaliar(FUNDO);
    ok(p0.vel === 0 && !p0.rodando && p1.quadros === p0.quadros && p1.fase === p0.fase, `fundo: pausa = 0 quadro e fase parada (${p1.quadros - p0.quadros} quadros em 1,5 s, fase ${p1.fase.toFixed(2)})`);
    // a página, estática (pausada): o texto fica transparente para medir só o que há atrás dele, com e sem o fundo
    const PREPARA = `(() => {
      const L = (r, g, b) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const rects = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode());) {
        const el = n.parentElement; if (!el || !n.textContent.trim() || /^(SCRIPT|STYLE)$/.test(el.tagName) || el.closest('.fr-fundo, .so-leitor, [hidden]')) continue;
        const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const m = cs.color.match(/[\\d.]+/g).map(Number), r = document.createRange(); r.selectNodeContents(n);
        for (const q of r.getClientRects()) { const x = Math.max(0, Math.floor(q.left)), y = Math.max(0, Math.floor(q.top)), x2 = Math.min(innerWidth, Math.ceil(q.right)), y2 = Math.min(innerHeight, Math.ceil(q.bottom)); if (x2 > x && y2 > y) rects.push([x, y, x2 - x, y2 - y, L(m[0], m[1], m[2])]); }
      }
      let st = document.getElementById('prova-oculta'); if (!st) { st = document.createElement('style'); st.id = 'prova-oculta'; document.head.appendChild(st); }
      st.textContent = '*, *::before, *::after { color: transparent !important; caret-color: transparent !important; text-shadow: none !important; transition: none !important; animation: none !important; } canvas { visibility: hidden !important; } progress { visibility: hidden !important; }';
      window.__cx = { rects, L, base: null };
      return rects.length;
    })()`;
    const LE = (b64, base) => `(async () => {
      const im = new Image(); im.src = 'data:image/png;base64,${b64}'; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
      const cx = window.__cx; let diff = 0, pior = Infinity;
      ${base ? 'cx.base = g.getImageData(0, 0, c.width, c.height); cx.lins = []; ' : ''}
      for (const [x, y, w, h, lt] of cx.rects) {
        const d = g.getImageData(x, y, w, h).data, b = cx.base.data; let hi = 0, lo = 1;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
          const k = (j * w + i) * 4, o = (((y + j) * c.width) + x + i) * 4;
          if (d[k] !== b[o] || d[k + 1] !== b[o + 1] || d[k + 2] !== b[o + 2]) diff++;
          const l = cx.L(d[k], d[k + 1], d[k + 2]); if (l > hi) hi = l; if (l < lo) lo = l;
        }
        const ct = (a, b2) => (Math.max(a, b2) + 0.05) / (Math.min(a, b2) + 0.05);
        pior = Math.min(pior, ct(lt, hi), ct(lt, lo));   // o pior dos dois extremos do que há atrás do texto
      }
      return { diff, pior };
    })()`;
    const tirar = async () => (await pg.enviar('Page.captureScreenshot', { format: 'png' })).data;
    const FASES = Array.from({ length: 129 }, (_, i) => i / 8);   // 4 compassos × 4 batidas × 8 passos + o fecho
    // a capa branca, o pior caso: ela vive dentro do bloco, sobre o fundo opaco dele
    const BRANCA = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#fff"/></svg>');
    const capaAntes = await pg.avaliar(`(() => { const i = document.getElementById('agora-capa'); const o = { src: i.getAttribute('src'), hidden: i.hidden }; i.src = ${JSON.stringify(BRANCA)}; i.hidden = false; return o; })()`);
    for (const larg of [1440, 360]) {
      await pg.tamanho(larg, 900, 1); await espera(500);
      const nRects = await pg.avaliar(PREPARA);
      await pg.avaliar(`(() => { let s = document.getElementById('prova-sem'); if (!s) { s = document.createElement('style'); s.id = 'prova-sem'; document.head.appendChild(s); } s.textContent = '.fr-fundo { display: none !important; }'; })()`);
      await espera(200);
      const base = await pg.avaliar(LE(await tirar(), true));
      await pg.avaliar(`document.getElementById('prova-sem').textContent = ''`);
      let diffTotal = 0, piorMin = Infinity, quadros = 0;
      for (const f of FASES) {
        await pg.avaliar(`VbMxFundo.atual.definirFase(${f})`);
        const r = await pg.avaliar(LE(await tirar(), false)); diffTotal += r.diff; piorMin = Math.min(piorMin, r.pior); quadros++;
      }
      ok(nRects > 8 && quadros === 129, `fundo ${larg} px: ${quadros} quadros (4 compassos, 1/8 de batida) sobre ${nRects} caixas de texto`);
      ok(diffTotal === 0 && Math.abs(piorMin - base.pior) < 1e-9, `fundo ${larg} px: o que há atrás do texto é idêntico com e sem o fundo (${diffTotal} pixels diferentes; pior contraste ${piorMin.toFixed(2)}:1 = ${base.pior.toFixed(2)}:1 sem fundo, capa branca)`);
      ok(base.pior >= 4.5, `fundo ${larg} px: o pior contraste do texto sobre o que há atrás passa de 4,5:1 (${base.pior.toFixed(2)}:1)`);
      await pg.avaliar(`(() => { for (const id of ['prova-oculta', 'prova-sem']) { const s = document.getElementById(id); if (s) s.remove(); } })()`);
    }
    await pg.tamanho(1440, 900, 1); await espera(300);
    // reduced-motion: tocando, o fundo fica estático
    await pg.enviar('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await pg.avaliar(`document.getElementById('fr-tocar').click()`);
    ok(await ate(pg.avaliar, `document.querySelector('.friends').dataset.fase === 'tocando'`, 3000), 'fundo: tocando de novo, com reduced-motion');
    await espera(1200);
    const r0 = await pg.avaliar(FUNDO); await espera(1200); const r1 = await pg.avaliar(FUNDO);
    ok(r0.reduzido && !r0.rodando && r1.quadros === r0.quadros && r1.fase === r0.fase && parseFloat(await pg.avaliar(`document.querySelector('.fr-peca-relogio').style.transform.replace('rotate(', '')`)) === 0, 'fundo: prefers-reduced-motion = estático (nenhum quadro, peças na posição 0)');
    await pg.enviar('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    // no Chrome headless o 'change' da mídia não chega sozinho; o aviso seguinte do controlador (tocar/pausar/trocar) reavalia a preferência
    await pg.avaliar(`VbMxFundo.atual.avisar()`);
    ok(await ate(pg.avaliar, `VbMxFundo.atual.leitura().rodando`, 3000), 'fundo: sem reduced-motion o laço volta a rodar, sem recarregar: ' + JSON.stringify(await pg.avaliar(FUNDO)) + ' fase ' + await pg.avaliar(`document.querySelector('.friends').dataset.fase`));
    await pg.avaliar(`(() => { const i = document.getElementById('agora-capa'), o = ${JSON.stringify(capaAntes)}; if (o.src === null) i.removeAttribute('src'); else i.setAttribute('src', o.src); i.hidden = o.hidden; })()`);

    // ---- 7b: troca de idioma ao vivo, com a faixa tocando (interface/js/i18n.js): HTML marcado, texto montado, lang do <html> ----
    const lido = `({ lang: document.documentElement.lang, tocar: document.getElementById('fr-tocar').textContent, mixar: document.getElementById('fr-mixar').textContent,
      seguir: document.getElementById('seguir-quando').textContent, conta: document.getElementById('lista-conta').textContent, fase: document.getElementById('fr-fase').textContent,
      aria: document.getElementById('fr-duracao').getAttribute('aria-label'), seg8: document.querySelector('#fr-duracao [data-c="8"]').getAttribute('aria-label'), fmt: document.querySelector('#fr-formato [data-f="degrau"]').title,
      valuetext: document.getElementById('agora-bola').getAttribute('aria-valuetext'), volume: document.getElementById('fr-volume').getAttribute('aria-label'), nota: document.getElementById('ts-capa-nota').textContent.length })`;
    const pt = await pg.avaliar(lido);
    ok(pt.lang === 'pt-BR' && pt.tocar === 'Pausar' && /mixa em/.test(pt.seguir) && /prontas para o shuffle/.test(pt.conta), `pt-BR é o idioma inicial com o Chrome em pt-BR (${pt.lang}, "${pt.tocar}")`);
    const vistos = { 'pt-BR': pt };
    for (const l of ['en', 'es', 'fr']) {
      await pg.avaliar(`document.querySelector('[data-lang="${l}"]').click()`);
      await espera(400);
      const x = await pg.avaliar(lido);
      vistos[l] = x;
      ok(x.lang === l && await pg.avaliar(`localStorage.getItem('vbmx-idioma')`) === l, `${l}: o lang do <html> e a escolha salva mudam`);
      ok(x.mixar !== pt.mixar && x.seguir !== pt.seguir && x.conta !== pt.conta && x.fase !== pt.fase && x.aria !== pt.aria && x.seg8 !== pt.seg8 && x.fmt !== pt.fmt && x.valuetext !== pt.valuetext, `${l}: botão, frases do plano, contagem, fase, aria e dica de curva trocaram ao vivo, tocando`);
      ok(x.volume === (await pg.avaliar(`VbMxI18n.t('friends.volume.aria')`)) && x.nota > 20, `${l}: o texto marcado no HTML vem do dicionário`);
      ok(await pg.avaliar(`document.querySelector('[data-lang="${l}"]').getAttribute('aria-checked') === 'true' && document.querySelectorAll('[data-lang][aria-checked="true"]').length === 1`), `${l}: só o idioma ativo está marcado no seletor`);
    }
    ok(new Set(Object.values(vistos).map((x) => x.mixar)).size === 4, 'os quatro idiomas dão quatro rótulos diferentes no botão "Mixar agora" (em es, "Pausar" é igual ao pt-BR)');
    // teclado: seta para a direita no seletor troca de idioma e leva o foco
    await pg.avaliar(`document.querySelector('[data-lang="fr"]').focus()`);
    await pg.avaliar(`document.querySelector('[data-i18n-seletor]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
    ok(await pg.avaliar(`document.documentElement.lang === 'pt-BR' && document.activeElement.getAttribute('data-lang') === 'pt-BR'`), 'o seletor de idioma anda por teclado (seta para a direita volta de FR a PT)');
    ok(await pg.avaliar(`[...document.querySelectorAll('[data-lang]')].every((b) => b.getBoundingClientRect().width >= 43.5 && b.getBoundingClientRect().height >= 43.5)`), 'alvos do seletor de idioma ≥ 44 px');
    // recarrega: a escolha salva vale mais que o idioma do navegador
    await pg.avaliar(`VbMxI18n.definir('es')`);
    const pgIdioma = await abrir(`${LOCAL}/interface/friends.html`, PRONTA);
    ok(await pgIdioma.avaliar(`document.documentElement.lang === 'es' && document.getElementById('fr-mixar').textContent === VbMxI18n.t('friends.mixar')`), 'ao reabrir a página, a escolha salva (es) vale mais que o idioma do navegador (pt-BR)');
    await pgIdioma.avaliar(`VbMxI18n.definir('pt-BR')`);
    await pgIdioma.fechar();
    await pg.avaliar(`VbMxI18n.definir('pt-BR')`);


    // ---- 3a: a capa ao fundo do "tocando agora" ----
    const CAPA = `(() => { const im = document.getElementById('agora-capa'), a = document.querySelector('.fr-agora').getBoundingClientRect(), b = im.getBoundingClientRect(), cs = getComputedStyle(im), t = getComputedStyle(document.getElementById('agora-titulo'));
      return { src: im.getAttribute('src') || '', origem: im.dataset.origem, op: Number(cs.opacity), filtro: cs.filter, z: cs.zIndex, ev: cs.pointerEvents, dentro: b.left >= a.left - 1 && b.right <= a.right + 1 && b.top >= a.top - 1 && b.bottom <= a.bottom + 1, cheia: Math.abs(b.width - a.width) < 2 && Math.abs(b.height - a.height) < 2, cor: t.color,
        topo: document.elementFromPoint(a.left + a.width / 2, a.top + 20) === im, nota: !document.getElementById('ts-capa-nota').hidden, chave: !document.getElementById('ts-capa-linha').hidden, liga: document.getElementById('ts-capa').checked, alt: im.getAttribute('alt'), aria: im.getAttribute('aria-hidden') }; })()`;
    ok(await ate(pg.avaliar, `document.getElementById('agora-capa').dataset.origem !== 'padrao'`, 8000), 'a capa de verdade troca a padrão quando chega (sem a UI esperar)');
    const cp = await pg.avaliar(CAPA);
    ok(/^blob:/.test(cp.src) && (cp.origem === 'miniatura' || cp.origem === 'pesquisa'), `a capa vem do TrackSave por object URL (${cp.origem})`);
    ok(ts.capas.length >= 1 && ts.capas.every((q) => /^\?(id=bbbbbbbbbbb|titulo=[^&]+(&artista=[^&]+)?)$/.test(q)), `pedidos /capa corretos e codificados: ${ts.capas.join(' ')}`);
    ok(cp.origem === 'miniatura' ? ts.capas.includes('?id=bbbbbbbbbbb') : ts.capas.some((q) => /^\?titulo=Primeira(%20|\+)do(%20|\+)Link/.test(q)), 'cadeia: faixa com id de vídeo usa /capa?id=; sem id, a pesquisa por título+artista');
    ok(cp.op >= 0.5 && /brightness\((0\.[6-9]\d*|1)\)/.test(cp.filtro), `capa visível (opacidade ${cp.op}, ${cp.filtro}); o contraste vem dos véus locais`);
    ok(Number(cp.z) < 0 && cp.ev === 'none' && cp.dentro && cp.cheia && !cp.topo && cp.alt === '' && cp.aria === 'true', 'a capa fica atrás do texto, dentro da área, não captura clique e é decorativa para o leitor de tela');
    ok(cp.chave && cp.nota && cp.liga, 'o interruptor "pesquisar a capa" e a nota de privacidade aparecem com o TrackSave no ar, ligado por padrão');
    await pg.avaliar(`document.getElementById('ts-capa').click()`);
    ok(await pg.avaliar(`localStorage.getItem('vbmx-friends-capa-pesquisa') === '0'`), 'desligar o interruptor grava a escolha (lembrada entre sessões)');
    await pg.avaliar(`document.getElementById('ts-capa').click()`);
    ok(await pg.avaliar(`localStorage.getItem('vbmx-friends-capa-pesquisa') === '1'`), 'ligar de novo grava de volta');

    // ---- 4: responsiva ----
    for (const [w, dpr] of [[360, 3], [768, 2], [1440, 1]]) {
      await pg.tamanho(w, 800, dpr); await espera(500);
      const r = await pg.avaliar(`(() => { const cv = document.getElementById('agora-onda'), b = cv.getBoundingClientRect(), l = document.getElementById('ts-link').getBoundingClientRect(), bt = document.getElementById('ts-baixar').getBoundingClientRect();
        return { rolagem: document.documentElement.scrollWidth - window.innerWidth, w: cv.width, cw: cv.clientWidth, ch: cv.clientHeight, dpr: devicePixelRatio, esq: b.left, dir: b.right, linkDir: l.right, linkW: l.width, btDir: bt.right, iw: window.innerWidth }; })()`);
      const pxr = await pg.avaliar(PIXELS);
      ok(await pg.avaliar(`(() => { const a = document.querySelector('.fr-agora').getBoundingClientRect(), b = document.getElementById('agora-capa').getBoundingClientRect(); return b.left >= a.left - 1 && b.right <= a.right + 1 && b.right <= window.innerWidth + 1; })()`), `${w} px: a capa fica dentro da área "tocando agora" e da tela`);
      ok(await pg.avaliar(`(() => { const a = document.querySelector('.fr-seguir').getBoundingClientRect(), i = document.getElementById('seguir-capa'), b = i.getBoundingClientRect(), cs = getComputedStyle(i); return !!i.getAttribute('src') && Number(cs.opacity) >= 0.5 && Number(cs.zIndex) < 0 && b.left >= a.left - 1 && b.right <= a.right + 1 && b.right <= window.innerWidth + 1; })()`), `${w} px: a capa da faixa a seguir tem imagem (a padrão, se não há capa), mesma opacidade e fica dentro do bloco e da tela`);
      ok(r.rolagem <= 0 && r.esq >= 0 && r.dir <= r.iw && r.linkDir <= r.iw && r.btDir <= r.iw && r.linkW >= 150, `${w} px: sem rolagem horizontal; onda, campo e botão dentro da tela (sobra ${r.rolagem}, campo ${Math.round(r.linkW)} px)`);
      ok(r.w === Math.round(r.cw * r.dpr) && r.ch >= 56 && r.ch <= 96 && pxr.resto + pxr.tocado > pxr.w * 4 && pxr.cabeca > 0, `${w} px (dpr ${dpr}): a onda é redesenhada na resolução nova (${r.w} px de canvas para ${r.cw}×${r.ch} css)`);
      const sg = await pg.avaliar(`(() => { const bs = [...document.querySelectorAll('#fr-duracao .fr-seg')].map((b) => b.getBoundingClientRect()); return { n: bs.length, minH: Math.min(...bs.map((b) => b.height)), minW: Math.min(...bs.map((b) => b.width)), dir: Math.max(...bs.map((b) => b.right)), iw: window.innerWidth }; })()`);
      ok(sg.n === 5 && sg.minH >= 44 && sg.minW >= 44 && sg.dir <= sg.iw, `${w} px: seletor de compassos com 5 opções, alvos ≥ 44 px (${Math.round(sg.minW)}×${Math.round(sg.minH)}) e dentro da tela`);
    }

    // ---- 4b: os dois marcadores da barra (busca e ponto da mixagem), por ponteiro, toque e teclado ----
    await pg.tamanho(1440, 800, 1); await espera(500);
    const GEO = `(() => { const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
      return { fio: r('agora-fio'), onda: r('agora-onda'), bola: r('agora-bola'), ponto: r('agora-ponto'), pdisp: !document.getElementById('agora-ponto').hidden }; })()`;
    const TEMPO = `(() => { const [m, s] = document.getElementById('agora-tempo').textContent.split(' / ')[0].split(':').map(Number); return m * 60 + s; })()`;
    const PONTO = `(() => { const i = document.getElementById('agora-ponto'); return { t: parseFloat(i.style.left) * 0.6, texto: document.getElementById('agora-mixponto').textContent, dis: i.getAttribute('aria-disabled'), now: Number(i.getAttribute('aria-valuenow')) }; })()`;
    let geo = await pg.avaliar(GEO);
    ok(geo.bola.w >= 44 && geo.bola.h >= 44 && geo.ponto.w >= 44 && geo.ponto.h >= 44, `a bolinha (${geo.bola.w}×${geo.bola.h}) e o triângulo (${geo.ponto.w}×${geo.ponto.h}) têm alvo de toque ≥ 44 px`);
    ok(await pg.avaliar(`['agora-bola', 'agora-ponto'].every((id) => document.getElementById(id).getAttribute('role') === 'slider' && document.getElementById(id).tabIndex === 0)`), 'os dois são role=slider e focáveis');
    ok(await pg.avaliar(`getComputedStyle(document.getElementById('agora-bola')).cursor === 'grab' && getComputedStyle(document.getElementById('agora-bola')).touchAction === 'none' && getComputedStyle(document.getElementById('agora-onda')).cursor === 'pointer'`), 'cursor de arrastar na bolinha e de clique na onda; touch-action: none na bolinha');
    const X = (f) => geo.fio.x + geo.fio.w * f, YF = geo.fio.y + 14, YO = geo.onda.y + geo.onda.h / 2;
    // clicar na onda: a reprodução vai para lá e segue tocando
    await pg.mouse('mousePressed', X(0.4), YO); await pg.mouse('mouseReleased', X(0.4), YO); await espera(600);
    let tp = await pg.avaliar(TEMPO);
    ok(Math.abs(tp - 24) < 3, `clicar a 40% da onda leva a reprodução a ~24 s (agora ${tp} s)`);
    await espera(1500);
    ok((await pg.avaliar(TEMPO)) > tp + 0.9, 'depois do clique a reprodução continua andando dali');
    // arrastar a bolinha: o relógio acompanha durante o arrasto e o áudio vai ao soltar
    geo = await pg.avaliar(GEO);
    await pg.mouse('mousePressed', geo.bola.x + geo.bola.w / 2, geo.bola.y + geo.bola.h / 2);
    for (const f of [0.35, 0.25, 0.15]) { await pg.mouse('mouseMoved', X(f), YF); await espera(60); }
    ok(Math.abs((await pg.avaliar(TEMPO)) - 9) < 1.2, 'durante o arrasto a bolinha, o relógio e a cabeça da onda acompanham (9 s a 15%)');
    ok(await pg.avaliar(`document.getElementById('agora-bola').classList.contains('arrastando')`), 'a bolinha marca o estado "arrastando"');
    await pg.mouse('mouseReleased', X(0.15), YF); await espera(700);
    tp = await pg.avaliar(TEMPO);
    ok(tp >= 8.5 && tp < 13, `ao soltar o áudio continua dali (${tp} s)`);
    // ponto da mixagem: arrastar o triângulo
    geo = await pg.avaliar(GEO);
    const antesP = await pg.avaliar(PONTO);
    const px0 = geo.ponto.x + geo.ponto.w / 2, py0 = geo.ponto.y + 28;
    await pg.mouse('mousePressed', px0, py0);
    for (const f of [0.6, 0.55, 0.5]) { await pg.mouse('mouseMoved', X(f), py0); await espera(60); }
    await pg.mouse('mouseReleased', X(0.5), py0); await espera(400);
    let pp = await pg.avaliar(PONTO);
    ok(Math.abs(pp.t - 30) < 2.2 && pp.t !== antesP.t && /escolhida por você/.test(pp.texto), `arrastar o triângulo move o ponto de ~${antesP.t.toFixed(1)} s para ~${pp.t.toFixed(1)} s e a tela diz "${pp.texto}"`);
    ok(/mixa em/.test(await pg.avaliar(`document.getElementById('seguir-quando').textContent`)) && /Mixagem em \d+:\d\d/.test(pp.texto), 'a tela mostra o novo tempo do ponto e o plano continua de pé');
    const pxm = await pg.avaliar(PIXELS);
    ok(Math.abs(pxm.xMix / pxm.w * 60 - pp.t) < 0.7, `a marca verde/amarela da onda foi junto (${(pxm.xMix / pxm.w * 60).toFixed(1)} s)`);
    // encaixe: o ponto cai na batida 1 do compasso (124 BPM → 1,935 s por compasso: dois arrastos a 0,3 s de distância dão o mesmo ponto ou um compasso)
    geo = await pg.avaliar(GEO);
    await pg.mouse('mousePressed', geo.ponto.x + geo.ponto.w / 2, py0); await pg.mouse('mouseMoved', X(0.99), py0); await pg.mouse('mouseReleased', X(0.99), py0); await espera(300);
    pp = await pg.avaliar(PONTO);
    ok(pp.t <= (60 - 1 - 15) + 0.6, `arrastar para além do fim: o ponto fica no último compasso que comporta a transição (${pp.t.toFixed(1)} s ≤ 44 s)`);
    // teclado: bolinha ±5 s, triângulo ±1 compasso, Esc volta ao automático
    await pg.avaliar(`document.getElementById('agora-bola').focus()`);
    const t0 = await pg.avaliar(TEMPO);
    await pg.tecla('ArrowRight', 'ArrowRight', 39); await espera(300);
    const t1 = await pg.avaliar(TEMPO);
    ok(t1 - t0 >= 4.5 && t1 - t0 < 7, `teclado: seta direita na bolinha avança ~5 s (${t0} → ${t1} s)`);
    await pg.tecla('Home', 'Home', 36); await espera(300);
    ok((await pg.avaliar(TEMPO)) < 2, 'teclado: Home leva a bolinha ao começo');
    ok(await pg.avaliar(`(() => { const b = document.getElementById('agora-bola'); return Number(b.getAttribute('aria-valuenow')) < 3 && /de \\d+:\\d\\d/.test(b.getAttribute('aria-valuetext')); })()`), 'aria-valuenow e aria-valuetext da bolinha');
    await pg.avaliar(`document.getElementById('agora-ponto').focus()`);
    const a1 = (await pg.avaliar(PONTO)).t;
    await pg.tecla('ArrowLeft', 'ArrowLeft', 37); await espera(250);
    const a2 = (await pg.avaliar(PONTO)).t;
    ok(a1 - a2 > 1.5 && a1 - a2 < 2.3, `teclado: seta esquerda no triângulo recua um compasso (${a1.toFixed(1)} → ${a2.toFixed(1)} s)`);
    await pg.tecla('Escape', 'Escape', 27); await espera(250);
    pp = await pg.avaliar(PONTO);
    ok(/automática/.test(pp.texto), 'Esc no triângulo volta ao ponto automático');
    // toque (Pointer Events vindos de um dedo)
    await pg.emularToque(true);
    geo = await pg.avaliar(GEO);
    const bx = geo.bola.x + geo.bola.w / 2, by = geo.bola.y + geo.bola.h / 2;
    await pg.toque('touchStart', [{ x: bx, y: by }]);
    for (const f of [0.1, 0.2, 0.3]) { await pg.toque('touchMove', [{ x: X(f), y: by }]); await espera(60); }
    await pg.toque('touchEnd', []); await espera(700);
    tp = await pg.avaliar(TEMPO);
    ok(tp >= 15 && tp < 21, `toque: arrastar a bolinha com o dedo leva a reprodução a ~18 s (${tp} s)`);
    const dp = (await pg.avaliar(GEO)).ponto, d0 = (await pg.avaliar(PONTO)).t;
    await pg.toque('touchStart', [{ x: dp.x + dp.w / 2, y: dp.y + 28 }]);
    for (const f of [0.55, 0.5]) { await pg.toque('touchMove', [{ x: X(f), y: dp.y + 28 }]); await espera(60); }
    await pg.toque('touchEnd', []); await espera(400);
    pp = await pg.avaliar(PONTO);
    ok(Math.abs(pp.t - 30) < 2.2 && pp.t !== d0, `toque: arrastar o triângulo com o dedo move o ponto para ~${pp.t.toFixed(1)} s`);
    await pg.emularToque(false);
    await pg.tecla('Escape', 'Escape', 27);
    // 360 px: alvos e sem rolagem
    await pg.tamanho(360, 800, 3); await espera(500);
    const g3 = await pg.avaliar(GEO);
    ok(g3.bola.w >= 44 && g3.ponto.w >= 44 && g3.bola.x >= -22 && g3.bola.x + g3.bola.w <= 360 + 22, `360 px: alvos de ${Math.round(g3.bola.w)} px e a barra dentro da tela (rolagem horizontal ${await pg.avaliar('document.documentElement.scrollWidth - window.innerWidth')})`);
    ok((await pg.avaliar('document.documentElement.scrollWidth - window.innerWidth')) <= 0, '360 px: sem rolagem horizontal com os marcadores');
    await pg.tamanho(1440, 800, 1); await espera(400);

    await pg.avaliar(`document.querySelector('#fr-duracao .fr-seg[data-c="32"]').click()`);
    ok(await pg.avaliar(`localStorage.getItem('vbmx-friends-compassos') === '32' && document.querySelector('#fr-duracao .fr-seg[data-c="32"]').getAttribute('aria-checked') === 'true'`), 'seletor: clicar em 32 marca a opção e grava os compassos em localStorage');
    const dica = await pg.avaliar(`document.getElementById('fr-duracao-info').textContent`);
    ok(/^32 compassos ≈ \d+ s/.test(dica), `dica em segundos ao lado do seletor: "${dica}"`);
    await pg.avaliar(`document.querySelector('#fr-duracao .fr-seg[data-c="8"]').click()`);
    // formato da curva do crossfader: miniaturas, desenho do X, lembrado em localStorage
    const dX = () => pg.avaliar(`document.querySelector('#fr-x .entra').getAttribute('d')`);
    const dLinear = await dX();
    await pg.avaliar(`document.querySelector('#fr-formato .fr-fmt[data-f="degrau"]').click()`); await espera(450);
    ok(await pg.avaliar(`localStorage.getItem('vbmx-friends-formato') === 'degrau' && document.querySelector('#fr-formato .fr-fmt[data-f="degrau"]').getAttribute('aria-checked') === 'true' && document.querySelectorAll('#fr-formato .fr-fmt[aria-checked="true"]').length === 1`), 'formato: clicar em degrau marca a miniatura e grava em localStorage');
    const dDegrau = await dX();
    ok(dDegrau && dDegrau !== dLinear, 'formato: a curva do X na tela muda com o formato escolhido');
    ok(await pg.avaliar(`[...document.querySelectorAll('#fr-formato .fr-fmt')].every((b) => b.getBoundingClientRect().height >= 44 && b.querySelector('.sai').getAttribute('d').length > 10)`), 'formato: seis miniaturas (cinco prontos + personalizado) com o desenho e alvo >= 44 px');
    await pg.avaliar(`document.querySelector('#fr-formato .fr-fmt[data-f="potencia"]').click()`); await espera(450);

    let provaMemoria = null;
    // ---- curva personalizada: dois pontos arrastáveis (mouse, toque, teclado), limites, memória e espelho ----
    {
      const PT = (n) => pg.avaliar(`(() => { const r = document.getElementById('fr-pt-${n}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
      const XR = () => pg.avaliar(`(() => { const r = document.getElementById('fr-x').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
      const CV = () => pg.avaliar(`JSON.parse(localStorage.getItem('vbmx-friends-curva') || 'null')`);
      const FM = () => pg.avaliar(`localStorage.getItem('vbmx-friends-formato')`);
      const noX = (x, t, g) => ({ x: x.x + x.w * (40 + 120 * t) / 200, y: x.y + x.h * (52 - 44 * g) / 60 });
      const p1 = await PT(1), p2 = await PT(2);
      ok(p1.w >= 44 && p1.h >= 44 && p2.w >= 44 && p2.h >= 44, `curva personalizada: os dois pontos têm alvo de ${Math.round(p1.w)}×${Math.round(p1.h)} px (>= 44)`);
      ok(await pg.avaliar(`getComputedStyle(document.querySelector('#fr-pt-1 i')).borderRadius !== getComputedStyle(document.querySelector('#fr-pt-2 i')).borderRadius && getComputedStyle(document.getElementById('fr-pt-1')).boxShadow === 'none'`), 'curva personalizada: início em círculo e fim em quadrado, sem sombra');
      ok(/\d+ % a \d+ %/.test(await pg.avaliar(`document.getElementById('fr-curva-info').textContent`)), 'curva personalizada: início e fim da rampa aparecem em % do cruzamento');
      // mouse: arrasta o ponto 1 para t=0,3 g=0,1
      let X = await XR(), alvo = noX(X, 0.3, 0.1);
      await pg.mouse('mousePressed', p1.x, p1.y); await pg.mouse('mouseMoved', (p1.x + alvo.x) / 2, (p1.y + alvo.y) / 2); await pg.mouse('mouseMoved', alvo.x, alvo.y); await pg.mouse('mouseReleased', alvo.x, alvo.y); await espera(300);
      let cv = await CV();
      ok(cv && Math.abs(cv.t1 - 0.3) < 0.03 && Math.abs(cv.g1 - 0.1) < 0.05 && await FM() === 'personalizado', `mouse: arrastar o ponto de início liga o personalizado e lembra os pontos (${cv && cv.t1.toFixed(2)}, ${cv && cv.g1.toFixed(2)})`);
      ok(await pg.avaliar(`document.querySelector('#fr-formato .fr-fmt[data-f="personalizado"]').getAttribute('aria-checked') === 'true' && document.querySelectorAll('#fr-formato .fr-fmt[aria-checked="true"]').length === 1`), 'mouse: o botão "personalizada" fica marcado e os outros desmarcam');
      // limite: arrastar o ponto 1 para além do ponto 2 não cruza
      const q2 = await PT(2); alvo = noX(X, 0.99, 0.99);
      const q1 = await PT(1);
      await pg.mouse('mousePressed', q1.x, q1.y); await pg.mouse('mouseMoved', alvo.x, alvo.y); await pg.mouse('mouseReleased', alvo.x, alvo.y); await espera(300);
      cv = await CV();
      ok(cv && cv.t1 < cv.t2 && cv.g1 <= cv.g2 && Math.abs(cv.t2 - ((await CV()).t2)) < 1e-9, `mouse: arrastar o início além do fim para no limite, sem cruzar (t1 ${cv.t1.toFixed(2)} < t2 ${cv.t2.toFixed(2)})`);
      // espelho no desenho: o ponto-médio de saindo e entrando é simétrico
      ok(await pg.avaliar(`(() => { const a = document.querySelector('#fr-x .entra'), b = document.querySelector('#fr-x .sai'); return a.getTotalLength() > 50 && Math.abs(a.getTotalLength() - b.getTotalLength()) < 0.5; })()`), 'espelho: as duas curvas do X têm o mesmo comprimento (uma é a outra refletida)');
      // toque
      await pg.emularToque(true);
      const r2 = await PT(2); X = await XR(); alvo = noX(X, 0.8, 0.95);
      await pg.toque('touchStart', [{ x: r2.x, y: r2.y }]); await pg.toque('touchMove', [{ x: (r2.x + alvo.x) / 2, y: (r2.y + alvo.y) / 2 }]); await pg.toque('touchMove', [{ x: alvo.x, y: alvo.y }]); await pg.toque('touchEnd', []); await espera(300);
      cv = await CV();
      ok(cv && Math.abs(cv.t2 - 0.8) < 0.04 && Math.abs(cv.g2 - 0.95) < 0.06, `toque: arrastar o ponto de fim com o dedo (${cv && cv.t2.toFixed(2)}, ${cv && cv.g2.toFixed(2)})`);
      await pg.emularToque(false);
      // teclado: setas, Shift, Home volta ao linear
      await pg.avaliar(`document.getElementById('fr-pt-1').focus()`);
      const a0 = (await CV()).t1;
      await pg.tecla('ArrowRight', 'ArrowRight', 39); await espera(200);
      const a1 = (await CV()).t1;
      await pg.tecla('ArrowRight', 'ArrowRight', 39, 8); await espera(200);
      const a2 = (await CV()).t1;
      ok(Math.abs(a1 - a0 - 0.02) < 1e-6 && Math.abs(a2 - a1 - 0.1) < 1e-6, `teclado: seta move o ponto 2 % e Shift+seta 10 % (${a0.toFixed(2)} → ${a1.toFixed(2)} → ${a2.toFixed(2)})`);
      await pg.tecla('ArrowUp', 'ArrowUp', 38); await espera(200);
      ok((await CV()).g1 > cv.g1 - 1e-9 && /\d/.test(await pg.avaliar(`document.getElementById('fr-pt-1').getAttribute('aria-valuetext')`)), 'teclado: seta para cima sobe o ganho e o valor falado do ponto sai por t()');
      await pg.tecla('Home', 'Home', 36); await espera(250);
      cv = await CV();
      ok(Math.abs(cv.t1 - 1 / 3) < 1e-6 && Math.abs(cv.t2 - 2 / 3) < 1e-6 && await FM() === 'linear', 'teclado: Home volta ao linear (pontos na reta e formato linear)');
      provaMemoria = async () => {   // recarrega a página: roda no fim, para não derrubar o estado das provas seguintes
        // memória entre sessões: arrasta, recarrega, o personalizado volta
        // o que o arrasto gravou (formato personalizado + pontos) volta ao carregar a página
        await pg.avaliar(`localStorage.setItem('vbmx-friends-curva', JSON.stringify({ t1: 0.2, g1: 0.1, t2: 0.7, g2: 0.9 })); localStorage.setItem('vbmx-friends-formato', 'personalizado'); location.reload()`); await espera(1500);
        for (let i = 0; i < 50 && !(await pg.avaliar(`!!document.getElementById('fr-pt-1')`)); i++) await espera(100);
        ok(await pg.avaliar(`document.querySelector('#fr-formato .fr-fmt[data-f="personalizado"]').getAttribute('aria-checked') === 'true' && document.getElementById('fr-pt-1').getAttribute('aria-valuenow') === '20' && document.getElementById('fr-pt-2').getAttribute('aria-valuenow') === '70'`), 'memória: depois de recarregar o personalizado e os pontos (20 % e 70 %) voltam');
        // corrompido: formato personalizado + pontos inválidos → linear
        await pg.avaliar(`localStorage.setItem('vbmx-friends-curva', '{lixo'); localStorage.setItem('vbmx-friends-formato', 'personalizado'); location.reload()`); await espera(1500);
        for (let i = 0; i < 50 && !(await pg.avaliar(`!!document.getElementById('fr-pt-1')`)); i++) await espera(100);
        ok(await pg.avaliar(`document.querySelector('#fr-formato .fr-fmt[data-f="linear"]').getAttribute('aria-checked') === 'true'`), 'corrompido: pontos ilegíveis no localStorage voltam ao linear');
        await pg.avaliar(`localStorage.setItem('vbmx-friends-formato', 'potencia')`);
        await pg.avaliar(`localStorage.removeItem('vbmx-friends-curva'); location.reload()`); await espera(1500);
        for (let i = 0; i < 50 && !(await pg.avaliar(`!!document.getElementById('fr-pt-1')`)); i++) await espera(100);
      };
    }

    await pg.avaliar(`document.querySelector('#fr-formato .fr-fmt[data-f="potencia"]').click()`); await espera(450);

    // ---- 3b: a mixagem pinta o trecho da transição ----
    await pg.avaliar(`document.getElementById('fr-mixar').click()`);
    ok(await ate(pg.avaliar, `/mixando/.test(document.getElementById('seguir-quando').textContent)`, 8000), '"Mixar agora" começa a transição');
    ok(await pg.avaliar(`[...document.querySelectorAll('#fr-formato .fr-fmt')].every((b) => b.disabled)`), 'formato: durante a mixagem o seletor fica bloqueado');
    ok(await pg.avaliar(`localStorage.getItem('vbmx-friends-formato') === 'potencia'`), 'formato: a mixagem usa o formato escolhido antes (potência constante) e ele segue lembrado');
    await espera(1200);
    ok(await pg.avaliar(`document.getElementById('agora-ponto').getAttribute('aria-disabled') === 'true' && document.getElementById('agora-bola').getAttribute('aria-disabled') === 'true' && /bloqueado/.test(document.getElementById('agora-mixponto').textContent)`), 'na mixagem o triângulo e a bolinha ficam desabilitados (bloqueio visível)');
    {
      const gb = await pg.avaliar(GEO), pAntes = (await pg.avaliar(PONTO)).now;
      await pg.mouse('mousePressed', gb.ponto.x + gb.ponto.w / 2, gb.ponto.y + 28); await pg.mouse('mouseMoved', gb.fio.x + gb.fio.w * 0.2, gb.ponto.y + 28); await pg.mouse('mouseReleased', gb.fio.x + gb.fio.w * 0.2, gb.ponto.y + 28);
      ok((await pg.avaliar(PONTO)).now === pAntes || Math.abs((await pg.avaliar(PONTO)).now - pAntes) <= 2, 'arrastar o triângulo durante a mixagem não muda o ponto');
    }
    const px3 = await pg.avaliar(PIXELS);
    ok(px3.mix >= px3.h && Math.abs(px3.xMix - px3.xCabeca) < px3.w * 0.2, `na mixagem a marca vem para onde a transição começou de fato (marca x ${px3.xMix}, cabeça x ${px3.xCabeca})`);
    ok(await ate(pg.avaliar, `/Segunda do Link|Primeira do Link/.test(document.getElementById('agora-titulo').textContent) && !/mixando/.test(document.getElementById('seguir-quando').textContent)`, 60000), 'a transição termina e a onda passa a ser a da faixa seguinte');
    await espera(800);
    const px4 = await pg.avaliar(PIXELS);
    ok(px4.estado === 'pronta' && px4.resto > px4.w * 4 && px4.xCabeca < px4.w * 0.8, `depois da transição a onda é a da nova faixa, já calculada (${px4.estado})`);
    await pg.avaliar(`document.getElementById('fr-tocar').click()`);   // pausa

    // ---- 5: erros ----
    const antes = ts.pedidos.length;
    await trazer(pg, 'https://vimeo.com/123');
    await ate(pg.avaliar, `document.getElementById('ts-status').classList.contains('fr-ts-erro')`, 3000);
    t = await pg.avaliar(TELA);
    ok(t.erro && /YouTube/.test(t.status) && !t.ocupado && ts.pedidos.length === antes, `link inválido: mensagem na tela e nenhum pedido ("${t.status}")`);
    await trazer(pg, 'https://www.youtube.com/watch?v=falhadownld');
    ok(await ate(pg.avaliar, `/não está disponível/.test(document.getElementById('ts-status').textContent)`, 10000), 'falha de download: a mensagem do servidor aparece');
    t = await pg.avaliar(TELA);
    ok(t.erro && !t.ocupado && t.campo && t.biblioteca.length === 2 && t.link !== '', 'depois da falha o campo continua valendo, com o link ainda lá, e a biblioteca não mudou');
    ts.noAr = false;
    await trazer(pg, LINK_A);
    ok(await ate(pg.avaliar, `!document.getElementById('ts-dica').hidden`, 8000), 'servidor que cai: a dica aparece');
    t = await pg.avaliar(TELA);
    ok(!t.campo && t.dica && /\.\/tracksave\.sh servir/.test(t.dicaTexto), `a dica traz o comando (${t.dicaTexto.slice(0, 90)})`);
    if (provaMemoria) await provaMemoria();
    await pg.fechar();

    // servidor fora desde a carga
    const pgFora = await abrir(LOCAL + '/interface/friends.html', PRONTA, 360);
    await ate(pgFora.avaliar, `!document.getElementById('ts-dica').hidden`, 5000);
    t = await pgFora.avaliar(TELA);
    ok(t.secao && !t.campo && t.dica && !t.erro && /\.\/tracksave\.sh servir/.test(t.dicaTexto), 'servidor fora na carga: só a dica com o comando, sem mensagem de erro');
    ts.noAr = true;
    await pgFora.avaliar(`document.getElementById('ts-sondar').click()`);
    ok(await ate(pgFora.avaliar, `!document.getElementById('ts-form').hidden && document.getElementById('ts-dica').hidden`, 5000), '"tente de novo" com o servidor de volta: o campo aparece');
    await pgFora.fechar();

    // ---- 6: fora de localhost (a versão publicada) ----
    const nTs = ts.pedidos.length;
    const pgPub = await abrir(PAGES + '/interface/friends.html', PRONTA);
    await espera(1500);
    t = await pgPub.avaliar(TELA);
    ok(!t.secao && ts.pedidos.length === nTs, `na versão publicada o plugin não aparece e nenhum pedido vai ao servidor local (${ts.pedidos.length - nTs} pedidos)`);
    ok(await pgPub.avaliar(`(document.getElementById('agora-capa').getAttribute('src') || '').startsWith('data:image/svg+xml') && !document.getElementById('ts-capa-linha').offsetParent`) && ts.capas.every((q) => !/Sem Capa/.test(q)) && ts.pedidos.length === nTs, 'na versão publicada a capa é a padrão Bauhaus (data URI), sem interruptor e sem pedir nada');
    await pgPub.fechar();

    // ---- 7: o link só sai no POST /baixar ----
    ok(ts.corpos.length >= 3 && ts.corpos.every((b) => Object.keys(JSON.parse(b)).join() === 'url'), `o corpo do POST é só {url} (${ts.corpos.length} envios)`);
    ok(ts.pedidos.every((x) => /^GET \/capa\?id=bbbbbbbbbbb$/.test(x) || !/youtu|aaaaaaaaaaa|bbbbbbbbbbb/.test(x)), 'nenhum link em URL de pedido ao TrackSave (só o id do vídeo, de volta, em /capa?id=)');
    ok(outros.every((o) => !/youtu|aaaaaaaaaaa|bbbbbbbbbbb/.test(o.url + o.corpo)), `nenhum link enviado a terceiros (${outros.length} pedidos a outros hosts: ${[...new Set(outros.map((o) => new URL(o.url).host))].join(', ') || 'nenhum'})`);
    ok([...ts.origens].join() === LOCAL, `até aqui, todo pedido ao TrackSave saiu com a Origin ${LOCAL} (${[...ts.origens].join()})`);

    // ---- 6b: o Friends publicado (https://luksgodoy.github.io/vbmx-friends/), uso pessoal do Lucas ----
    {
      const PAG = PUB + '/vbmx-friends/interface/friends.html', n0 = ts.pedidos.length;
      let o = await abrir(PAG, PRONTA); await espera(1500);
      t = await o.avaliar(TELA);
      ok(!t.secao && ts.pedidos.length === n0, `publicada, sem ?tracksave=1: o plugin não aparece e nada vai a 127.0.0.1 (${ts.pedidos.length - n0} pedidos)`);
      await o.fechar();
      o = await abrir(PAG + '?tracksave=1', PRONTA);
      ok(await ate(o.avaliar, `!document.getElementById('ts-form').hidden`, 5000), 'publicada com ?tracksave=1 e o servidor no ar: o campo do link aparece');
      t = await o.avaliar(TELA);
      ok(t.secao && t.campo && !t.dica && !t.erro && !(await o.avaliar(`!!document.getElementById('ts-capa-linha').offsetParent`)), 'publicada: só o campo, sem dica, sem erro e sem o interruptor da capa');
      await trazer(o, LINK_A);
      ok(await ate(o.avaliar, `/entrou na biblioteca/.test(document.getElementById('ts-status').textContent)`, 30000), 'publicada: o link termina com "entrou na biblioteca": ' + (await o.avaliar(TELA)).status);
      t = await o.avaliar(TELA);
      ok(t.biblioteca.length === 1 && /Primeira do Link/.test(t.biblioteca[0]) && /124 · 8A/.test(t.biblioteca[0]), `publicada: a faixa está na biblioteca com BPM e tom (${t.biblioteca[0]})`);
      await o.avaliar(`document.getElementById('fr-tocar').click()`);
      ok(await ate(o.avaliar, `/Primeira do Link/.test(document.getElementById('agora-titulo').textContent) && document.querySelector('[data-fase]').dataset.fase === 'tocando'`, 15000), 'publicada: a faixa baixada toca no Friends (' + (await o.avaliar(`document.getElementById('agora-titulo').textContent + ' / ' + document.querySelector('[data-fase]').dataset.fase`)) + ')');
      ok([...ts.origens].includes(PUB), `os pedidos da publicada saíram com a Origin ${PUB}`);
      await o.fechar();
      ts.noAr = false;
      const n1 = ts.pedidos.length;
      o = await abrir(PAG, PRONTA); await espera(2500);
      t = await o.avaliar(TELA);
      ok(!t.secao && !t.erro && !t.status, `publicada, ligada (lembrada) mas com o servidor desligado: nada aparece, nem dica nem erro (seção ${t.secao}, status "${t.status}")`);
      await o.fechar();
      ts.noAr = true;
      o = await abrir(PAG + '?tracksave=0', PRONTA); await espera(1500);
      t = await o.avaliar(TELA);
      ok(!t.secao && ts.pedidos.length === n1, `?tracksave=0 desliga: sem seção e sem pedido (${ts.pedidos.length - n1})`);
      await o.fechar();
    }

    // ---- 8: as três páginas sem erro de script ----
    for (const rel of ['interface/classico.html', 'interface/index.html']) { const o = await abrir(`${LOCAL}/${rel}`, 'document.readyState === "complete"'); await espera(800); await o.fechar(); }
    ok(erros.length === 0, 'erros de script/console nas três páginas: ' + erros.slice(0, 4).join(' ‖ '));
  } catch (e) { falhas.push('a prova parou: ' + ((e && e.stack) || e)); }
  finally {
    try { if (c) c.fechar(); } catch (e) { /* já fechado */ }
    chrome.kill('SIGKILL');
    await espera(300);
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) { /* perfil temporário */ }
  }
  if (falhas.length && erros.length) console.error('  erros de script/console vistos: ' + erros.slice(0, 4).join(' ‖ '));
  if (falhas.length) { console.error(`✗ friends no Chrome: ${falhas.length} de ${feitas} falharam`); for (const f of falhas) console.error('  ✗ ' + f); process.exit(1); }
  console.log(`✓ friends no Chrome: ${feitas} conferências — link → TrackSave falso → biblioteca, onda com cabeça e marca da transição, 360/768/1440 px, erros e versão publicada sem pedido`);
})();
