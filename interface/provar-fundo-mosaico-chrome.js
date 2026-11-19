// Prova no Chrome headless (CDP) do MOCKUP do fundo em mosaico do Friends: docs/mockup-fundo-mosaico.html.
// NÃO é portão do ./testar.sh (precisa de Chrome). Foi escrita para o repositório a partir do roteiro registrado em
// docs/pendencias.md (a prova original, `provar.js`, vivia só no scratchpad de uma sessão) e serve de molde para o portão
// da implementação (interface/modos/friends-fundo.js tem o seu, em Node: testar-friends-fundo.js; o contraste por pixel
// de produção está em provar-friends-chrome.js).
//
// A página é aberta por file://, sem rede: todo http(s) é bloqueado e CONTADO (tem de ser 0). A prova cobre, para as
// três opções (A Deriva, B Pulso, C Compasso):
//   1. render a 360, 768 e 1440 px: fundo montado e desenhado, sem rolagem horizontal, sem erro de console, sem rede;
//   2. fase ∝ BPM: avanço de fase em 3 s a 60 e a 180 BPM, razão ~3 (a razão de cada opção é impressa);
//   3. pausado, aba oculta (simulada) e sem BPM (B, C) = 0 quadro; sem BPM a deriva (A) continua andando;
//   4. troca de faixa 124 → 138 BPM: fase monotônica, sem salto, andamento chega ao novo valor;
//   5. prefers-reduced-motion emulado: estático nas três (0 quadro, fase 0);
//   6. contraste por pixel, capa branca (pior caso), 360 e 1440 px: na C o texto tem pixels IDÊNTICOS com e sem o fundo
//      em 129 quadros (4 compassos a 1/8 de batida); em A e B o fundo atrás do texto mantém contraste >= 4,5:1 e a
//      queda de contraste é impressa (a prova mede o fundo com o texto escondido, para o serrilhado do texto não contar);
//   7. custo: fração de tempo da thread principal (CDP Performance.getMetrics) a 1440x900 tocando. É medida de HEADLESS
//      SEM GPU: o teto de 2% de CPU em Chrome real continua precisando de olho humano (docs/pendencias.md).
// Rodar: node interface/provar-fundo-mosaico-chrome.js        (~3 min; CHROME=... troca o executável)
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const RAIZ = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MOCKUP = 'file://' + path.join(RAIZ, 'docs', 'mockup-fundo-mosaico.html');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const OPCOES = ['A', 'B', 'C'], LARGURAS = [360, 768, 1440];

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

// Dentro da página: compara dois PNG (base64) nos retângulos dos blocos. modo 'identico' conta pixels diferentes;
// modo 'contraste' mede, nos pixels que o fundo mudou, o contraste do texto contra o fundo e a queda em relação ao sem-fundo.
const COMPARAR = `window.__comparar = async (a, b, rects, txt, modo) => {
  const ler = (b64) => new Promise((ok, no) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(i, 0, 0); ok(g.getImageData(0, 0, c.width, c.height)); }; i.onerror = no; i.src = 'data:image/png;base64,' + b64; });
  const [A, B] = await Promise.all([ler(a), ler(b)]);
  const lin = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
  const lum = (r, g, bl) => .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(bl);
  const LT = lum(txt[0], txt[1], txt[2]), cr = (L) => (Math.max(L, LT) + .05) / (Math.min(L, LT) + .05);
  let difer = 0, total = 0, maxD = 0, grandes = 0, minC = 99, queda = 0, bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
  for (const r of rects) {
    const x0 = Math.max(0, Math.ceil(r.x) + 1), y0 = Math.max(0, Math.ceil(r.y) + 1), x1 = Math.min(A.width, Math.floor(r.x + r.w) - 1), y1 = Math.min(A.height, Math.floor(r.y + r.h) - 1);   // 1 px para dentro: a borda fracionária da caixa não é do bloco
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * A.width + x) * 4; total++;
      if (A.data[i] === B.data[i] && A.data[i + 1] === B.data[i + 1] && A.data[i + 2] === B.data[i + 2]) continue;
      if (modo === 'contraste' && Math.max(A.data[i], A.data[i + 1], A.data[i + 2]) > 40) continue;   // só onde a página sem fundo era fundo (escuro): borda de elemento que mudou 1 px de lugar não conta
      const dd = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2])); if (dd > 8) grandes++;
      maxD = Math.max(maxD, Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
      difer++; bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
      if (modo === 'contraste') {
        const ca = cr(lum(A.data[i], A.data[i + 1], A.data[i + 2])), cb = cr(lum(B.data[i], B.data[i + 1], B.data[i + 2]));
        minC = Math.min(minC, cb); queda = Math.max(queda, ca - cb);   // A = sem fundo, B = com fundo
      }
    }
  }
  return { difer, total, maxD, grandes, minC, queda, caixa: [bx0, by0, bx1, by1] };
};`;

(async () => {
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'vbmx-mosaico-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + perfil, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--lang=pt-BR', 'about:blank'], { stdio: 'ignore' });
  let c = null;
  const falhas = [], info = [], erros = [], rede = [];
  let feitas = 0, pagina = '';
  const ok = (cond, texto) => { feitas += 1; if (!cond) falhas.push(texto); };
  const dizer = (t) => info.push(t);
  try {
    const [p, caminho] = (await esperarArquivo(path.join(perfil, 'DevToolsActivePort'), 20000)).trim().split('\n');
    c = cdp(`ws://127.0.0.1:${p}${caminho}`);
    await c.pronto;
    c.aoEvento((m) => {
      if (m.method === 'Runtime.exceptionThrown') erros.push(`${pagina}: ${(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text || '').slice(0, 200)}`);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') erros.push(`${pagina}: console.error ${JSON.stringify(m.params.args.map((a) => a.value || a.description)).slice(0, 200)}`);
      if (m.method === 'Network.requestWillBeSent' && /^(https?|wss?):/.test(m.params.request.url)) rede.push(`${pagina}: ${m.params.request.url}`);
    });

    // abre o mockup com o estado dado no hash (todas as chaves, para cada caso nascer limpo)
    const abrir = async (est, largura, opts) => {
      opts = opts || {};
      const e = Object.assign({ op: 'C', estado: 'tocando', bpm: 124, sem: '0', capa: 'branca', larg: 'livre' }, est);
      pagina = `${e.op} ${largura}px ${e.estado} ${e.bpm}bpm${e.sem === '1' ? ' sem-bpm' : ''}`;
      const { targetId } = await c.enviar('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await c.enviar('Target.attachToTarget', { targetId, flatten: true });
      const env = (m, pr) => c.enviar(m, pr, sessionId);
      const avaliar = async (expr) => {
        const r = await env('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
      };
      await env('Emulation.setDeviceMetricsOverride', { width: largura, height: 900, deviceScaleFactor: 1, mobile: false });
      if (opts.reduzido) await env('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await env('Page.enable'); await env('Runtime.enable'); await env('Network.enable'); await env('Performance.enable');
      await env('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
      await env('Page.addScriptToEvaluateOnNewDocument', { source: COMPARAR });
      const hash = Object.keys(e).map((k) => k + '=' + e[k]).join('&');
      await env('Page.navigate', { url: MOCKUP + '#' + hash });
      for (let i = 0; i < 100 && !(await avaliar('document.readyState === "complete" && typeof window.__fundo === "function"')); i++) await espera(100);
      await espera(300);
      return { avaliar, env, fechar: () => c.enviar('Target.closeTarget', { targetId }), estado: () => avaliar('window.__fundo()'),
        foto: async () => (await env('Page.captureScreenshot', { format: 'png' })).data };
    };

    // ---- 1: render a 360/768/1440, sem rolagem horizontal, sem erro, sem rede ----
    for (const op of OPCOES) for (const w of LARGURAS) {
      const pg = await abrir({ op, larg: String(w) }, w);
      const r = await pg.avaliar(`(() => { const d = document.documentElement, f = document.getElementById('fundo'), op = document.querySelector('.f-op[data-f="${op}"]');
        const cv = document.getElementById('tela-b'); let pix = 0;
        if (${op === 'B' ? 'true' : 'false'}) { const dd = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < dd.length; i += 4) if (dd[i]) pix++; }
        return { rolagem: d.scrollWidth - d.clientWidth, palco: document.getElementById('palco').scrollWidth - document.getElementById('palco').clientWidth,
          fundo: f.clientWidth > 0 && f.clientHeight > 0, visivel: getComputedStyle(op).display !== 'none', filhos: op.children.length, pix, celulas: window.__fundo().celulas }; })()`);
      ok(r.rolagem <= 0 && r.palco <= 0, `${op} a ${w}px: sem rolagem horizontal (página ${r.rolagem}, palco ${r.palco})`);
      ok(r.fundo && r.visivel && r.filhos > 0, `${op} a ${w}px: fundo montado e visível`);
      if (op === 'B') ok(r.celulas > 0 && r.pix > 0, `B a ${w}px: grade desenhada (${r.celulas} células, ${r.pix} pixels no canvas)`);
      await pg.fechar();
    }

    // ---- 2: fase ∝ BPM ----
    const razoes = {};
    for (const op of OPCOES) {
      const av = {};
      for (const bpm of [60, 180]) {
        const pg = await abrir({ op, bpm }, 1440);
        await espera(4000);                                    // o andamento chega em ~1,5 s
        const f0 = (await pg.estado()).fase; await espera(3000); const f1 = (await pg.estado()).fase;
        av[bpm] = f1 - f0; await pg.fechar();
      }
      razoes[op] = av[180] / av[60];
      ok(razoes[op] > 2.5 && razoes[op] < 3.5, `${op}: avanço de fase em 3 s de 60 para 180 BPM ~3x (${av[60].toFixed(2)} → ${av[180].toFixed(2)} batidas, razão ${razoes[op].toFixed(2)})`);
    }
    dizer('razão de fase 180/60 BPM: ' + OPCOES.map((o) => `${o} ${razoes[o].toFixed(2)}`).join(' · '));

    // ---- 3: pausado, aba oculta, sem BPM ----
    for (const op of OPCOES) {
      let pg = await abrir({ op, estado: 'pausado' }, 1440);
      await espera(1500); let a = await pg.estado(); await espera(1500); let b = await pg.estado();
      ok(b.quadros === a.quadros && !b.rodando, `${op} pausado: 0 quadro em 1,5 s (rodando=${b.rodando})`); await pg.fechar();

      pg = await abrir({ op }, 1440);
      await espera(800);
      await pg.avaliar(`(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); })()`);
      await espera(300); a = await pg.estado(); await espera(1500); b = await pg.estado();
      ok(b.quadros === a.quadros && !b.rodando, `${op} com a aba oculta (simulada): 0 quadro em 1,5 s`);
      await pg.avaliar(`(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); })()`);
      await espera(1000); const c2 = await pg.estado();
      ok(c2.quadros > b.quadros, `${op}: ao voltar à aba o fundo volta a andar (${b.quadros} → ${c2.quadros} quadros)`); await pg.fechar();

      pg = await abrir({ op, sem: '1' }, 1440);
      await espera(2000); a = await pg.estado(); await espera(2000); b = await pg.estado();
      if (op === 'A') ok(b.fase > a.fase, `A sem BPM: a deriva lenta continua (fase ${a.fase.toFixed(2)} → ${b.fase.toFixed(2)})`);
      else ok(b.quadros - a.quadros <= 1 && b.fase === a.fase, `${op} sem BPM: fundo parado (${b.quadros - a.quadros} quadros, fase ${a.fase.toFixed(2)} → ${b.fase.toFixed(2)})`);
      await pg.fechar();
    }

    // ---- 4: troca de faixa 124 → 138 BPM, fase contínua ----
    for (const op of OPCOES) {
      const pg = await abrir({ op, bpm: 124 }, 1440);
      await espera(2500);
      await pg.avaliar(`document.getElementById('trocar').click()`);
      const amostras = [];
      for (let i = 0; i < 55; i++) { const s = await pg.estado(); amostras.push({ f: s.fase, b: s.bpmEf }); await espera(200); }
      let mono = true, salto = 0;
      for (let i = 1; i < amostras.length; i++) { const d = amostras[i].f - amostras[i - 1].f; if (d < -1e-6) mono = false; salto = Math.max(salto, d); }
      const fim = amostras[amostras.length - 1].b, pico = Math.max(...amostras.map((x) => x.b));
      ok(mono, `${op}: a fase nunca recua na troca de faixa`);
      ok(salto < 1.2, `${op}: sem salto de fase na troca (maior passo em ~0,2 s: ${salto.toFixed(2)} batida)`);
      ok(Math.abs(fim - 138) < 2 && pico < 139, `${op}: o andamento chega a 138 sem passar (${fim.toFixed(1)}, pico ${pico.toFixed(1)})`);
      await pg.fechar();
    }

    // ---- 5: prefers-reduced-motion emulado ----
    for (const op of OPCOES) {
      const pg = await abrir({ op }, 1440, { reduzido: true });
      await espera(500); const a = await pg.estado(); await espera(2000); const b = await pg.estado();
      ok(b.reduzido && b.quadros === a.quadros && !b.rodando && b.fase === 0, `${op} com movimento reduzido: estático (reduzido=${b.reduzido}, ${b.quadros - a.quadros} quadros, fase ${b.fase})`);
      await pg.fechar();
    }

    // ---- 6: contraste por pixel, capa branca (pior caso) ----
    const RETS = `(() => [...document.querySelectorAll('.fr-topo, .fr-agora, .fr-seguir, .fr-controles, .fr-listas')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }))()`;
    const TXT = `(() => getComputedStyle(document.querySelector('.fr-titulo')).color.match(/\\d+/g).slice(0, 3).map(Number))()`;
    for (const w of [1440, 360]) {
      for (const op of OPCOES) {
        const passo = op === 'C' ? .125 : .25, n = Math.round(16 / passo) + 1;
        // C: texto visível, pixel a pixel contra a página sem fundo. A e B: fundo isolado (texto transparente) contra o sem-fundo.
        const pg = await abrir({ op, estado: 'pausado', capa: 'branca', larg: String(w) }, w);
        await espera(700);
        const txt = await pg.avaliar(TXT);   // a cor do texto é lida ANTES de escondê-lo
        await pg.avaliar(`(() => { const s = document.createElement('style'); s.id = 'prova-css'; s.textContent = ${JSON.stringify(op === 'C' ? '' : '.friends *, .fr-topo * { color: transparent !important; text-shadow: none !important; }')}; document.head.appendChild(s); })()`);
        const rects = await pg.avaliar(RETS);
        await pg.avaliar(`(() => { document.getElementById('fundo').style.visibility = 'hidden'; })()`);
        await pg.avaliar(`window.__fundoFase(0)`); await espera(150);
        const sem = await pg.foto();
        await pg.avaliar(`(() => { document.getElementById('fundo').style.visibility = ''; })()`);
        let difMax = 0, deltaMax = 0, vazou = 0, grandesMax = 0, base0 = null, minC = 99, queda = 0, quadros = 0, pixTot = 0;
        for (let i = 0; i < n; i++) {
          await pg.avaliar(`window.__fundoFase(${i * passo})`); await espera(60);
          const com = await pg.foto();
          const r = await pg.avaliar(`window.__comparar(${JSON.stringify(sem)}, ${JSON.stringify(com)}, ${JSON.stringify(rects)}, ${JSON.stringify(txt)}, ${JSON.stringify(op === 'C' ? 'identico' : 'contraste')})`);
          quadros++; difMax = Math.max(difMax, r.difer); deltaMax = Math.max(deltaMax, r.maxD); grandesMax = Math.max(grandesMax, r.grandes);
          if (op === 'C') { if (!base0) base0 = com; else vazou = Math.max(vazou, (await pg.avaliar(`window.__comparar(${JSON.stringify(base0)}, ${JSON.stringify(com)}, ${JSON.stringify(rects)}, ${JSON.stringify(txt)}, 'identico')`)).difer); } minC = Math.min(minC, r.minC); queda = Math.max(queda, r.queda); pixTot = r.total;
        }
        if (op === 'C') {
          // dois testes. (a) VAZAMENTO: cada quadro do compasso, DENTRO dos blocos, igual ao quadro 0 (a máscara opaca esconde o mosaico: 0 pixel de diferença).
          // (b) contra a página sem fundo: pixels com diferença > 8/255 são só 1 px de serrilhado de borda de texto que o Chrome desloca entre
          // duas renderizações (medido: o mesmo no quadro 0 e no 64, não depende da fase); passam de 1% dos pixels dos blocos = vazamento.
          ok(vazou === 0 && quadros === 129, `C a ${w}px, capa branca: dentro dos blocos os ${quadros} quadros do compasso são idênticos ao quadro 0 (${vazou} pixels diferentes no pior quadro)`);
          ok(grandesMax <= pixTot * 0.01, `C a ${w}px, capa branca: contra a página sem fundo, ${grandesMax} de ${pixTot} pixels mudam > 8/255 (teto 1%)`);
          dizer(`C a ${w}px: ${quadros} quadros, vazamento ${vazou} px; contra o sem-fundo ${grandesMax}/${pixTot} px > 8/255, maior diferença ${deltaMax}/255`);
        }
        else {
          ok(minC >= 4.5, `${op} a ${w}px, capa branca: pior contraste do texto sobre o fundo ${minC === 99 ? 'sem pixel alterado' : minC.toFixed(2)}:1 >= 4,5 em ${quadros} quadros`);
          dizer(`${op} a ${w}px: queda máxima de contraste ${queda.toFixed(2)}, pior ${minC === 99 ? '—' : minC.toFixed(2)}:1`);
        }
        await pg.fechar();
      }
    }

    // ---- 7: custo na thread principal (headless, sem GPU) ----
    for (const op of OPCOES) {
      const pg = await abrir({ op }, 1440);
      await espera(2500);
      const lerM = async () => { const m = (await pg.env('Performance.getMetrics')).metrics, g = (n) => (m.find((x) => x.name === n) || {}).value || 0; return { t: g('Timestamp'), tarefa: g('TaskDuration'), script: g('ScriptDuration') }; };
      const a = await lerM(); await espera(6000); const b = await lerM();
      const pct = (b.tarefa - a.tarefa) / (b.t - a.t) * 100;
      ok(pct < 5, `${op}: thread principal ${pct.toFixed(2)}% em 6 s a 1440x900, tocando (teto da prova headless: 5%)`);
      dizer(`${op}: thread principal ${pct.toFixed(2)}% (headless sem GPU; o teto de 2% do Chrome real não é medido aqui)`);
      await pg.fechar();
    }

    ok(erros.length === 0, 'erros de script/console: ' + erros.slice(0, 3).join(' ‖ '));
    ok(rede.length === 0, `nenhum pedido de rede (${rede.length}): ${rede.slice(0, 3).join(' ‖ ')}`);
  } catch (e) { falhas.push('a prova parou: ' + ((e && e.stack) || e)); }
  finally {
    try { if (c) c.fechar(); } catch (e) { /* já fechado */ }
    chrome.kill('SIGKILL');
    await espera(300);
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) { /* perfil temporário */ }
  }
  for (const t of info) console.log('  · ' + t);
  if (falhas.length) { console.error(`✗ mockup do fundo em mosaico no Chrome: ${falhas.length} de ${feitas} falharam`); for (const f of falhas) console.error('  ✗ ' + f); process.exit(1); }
  console.log(`✓ mockup do fundo em mosaico no Chrome: ${feitas} conferências — render 360/768/1440, fase ∝ BPM, pausa/aba oculta/sem BPM, troca de faixa, movimento reduzido, contraste por pixel e custo (headless)`);
})();
