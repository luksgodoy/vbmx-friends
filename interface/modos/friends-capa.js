// VbMx Friends — a capa da faixa que toca, ao fundo da área "tocando agora". Sem DOM: a tela só recebe a URL.
//
// Cadeia de origem, na ordem (cada etapa que falha segue para a próxima; nunca lança, nunca bloqueia a UI):
//   1. capa embutida no arquivo (ID3 APIC v2.2/2.3/2.4, FLAC PICTURE, MP4 covr) — lida do próprio arquivo, sem rede;
//   2. miniatura do vídeo: GET <TrackSave>/capa?id=<videoId>  (só faixa trazida pelo plugin, que guarda o id do vídeo);
//   3. pesquisa por título+artista: GET <TrackSave>/capa?titulo=&artista=  (encodeURIComponent; prazo ~10 s);
//   4. imagem padrão Bauhaus (SVG em data URI: círculo, triângulo e quadrado nas primárias; sem rede).
// As etapas 2 e 3 SÓ rodam com a página em http://127.0.0.1:8770 (ondeEstou === 'local', a mesma regra do plugin
// TrackSave — nunca no GitHub Pages) e com o TrackSave no ar; a 3 ainda depende do interruptor "pesquisar capas".
// Privacidade: a etapa 3 manda título e artista à internet (o TrackSave pesquisa no YouTube). O que o usuário digitou
// NUNCA vai para log: este arquivo não chama nada de console, e o título/artista só viajam na query para 127.0.0.1:8771.
// Contrato do servidor (lido, não copiado): ~/TrackSave/docs/plugin-vbmx.md § "Capa por pesquisa".
// Teste: node interface/testar-friends-capa.js (TrackSave e fetch falsos; nenhuma rede).
//
// VbMxCapa:
//   CAPA_PADRAO                         → data URI do SVG padrão
//   extrairCapa(bytes)                  → {mime, bytes} | null     (ID3v2 no início de `bytes`)
//   lerCapaArquivo(arquivo)             → Promise<{mime, bytes} | null>   (File/Blob; ID3, FLAC, MP4; nunca rejeita)
//   urlCapa({base, id, titulo, artista}) → URL do /capa ou null
//   criar({fetch, onde, tsAtivo(), pesquisaLigada(), aoMudar({url, origem}), criarUrl(blob), revogarUrl(url),
//          criarBlob(bytes, mime), prazoMs, base, limiteCache}) → {pedir(faixa), refazer(), atual(), tamanhoCache(), limpar()}
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxCapa = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';

  const BASE = 'http://127.0.0.1:8771';
  const LIMITE_ARQUIVO = 8 * 1024 * 1024;     // cabeçalho com capa maior que isto não é lido (não trava a página)
  const LIMITE_MOOV = 16 * 1024 * 1024;
  const RX_VIDEO = /^[A-Za-z0-9_-]{11}$/;
  const MAX_TEXTO = 200;                      // o servidor recusa mais que isto (parametro-grande)

  // A imagem padrão: círculo azul, triângulo amarelo e quadrado vermelho sobre o preto do tema. Só formas, sem texto.
  const SVG_PADRAO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" preserveAspectRatio="xMidYMid slice">' +
    '<rect width="120" height="120" fill="#141414"/><circle cx="34" cy="38" r="22" fill="#1F4E9C"/>' +
    '<polygon points="62,96 102,96 82,56" fill="#F2B90F"/><rect x="74" y="12" width="30" height="30" fill="#D62818"/></svg>';
  const CAPA_PADRAO = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SVG_PADRAO);

  // ---------- imagem: o tipo sai dos bytes, não do que a tag declara ----------
  function mimeDe(b) {
    if (!b || b.length < 12) return null;
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return null;
  }
  const imagem = (bytes) => { const m = mimeDe(bytes); return m ? { mime: m, bytes } : null; };

  // ---------- ID3v2 ----------
  const sincr = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
  function desincronizar(b) {                  // FF 00 → FF
    const o = new Uint8Array(b.length); let n = 0;
    for (let i = 0; i < b.length; i++) { o[n++] = b[i]; if (b[i] === 0xFF && b[i + 1] === 0x00) i++; }
    return o.subarray(0, n);
  }
  // Pula `enc`-texto terminado em nulo (1 ou 2 bytes de nulo conforme a codificação); → índice logo depois do terminador.
  function depoisDoNulo(b, i, enc) {
    const larg = enc === 1 || enc === 2 ? 2 : 1;
    for (; i + larg <= b.length; i += larg) { if (b[i] === 0 && (larg === 1 || b[i + 1] === 0)) return i + larg; }
    return -1;
  }
  function dadosApic(q, v22) {                 // q = corpo do quadro; → bytes da imagem ou null
    if (q.length < 8) return null;
    const enc = q[0];
    let i = 1;
    if (v22) i += 3;                           // formato de 3 letras ("JPG", "PNG")
    else { i = depoisDoNulo(q, 1, 0); if (i < 0) return null; }   // tipo MIME (latin1)
    i += 1;                                    // tipo da imagem (capa, contracapa…)
    i = depoisDoNulo(q, i, enc);               // descrição
    if (i < 0 || i >= q.length) return null;
    return q.subarray(i);
  }
  function extrairCapa(bytes) {
    try {
      if (!bytes || bytes.length < 20 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
      const versao = bytes[3];
      if (versao < 2 || versao > 4) return null;
      let corpo = bytes.subarray(10, Math.min(bytes.length, 10 + sincr(bytes, 6)));
      const flags = bytes[5];
      if (versao < 4 && (flags & 0x80)) corpo = desincronizar(corpo);
      let i = 0;
      if (versao >= 3 && (flags & 0x40)) i = versao === 4 ? sincr(bytes, 10) : 4 + (((bytes[10] << 24) | (bytes[11] << 16) | (bytes[12] << 8) | bytes[13]) >>> 0);
      const idLen = versao === 2 ? 3 : 4, cab = versao === 2 ? 6 : 10;
      while (i + cab <= corpo.length) {
        if (corpo[i] === 0) break;
        let id = ''; for (let k = 0; k < idLen; k++) id += String.fromCharCode(corpo[i + k]);
        let tam;
        if (versao === 2) tam = (corpo[i + 3] << 16) | (corpo[i + 4] << 8) | corpo[i + 5];
        else if (versao === 3) tam = ((corpo[i + 4] << 24) | (corpo[i + 5] << 16) | (corpo[i + 6] << 8) | corpo[i + 7]) >>> 0;
        else tam = sincr(corpo, i + 4);
        const ini = i + cab;
        if (tam <= 0 || ini + tam > corpo.length) break;
        if (id === 'APIC' || id === 'PIC') {
          let q = corpo.subarray(ini, ini + tam);
          if (versao === 4 && ((flags & 0x80) || (corpo[i + 9] & 0x02))) q = desincronizar(q);
          const d = dadosApic(q, versao === 2);
          const r = d && imagem(d);
          if (r) return r;
        }
        i = ini + tam;
      }
    } catch (e) { /* tag quebrada: sem capa */ }
    return null;
  }

  // ---------- FLAC (bloco PICTURE) e MP4 (covr) ----------
  const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  async function fatia(arq, de, ate) { return new Uint8Array(await arq.slice(de, ate).arrayBuffer()); }

  async function capaFlac(arq) {
    let pos = 4;
    for (let n = 0; n < 64 && pos + 4 <= arq.size; n++) {
      const h = await fatia(arq, pos, pos + 4);
      const ultimo = (h[0] & 0x80) !== 0, tipo = h[0] & 0x7f, tam = (h[1] << 16) | (h[2] << 8) | h[3];
      if (tipo === 6 && tam <= LIMITE_ARQUIVO) {
        const b = await fatia(arq, pos + 4, pos + 4 + tam);
        let i = 4; const mlen = u32(b, i); i += 4 + mlen;
        const dlen = u32(b, i); i += 4 + dlen + 16;
        const n2 = u32(b, i); i += 4;
        const r = imagem(b.subarray(i, i + n2));
        if (r) return r;
      }
      if (ultimo) break;
      pos += 4 + tam;
    }
    return null;
  }
  function filhos(b, ini, fim, nome) {         // caixas MP4 em b[ini, fim) → a 1ª com esse nome: [conteúdoIni, conteúdoFim]
    let i = ini;
    while (i + 8 <= fim) {
      let tam = u32(b, i); const t = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      let cab = 8;
      if (tam === 1) { tam = u32(b, i + 12); cab = 16; } else if (tam === 0) tam = fim - i;
      if (tam < cab || i + tam > fim) return null;
      if (t === nome) return [i + cab, i + tam];
      i += tam;
    }
    return null;
  }
  async function capaMp4(arq) {
    let pos = 0;
    for (let n = 0; n < 64 && pos + 8 <= arq.size; n++) {
      const h = await fatia(arq, pos, pos + 16);
      let tam = u32(h, 0); const t = String.fromCharCode(h[4], h[5], h[6], h[7]);
      let cab = 8;
      if (tam === 1) { tam = u32(h, 12); cab = 16; } else if (tam === 0) tam = arq.size - pos;
      if (tam < cab) return null;
      if (t === 'moov') {
        if (tam > LIMITE_MOOV) return null;
        const m = await fatia(arq, pos, pos + tam);
        let r = filhos(m, cab, m.length, 'udta'); if (!r) return null;
        r = filhos(m, r[0], r[1], 'meta'); if (!r) return null;
        r = filhos(m, r[0] + 4, r[1], 'ilst'); if (!r) return null;     // meta tem 4 bytes de versão/flags
        r = filhos(m, r[0], r[1], 'covr'); if (!r) return null;
        r = filhos(m, r[0], r[1], 'data'); if (!r) return null;
        return imagem(m.subarray(r[0] + 8, r[1]));                       // 4 de tipo + 4 de local
      }
      pos += tam;
    }
    return null;
  }

  async function lerCapaArquivo(arq) {
    try {
      if (!arq || typeof arq.slice !== 'function' || !(arq.size >= 12)) return null;
      const cab = await fatia(arq, 0, 12);
      if (cab[0] === 0x49 && cab[1] === 0x44 && cab[2] === 0x33) {
        const total = 10 + sincr(cab, 6);
        if (total > LIMITE_ARQUIVO) return null;
        return extrairCapa(await fatia(arq, 0, total));
      }
      if (cab[0] === 0x66 && cab[1] === 0x4C && cab[2] === 0x61 && cab[3] === 0x43) return await capaFlac(arq);
      if (cab[4] === 0x66 && cab[5] === 0x74 && cab[6] === 0x79 && cab[7] === 0x70) return await capaMp4(arq);
    } catch (e) { /* arquivo estranho: segue a cadeia */ }
    return null;
  }

  // ---------- a rota do TrackSave ----------
  function urlCapa(o) {
    const base = String((o && o.base) || BASE).replace(/\/+$/, '');
    if (o && o.id) return RX_VIDEO.test(String(o.id)) ? `${base}/capa?id=${encodeURIComponent(String(o.id))}` : null;
    const titulo = String((o && o.titulo) || '').trim(), artista = String((o && o.artista) || '').trim();
    if (!titulo || titulo.length > MAX_TEXTO || artista.length > MAX_TEXTO) return null;
    return `${base}/capa?titulo=${encodeURIComponent(titulo)}` + (artista ? `&artista=${encodeURIComponent(artista)}` : '');
  }

  // ---------- o gerenciador ----------
  function criar(deps) {
    const d = deps || {};
    const f = d.fetch || (typeof raiz.fetch === 'function' ? raiz.fetch.bind(raiz) : null);
    const base = d.base || BASE;
    const prazoMs = d.prazoMs > 0 ? d.prazoMs : 10000;
    const limite = d.limiteCache > 0 ? d.limiteCache : 24;
    const criarUrl = d.criarUrl || ((b) => raiz.URL.createObjectURL(b));
    const revogarUrl = d.revogarUrl || ((u) => { try { raiz.URL.revokeObjectURL(u); } catch (e) { /* já revogada */ } });
    const criarBlob = d.criarBlob || ((bytes, mime) => new raiz.Blob([bytes], { type: mime }));
    const tsAtivo = typeof d.tsAtivo === 'function' ? d.tsAtivo : () => false;
    const pesquisaLigada = typeof d.pesquisaLigada === 'function' ? d.pesquisaLigada : () => true;
    const noLocal = () => d.onde === 'local';
    const cache = new Map();                   // chave da faixa → {url, origem}   (Map mantém a ordem: o mais antigo sai primeiro)
    let seq = 0, chaveAtual = null, faixaAtual = null, vista = { url: CAPA_PADRAO, origem: 'padrao' };

    const chave = (fx) => String(fx.caminho || fx.id);
    function mostrar(url, origem) {
      vista = { url, origem };
      if (typeof d.aoMudar === 'function') d.aoMudar({ url, origem });
    }
    function guardar(k, url, origem) {
      cache.delete(k); cache.set(k, { url, origem });
      while (cache.size > limite) {            // sai o mais antigo, que não é o que está na tela: revoga o object URL
        const [kk, v] = cache.entries().next().value;
        if (kk === chaveAtual) { cache.delete(kk); cache.set(kk, v); continue; }
        cache.delete(kk); if (v.url) revogarUrl(v.url);
      }
    }
    // GET <TrackSave>/capa…: → Blob | 'nada' (404: não há capa, vale lembrar) | null (rede, 5xx, prazo: tentar de novo depois)
    async function buscar(url) {
      if (!f || !url) return null;
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const t = ac ? setTimeout(() => ac.abort(), prazoMs) : null;
      try {
        const r = await f(url, { signal: ac ? ac.signal : undefined });
        if (r.status === 404) return 'nada';
        if (!r.ok) return null;
        const b = await r.blob();
        if (!b || !b.size || (b.type && !/^image\//.test(b.type))) return null;
        return b;
      } catch (e) { return null; }
      finally { if (t) clearTimeout(t); }
    }

    async function resolver(fx, minha) {
      const vivo = () => minha === seq;
      // 1. embutida
      try {
        if (typeof fx.obter === 'function') {
          const arq = await fx.obter();
          const im = await lerCapaArquivo(arq);
          if (!vivo()) return;
          if (im) { guardar(chave(fx), criarUrl(criarBlob(im.bytes, im.mime)), 'arquivo'); return mostrar(cache.get(chave(fx)).url, 'arquivo'); }
        }
      } catch (e) { /* sem leitura: segue */ }
      if (!vivo()) return;
      // 2 e 3: TrackSave (só em 127.0.0.1:8770 e com o servidor no ar)
      let lembrar = true;
      if (noLocal() && tsAtivo()) {
        const etapas = [];
        const vid = fx.video_id || fx.videoId;
        if (vid) etapas.push(urlCapa({ base, id: vid }));
        if (pesquisaLigada() && fx.titulo) etapas.push(urlCapa({ base, titulo: fx.titulo, artista: fx.artista }));
        else if (fx.titulo) lembrar = false;   // a pesquisa estava desligada: ligar depois deve poder tentar
        for (const u of etapas) {
          if (!u) continue;
          const r = await buscar(u);
          if (!vivo()) return;                  // resposta atrasada: a faixa já mudou, descarta (nada foi criado)
          if (r && r !== 'nada') { guardar(chave(fx), criarUrl(r), u.includes('?id=') ? 'miniatura' : 'pesquisa'); return mostrar(cache.get(chave(fx)).url, u.includes('?id=') ? 'miniatura' : 'pesquisa'); }
          if (r === null) lembrar = false;     // falha passageira: não grava "sem capa"
        }
      } else lembrar = false;
      if (!vivo()) return;
      if (lembrar) guardar(chave(fx), null, 'padrao');
      mostrar(CAPA_PADRAO, 'padrao');
    }

    // Mostra a padrão já e troca quando a capa chegar. Mesma faixa de novo (e já resolvida) não refaz nada.
    function pedir(fx) {
      if (!fx) { seq++; chaveAtual = null; faixaAtual = null; if (vista.origem !== 'padrao') mostrar(CAPA_PADRAO, 'padrao'); return; }
      const k = chave(fx);
      if (k === chaveAtual) return;
      seq++; chaveAtual = k; faixaAtual = fx;
      const c = cache.get(k);
      if (c) { guardar(k, c.url, c.origem); return mostrar(c.url || CAPA_PADRAO, c.url ? c.origem : 'padrao'); }
      mostrar(CAPA_PADRAO, 'padrao');
      resolver(fx, seq);
    }
    // O TrackSave ligou/desligou ou o interruptor mudou: tenta de novo a faixa que está na tela (se ainda sem capa real).
    function refazer() {
      if (!faixaAtual || vista.origem === 'arquivo' || vista.origem === 'miniatura') return;
      const fx = faixaAtual, k = chave(fx), c = cache.get(k);
      if (c && c.url) return;
      cache.delete(k); seq++;
      if (vista.origem !== 'padrao') mostrar(CAPA_PADRAO, 'padrao');
      resolver(fx, seq);
    }
    function limpar() { seq++; chaveAtual = null; faixaAtual = null; for (const v of cache.values()) if (v.url) revogarUrl(v.url); cache.clear(); mostrar(CAPA_PADRAO, 'padrao'); }

    return { pedir, refazer, limpar, atual: () => vista, tamanhoCache: () => cache.size };
  }

  return { CAPA_PADRAO, BASE, extrairCapa, lerCapaArquivo, urlCapa, criar };
});
