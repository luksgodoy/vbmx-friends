// VbMx Friends — plugin TrackSave: do link do YouTube à faixa na biblioteca. Sem DOM.
//
// O TrackSave é outro projeto (~/TrackSave), com um servidor local opcional: `./tracksave.sh servir` em
// http://127.0.0.1:8771. Contrato dele (lido, não copiado): ~/TrackSave/docs/plugin-vbmx.md. Aqui só o cliente:
//   GET /saude → POST /baixar {url} → GET /status/<id> (a cada ~1 s) → GET /faixa/<id> + GET /audio/<id>
// e depois a faixa entra na fila de análise que a biblioteca já usa (VbMxPainel.adicionar → analisarFila).
//
// Regras que este arquivo guarda (docs/contratos.md § Friends: plugin TrackSave):
//  - o servidor só aceita as Origins http://127.0.0.1:8770 e https://luksgodoy.github.io (o Friends publicado, uso
//    pessoal do Lucas, decisão de 19/11/2026); fora delas (outro site, localhost:8770, outra porta) NENHUM pedido é
//    feito — `ondeEstou` decide antes de qualquer fetch;
//  - na versão publicada o plugin só sonda na máquina que o ligou (`?tracksave=1`, lembrado pela tela; `?tracksave=0`
//    desliga): o navegador de um amigo nunca pede nada a 127.0.0.1 (nem vê o aviso de "rede local" do Chrome), e
//    servidor fora ou recusando lá é invisível (fase 'oculto'), sem dica nem erro;
//  - servidor desligado não é erro: `sondar` devolve {noAr: false} e nunca lança;
//  - o link do usuário só viaja no corpo do POST /baixar, para 127.0.0.1: não vai para log, armazenamento local,
//    URL nem terceiro;
//  - servidor remoto (celular, túnel https do ngrok até o TrackSave do Mac; decisão de 19/11/2026, a confirmar pelo
//    Lucas): o link de `./tracksave.sh link` traz `#ts=<url do túnel>&k=<chave>` no fragmento. `lerRemoto` só aceita
//    url https (ou http de loopback) e chave no formato do token_urlsafe(32); com remoto, TODO pedido (saúde, baixar,
//    andamento, faixa, áudio) vai para essa base com `Authorization: Bearer <chave>` e `ngrok-skip-browser-warning: 1`.
//    A chave só existe no cabeçalho: nunca na URL do pedido, no estado devolvido, em mensagem ou no console. Guardar
//    no localStorage e tirar o fragmento da barra é da tela (friends-tela.js); este arquivo não toca o navegador.
// Teste: node interface/testar-friends-tracksave.js (servidor TrackSave falso em Node; nada é baixado de verdade).
//
// VbMxTrackSave:
//   ondeEstou(location) → 'local' | 'publicada' | 'origem-errada' | 'fora'
//   pedidoNaUrl(search) → '1' | '0' | null  (o ?tracksave= da URL)
//   liberar(onde, ligadoNestaMaquina) → 'publicada' só se ligado; senão 'fora'
//   validarLink(texto) → {ok: true, url} | {ok: false, mensagem}
//   lerRemoto(hash) → null (sem ts/k no fragmento) | {ok: true, url, chave} | {ok: false, motivo}
//   validarRemoto({url, chave}) → {ok: true, url, chave} | {ok: false, motivo}   (o que veio do localStorage passa por aqui)
//   criar({fetch?, base?, remoto?: {url, chave}, espera?, intervaloMs?, limiteSondaMs?, limiteEsperaMs?, agora?}) →
//     {sondar(), baixar(link, aoAndar?), base, remoto}
//   criarFluxo({cliente, painel: {adicionar(pasta), faixas(), ocupado()}, onde, remoto?, aoEstado?, espera?}) →
//     {iniciar(), sondar(), trazer(link), vestir(faixas), estado()}
//   aplicarMeta(faixas, metaPorCaminho) → faixas com titulo/artista/ano do TrackSave
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxTrackSave = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';

  const BASE = 'http://127.0.0.1:8771';
  const ORIGEM = 'http://127.0.0.1:8770';     // a local que o servidor aceita (ORIGENS_PERMITIDAS do TrackSave)
  const ORIGEM_PUBLICADA = 'https://luksgodoy.github.io';   // o Friends no GitHub Pages; Origin exata, sem curinga
  const COMANDO = './tracksave.sh servir';
  const PASTA = 'TrackSave';                  // o nome da "pasta" em que as faixas trazidas aparecem na biblioteca
  const TERMINAIS = ['pronto', 'falhou', 'nao-casou'];
  const RX_ID = /^[0-9a-f]{16}$/;             // o id que o servidor gera; qualquer outra coisa não vai para a URL
  const RX_VIDEO = /^[A-Za-z0-9_-]{11}$/;
  const HOSTS_LOCAIS = ['127.0.0.1', 'localhost', '[::1]', '::1'];
  const RX_CHAVE = /^[A-Za-z0-9_-]{43,128}$/;  // secrets.token_urlsafe(32) do TrackSave (remoto._RE_CHAVE)
  // texto pelo idioma (interface/js/i18n.js): no navegador é o VbMxI18n da página; no Node, o módulo, que cai em pt-BR.
  // A mensagem é montada quando o evento acontece: a já exibida fica no idioma antigo até o evento seguinte.
  const I18N = raiz.VbMxI18n || (typeof require === 'function' ? require('../js/i18n.js') : null);
  const tr = (chave, params) => (I18N ? I18N.t(chave, params) : chave);
  const brNum = (v) => (I18N ? I18N.numero(v, 1) : String(v));

  function erro(codigo, mensagem) { const e = new Error(mensagem); e.codigo = codigo; e.mensagem = mensagem; return e; }
  const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

  function ondeEstou(loc) {
    const l = loc || {};
    if (l.origin === ORIGEM) return 'local';
    if (l.origin === ORIGEM_PUBLICADA) return 'publicada';
    return HOSTS_LOCAIS.includes(String(l.hostname || '')) ? 'origem-errada' : 'fora';
  }
  function pedidoNaUrl(search) {
    const m = /[?&]tracksave=([01])(?:&|#|$)/.exec(String(search || ''));
    return m ? m[1] : null;
  }
  // Na versão publicada o plugin só existe na máquina que o ligou; nas demais é como se fosse outro site.
  const liberar = (onde, ligado) => (onde === 'publicada' && !ligado ? 'fora' : onde);

  // O servidor remoto: só https (o Pages é https e não chama http, e a chave não pode viajar em claro) ou http de
  // loopback (teste nesta máquina). Sem usuário/senha, query nem fragmento na base. A mensagem nunca leva a chave.
  function validarRemoto(r) {
    const o = r || {};
    const chave = String(o.chave == null ? '' : o.chave);
    if (!RX_CHAVE.test(chave)) return { ok: false, motivo: 'chave-invalida' };
    let u;
    try { u = new URL(String(o.url == null ? '' : o.url)); } catch (e) { return { ok: false, motivo: 'url-invalida' }; }
    const loop = HOSTS_LOCAIS.includes(u.hostname.toLowerCase());
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loop))) return { ok: false, motivo: 'url-insegura' };
    if (u.username || u.password || u.search || u.hash) return { ok: false, motivo: 'url-invalida' };
    return { ok: true, url: (u.origin + u.pathname).replace(/\/+$/, ''), chave };
  }
  // `#ts=<url codificada>&k=<chave>` (remoto.link_celular do TrackSave). null = o fragmento não fala de servidor.
  function lerRemoto(hash) {
    const h = String(hash || '').replace(/^#/, '');
    if (!h) return null;
    let q;
    try { q = new URLSearchParams(h); } catch (e) { return null; }
    if (!q.has('ts') && !q.has('k')) return null;
    return validarRemoto({ url: q.get('ts'), chave: q.get('k') });
  }

  // Só vídeo do YouTube (o que este campo promete). O servidor classifica de novo; aqui é para não gastar um pedido
  // com o que já se sabe que não serve, e para a mensagem sair na hora.
  function validarLink(texto) {
    const t = String(texto == null ? '' : texto).trim();
    const dica = tr('ts.dica-link');
    if (!t) return { ok: false, mensagem: dica };
    if (t.length > 2048) return { ok: false, mensagem: tr('ts.link-longo') };
    let u;
    try { u = new URL(t); } catch (e) { return { ok: false, mensagem: tr('ts.nao-link', { dica }) }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, mensagem: tr('ts.nao-web', { dica }) };
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    const partes = u.pathname.split('/').filter(Boolean);
    let video = null;
    if (host === 'youtu.be') video = partes[0];
    else if (host === 'youtube.com') {
      if (partes[0] === 'watch') video = u.searchParams.get('v');
      else if (partes[0] === 'shorts' || partes[0] === 'live' || partes[0] === 'embed') video = partes[1];
      else if (partes[0] === 'playlist') return { ok: false, mensagem: tr('ts.playlist') };
    } else return { ok: false, mensagem: tr('ts.so-youtube', { dica }) };
    if (!video || !RX_VIDEO.test(video)) return { ok: false, mensagem: tr('ts.sem-video', { dica }) };
    return { ok: true, url: t };
  }

  // O id do vídeo do YouTube (11 caracteres) que o /faixa traz em origem.youtube_url / fonte.url; '' se não houver.
  function idVideo(meta) {
    const o = (meta && meta.origem) || {}, fo = (meta && meta.fonte) || {};
    for (const t of [o.youtube_url, fo.url, o.url]) {
      const r = validarLink(t);
      if (!r.ok) continue;
      const u = new URL(r.url), p = u.pathname.split('/').filter(Boolean);
      const v = u.hostname.toLowerCase() === 'youtu.be' ? p[0] : u.searchParams.get('v') || p[1];
      if (v && RX_VIDEO.test(v)) return v;
    }
    return '';
  }

  function criar(deps) {
    const d = deps || {};
    const f = d.fetch || (typeof raiz.fetch === 'function' ? raiz.fetch.bind(raiz) : null);
    if (!f) throw new TypeError('VbMxTrackSave.criar: sem fetch');
    let rem = null;
    if (d.remoto) {
      const v = validarRemoto(d.remoto);
      if (!v.ok) throw new TypeError('VbMxTrackSave.criar: servidor remoto inválido (' + v.motivo + ')');
      rem = v;
    }
    const base = rem ? rem.url : String(d.base || BASE).replace(/\/+$/, '');
    // a chave fica só nesta closure: vai no cabeçalho de todo pedido e em nenhum outro lugar
    const cabecalhos = (extra) => Object.assign({}, extra || {}, rem ? { Authorization: 'Bearer ' + rem.chave, 'ngrok-skip-browser-warning': '1' } : {});
    const espera = typeof d.espera === 'function' ? d.espera : dormir;
    const agora = typeof d.agora === 'function' ? d.agora : () => Date.now();
    const intervaloMs = d.intervaloMs >= 0 ? d.intervaloMs : 1000;
    const limiteSondaMs = d.limiteSondaMs > 0 ? d.limiteSondaMs : rem ? 6000 : 1500;   // o túnel tem a volta da internet
    const limiteEsperaMs = d.limiteEsperaMs > 0 ? d.limiteEsperaMs : 20 * 60 * 1000;
    const msgFora = () => (rem ? tr('ts.remoto-fora') : tr('ts.servidor-fora', { comando: COMANDO }));

    async function pedir(caminho, init) {
      const i = Object.assign({ cache: 'no-store' }, init || {});
      i.headers = cabecalhos(i.headers);
      try { return await f(base + caminho, i); }
      catch (e) { throw erro('servidor-fora', msgFora()); }
    }
    async function json(r) {
      let j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      if (!r.ok) {
        if (rem && r.status === 401) throw erro('nao-autorizado', tr('ts.remoto-recusou'));
        if (rem && r.status === 429) throw erro('muitas-tentativas', tr('ts.remoto-limite'));
        const e = j && j.erro;
        throw erro((e && e.codigo) || 'http-' + r.status, (e && e.mensagem) || tr('ts.http', { status: r.status }));
      }
      if (!j || typeof j !== 'object') throw erro('resposta-invalida', tr('ts.resposta-estranha'));
      return j;
    }

    // Sonda leve: um GET /saude com prazo curto. Nunca lança; servidor fora é o caso normal.
    async function sondar() {
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const prazo = ac ? setTimeout(() => ac.abort(), limiteSondaMs) : null;
      try {
        const r = await f(base + '/saude', { cache: 'no-store', headers: cabecalhos(), signal: ac ? ac.signal : undefined });
        if (r.status === 403 || r.status === 401) return { noAr: false, motivo: 'recusado' };
        if (r.status === 429) return { noAr: false, motivo: 'limite' };
        // a tela de aviso do ngrok grátis (HTML, sem CORS) ou outro serviço: cai aqui ou no catch, nunca lança
        const j = r.ok ? await r.json().catch(() => null) : null;
        if (j && j.servico === 'tracksave') return { noAr: true, versao: j.versao, ytDlp: j.yt_dlp || null, ffmpeg: j.ffmpeg !== false };
        return { noAr: false, motivo: 'outro-servico' };
      } catch (e) { return { noAr: false, motivo: 'fora' }; }
      finally { if (prazo) clearTimeout(prazo); }
    }

    // → o item no formato da fila de análise da biblioteca ({caminho, nome, tamanho, data, obter}) + `meta`.
    async function baixar(link, aoAndar) {
      const v = validarLink(link);
      if (!v.ok) throw erro('link-invalido', v.mensagem);
      const andar = (s) => { if (typeof aoAndar === 'function') aoAndar({ estado: s.estado, fracao: typeof s.fracao === 'number' ? s.fracao : null, mensagem: s.mensagem || '' }); };
      const pedido = await json(await pedir('/baixar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: v.url }) }));
      if (!RX_ID.test(String(pedido.id))) throw erro('resposta-invalida', tr('ts.id-estranho'));
      if (pedido.tipo && pedido.tipo !== 'faixa') throw erro('tipo-nao-suportado', tr('ts.playlist-aqui'));
      const id = pedido.id;
      let s = pedido;
      andar(s);
      const inicio = agora();
      while (!TERMINAIS.includes(s.estado)) {
        if (agora() - inicio > limiteEsperaMs) throw erro('tempo-esgotado', tr('ts.demorou'));
        await espera(intervaloMs);
        s = await json(await pedir('/status/' + id));
        andar(s);
      }
      if (s.estado !== 'pronto') throw erro((s.erro && s.erro.codigo) || s.estado, (s.erro && s.erro.mensagem) || tr('ts.nao-baixou'));
      const meta = await json(await pedir('/faixa/' + id));
      const r = await pedir('/audio/' + id);
      if (!r.ok) await json(r);
      let blob;
      try { blob = await r.blob(); } catch (e) { throw erro('servidor-fora', tr('ts.audio-incompleto')); }
      if (!blob || !blob.size) throw erro('audio-vazio', tr('ts.audio-vazio'));
      const arq = meta.arquivo || {};
      const nome = String(arq.nome || (meta.titulo || id) + '.mp3').replace(/[\\/]/g, '_');
      return { caminho: `tracksave/${id}/${nome}`, nome, tamanho: typeof arq.bytes === 'number' ? arq.bytes : blob.size,
        data: typeof arq.modificado_ms === 'number' ? arq.modificado_ms : 0, obter: async () => blob,
        meta: { titulo: meta.titulo ? String(meta.titulo) : '', artista: meta.artista ? String(meta.artista) : '', ano: meta.ano || null, tracksave_id: id, video_id: idVideo(meta) } };
    }

    return { sondar, baixar, base, remoto: !!rem };
  }

  // O título e o artista do /faixa valem mais que os tirados do nome do arquivo (vídeo do YouTube não tem
  // "Artista - Título"). Não altera as faixas que recebe.
  function aplicarMeta(faixas, metaPorCaminho) {
    const mapa = metaPorCaminho || new Map();
    return (faixas || []).map((x) => {
      const m = mapa.get(x.caminho);
      if (!m) return x;
      const y = Object.assign({}, x, { origem: 'tracksave', tracksave_id: m.tracksave_id });
      if (m.video_id) y.video_id = m.video_id;
      if (m.titulo) y.titulo = m.titulo;
      if (m.artista) y.artista = m.artista;
      if (m.ano) y.ano = m.ano;
      return y;
    });
  }

  // A máquina de estados que a tela desenha. fase: 'oculto' (fora de localhost: nada aparece, nada é pedido; na
  // publicada, também enquanto sonda e quando o servidor não atende) | 'origem' (em localhost mas não em
  // 127.0.0.1:8770) | 'sondando' | 'fora' (servidor desligado: dica) | 'pronto' | 'baixando' | 'analisando' | 'feito' |
  // 'erro'. Em 'feito' e 'erro' o campo continua valendo (noAr = true).
  function criarFluxo(deps) {
    const d = deps || {};
    if (!d.cliente || !d.painel) throw new TypeError('VbMxTrackSave.criarFluxo: cliente e painel são obrigatórios');
    const espera = typeof d.espera === 'function' ? d.espera : dormir;
    const itens = [];            // tudo que veio nesta sessão (a "pasta" TrackSave é reposta inteira a cada faixa)
    const metas = new Map();     // caminho → meta
    let st = { fase: 'oculto', noAr: false, ocupado: false, mensagem: '', fracao: null, codigo: '' };
    const mudar = (novo) => { st = Object.assign({}, st, novo); if (typeof d.aoEstado === 'function') d.aoEstado(estado()); };
    const estado = () => Object.assign({ comando: COMANDO, origem: ORIGEM, remoto: !!d.remoto }, st);

    const sondavel = () => d.onde === 'local' || d.onde === 'publicada';
    async function sondar() {
      if (!sondavel() || st.ocupado) return estado();
      // remoto: o Lucas configurou este servidor de propósito, então a seção aparece (procurando, fora, recusado) com
      // o "tente de novo" e o "Esquecer servidor"; sem remoto, a publicada continua invisível sem servidor
      const pub = d.onde === 'publicada' && !d.remoto;
      // na publicada nada aparece antes de o servidor responder: quem não o tem não vê nem o "procurando"
      mudar(pub ? { fase: st.noAr ? 'sondando' : 'oculto', mensagem: '', codigo: '' } : { fase: 'sondando', mensagem: '', codigo: '' });
      const r = await d.cliente.sondar();
      if (r.noAr) mudar({ fase: 'pronto', noAr: true, mensagem: '' });
      else if (pub) mudar({ fase: 'oculto', noAr: false, mensagem: '' });
      else if (d.remoto) mudar({ fase: 'fora', noAr: false, mensagem: tr(r.motivo === 'recusado' ? 'ts.remoto-recusou' : r.motivo === 'limite' ? 'ts.remoto-limite' : 'ts.remoto-fora') });
      else if (r.motivo === 'recusado') mudar({ fase: 'origem', noAr: false, mensagem: tr('ts.recusou', { origem: ORIGEM }) });
      else mudar({ fase: 'fora', noAr: false, mensagem: '' });
      return estado();
    }
    function iniciar() {
      if (sondavel()) return sondar();
      if (d.onde === 'origem-errada') mudar({ fase: 'origem', noAr: false, mensagem: tr('ts.so-origem', { origem: ORIGEM }) });
      else mudar({ fase: 'oculto', noAr: false });
      return Promise.resolve(estado());
    }

    async function trazer(link) {
      if (st.ocupado || !st.noAr) return estado();
      mudar({ fase: 'baixando', ocupado: true, mensagem: tr('ts.pedindo'), fracao: null, codigo: '' });
      try {
        const item = await d.cliente.baixar(link, (s) => mudar({ fase: 'baixando', fracao: s.fracao, mensagem: s.mensagem || s.estado }));
        mudar({ fase: 'analisando', fracao: null, mensagem: tr('ts.analisando') });
        for (let k = 0; k < 2000 && d.painel.ocupado(); k++) {   // a biblioteca analisa uma fila por vez
          if (k === 0) mudar({ mensagem: tr('ts.esperando') });
          await espera(300);
        }
        const i = itens.findIndex((x) => x.caminho === item.caminho);
        if (i >= 0) itens.splice(i, 1, item); else itens.push(item);
        metas.set(item.caminho, item.meta);
        mudar({ mensagem: tr('ts.analisando') });
        await d.painel.adicionar({ nome: PASTA, itens: itens.slice() });
        const fx = aplicarMeta(d.painel.faixas(), metas).find((x) => x.caminho === item.caminho);
        if (!fx) throw erro('fora-da-biblioteca', tr('ts.fora-biblioteca'));
        if (fx.analisavel === false) throw erro('sem-analise', fx.erro ? tr('ts.sem-analise-erro', { titulo: fx.titulo, erro: fx.erro }) : tr('ts.sem-analise', { titulo: fx.titulo }));
        mudar({ fase: 'feito', ocupado: false, fracao: null, codigo: '', mensagem: tr('ts.feito', { titulo: fx.titulo, bpm: brNum(fx.bpm), camelot: fx.camelot }) });
      } catch (e) {
        const codigo = (e && e.codigo) || 'erro', mensagem = (e && (e.mensagem || e.message)) || String(e);
        if (codigo === 'servidor-fora') mudar({ fase: 'fora', noAr: false, ocupado: false, fracao: null, codigo, mensagem });
        else mudar({ fase: 'erro', ocupado: false, fracao: null, codigo, mensagem });
      }
      return estado();
    }

    return { iniciar, sondar, trazer, estado, vestir: (faixas) => aplicarMeta(faixas, metas) };
  }

  return { BASE, ORIGEM, ORIGEM_PUBLICADA, COMANDO, PASTA, TERMINAIS, ondeEstou, pedidoNaUrl, liberar, validarLink, validarRemoto, lerRemoto, idVideo, criar, criarFluxo, aplicarMeta };
});
