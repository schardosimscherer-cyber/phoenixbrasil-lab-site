// Publicador do Instagram da phoenixbrasil LAB (@phoenixbrasil.lab)
// Lê publicador/fila.json e publica pela API oficial (Graph API) só os itens com "aprovado": true
// cujo horário ("quando") já chegou e que ainda não foram publicados. Grava o resultado de volta na fila.
//
// Uso:  node publicador/publicar.js            → publica o que estiver vencido
//       node publicador/publicar.js --seco     → só confere (arquivos, links, token), não publica nada
//       node publicador/publicar.js --id X     → considera só o item X (continua exigindo aprovado)
// Ambiente: IG_TOKEN (obrigatório), IG_USER_ID (padrão @phoenixbrasil.lab), MIDIA_BASE (padrão https://lab.phoenixbrasil.com/)
// Regra da LAB: nada é publicado sem o "pode postar" do Alexandre → só então o item recebe "aprovado": true.

const fs = require("fs");
const path = require("path");

const API = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.IG_TOKEN;
const USER = process.env.IG_USER_ID || "17841466146509808";
const BASE = (process.env.MIDIA_BASE || "https://lab.phoenixbrasil.com/").replace(/\/?$/, "/");
const RAIZ = path.resolve(__dirname, "..");
const FILA = path.join(__dirname, "fila.json");
const args = process.argv.slice(2);
const SECO = args.includes("--seco");
const SO_ID = args.includes("--id") ? args[args.indexOf("--id") + 1] : null;
const MAX_TENTATIVAS = 3;

const espera = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function api(metodo, rota, params = {}) {
  const url = new URL(API + rota);
  const op = { method: metodo, headers: { Authorization: "Bearer " + TOKEN } };
  if (metodo === "GET") Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  else { op.headers["Content-Type"] = "application/json"; op.body = JSON.stringify(params); }
  const r = await fetch(url, op);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && (j.error.error_user_msg || j.error.message)) || "HTTP " + r.status);
  return j;
}

const ehVideo = f => /\.(mp4|mov)$/i.test(f);
const urlDe = f => BASE + f.split("/").map(encodeURIComponent).join("/");

async function linkNoAr(f) {
  try { const r = await fetch(urlDe(f), { method: "HEAD" }); return r.ok; } catch { return false; }
}

// Espera o container ficar pronto (vídeo demora; imagem é quase imediato)
async function aguardar(id) {
  for (let i = 0; i < 60; i++) {
    const s = await api("GET", "/" + id, { fields: "status_code,status" });
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error("container " + s.status_code + ": " + (s.status || ""));
    await espera(10000);
  }
  throw new Error("container demorou demais para ficar pronto");
}

async function container(item, f, extra = {}) {
  const p = { ...extra };
  if (item.tipo === "STORY") { p.media_type = "STORIES"; p[ehVideo(f) ? "video_url" : "image_url"] = urlDe(f); }
  else if (item.tipo === "REELS") {
    Object.assign(p, { media_type: "REELS", video_url: urlDe(f), share_to_feed: true });
    if (item.capa) p.cover_url = urlDe(item.capa);
  } else if (ehVideo(f)) { p.media_type = "VIDEO"; p.video_url = urlDe(f); }
  else p.image_url = urlDe(f);
  const { id } = await api("POST", "/" + USER + "/media", p);
  await aguardar(id);
  return id;
}

async function publicar(item) {
  const legenda = item.tipo === "STORY" ? {} : { caption: item.legenda || "" };
  let criacao;
  if (item.tipo === "CARROSSEL") {
    const filhos = [];
    for (const f of item.midia) filhos.push(await container({ tipo: "FILHO" }, f, { is_carousel_item: true }));
    const { id } = await api("POST", "/" + USER + "/media", { media_type: "CAROUSEL", children: filhos.join(","), ...legenda });
    await aguardar(id);
    criacao = id;
  } else criacao = await container(item, item.midia[0], legenda);
  const { id } = await api("POST", "/" + USER + "/media_publish", { creation_id: criacao });
  let permalink = null;
  try { permalink = (await api("GET", "/" + id, { fields: "permalink" })).permalink || null; } catch {}
  return { media_id: id, permalink };
}

function conferir(item) {
  const erros = [];
  if (!["STORY", "FEED", "CARROSSEL", "REELS"].includes(item.tipo)) erros.push("tipo inválido: " + item.tipo);
  if (!Array.isArray(item.midia) || !item.midia.length) erros.push("sem mídia");
  if (item.tipo === "CARROSSEL" && (item.midia.length < 2 || item.midia.length > 10)) erros.push("carrossel precisa de 2 a 10 mídias");
  if (item.tipo === "REELS" && !ehVideo(item.midia[0])) erros.push("Reels precisa de vídeo .mp4");
  for (const f of [...(item.midia || []), ...(item.capa ? [item.capa] : [])]) {
    if (!fs.existsSync(path.join(RAIZ, f))) erros.push("arquivo não está no repositório: " + f);
    if (/\.png$/i.test(f)) erros.push("a API só aceita JPG para imagem: " + f);
  }
  if (isNaN(Date.parse(item.quando))) erros.push("data inválida em 'quando'");
  return erros;
}

(async () => {
  if (!TOKEN) { console.error("Falta IG_TOKEN."); process.exit(1); }
  const fila = JSON.parse(fs.readFileSync(FILA, "utf8"));
  const agora = Date.now();
  let mudou = false, falhou = false;

  if (SECO) {
    const perfil = await api("GET", "/" + USER, { fields: "username,media_count" });
    const cota = await api("GET", "/" + USER + "/content_publishing_limit", { fields: "quota_usage,config" });
    log("token ok · @" + perfil.username + " · posts:", perfil.media_count, "· cota usada hoje:", cota.data[0].quota_usage, "de", cota.data[0].config.quota_total);
  }

  for (const item of fila.itens) {
    if (SO_ID && item.id !== SO_ID) continue;
    if (item.publicado) continue;
    const erros = conferir(item);
    const vencido = Date.parse(item.quando) <= agora;
    if (SECO) {
      const noAr = [];
      for (const f of item.midia || []) noAr.push((await linkNoAr(f)) ? "no ar" : "AINDA NÃO no ar");
      log(`[${item.id}] ${item.tipo} · ${item.quando} · aprovado=${!!item.aprovado} · ${vencido ? "horário já chegou" : "aguardando horário"}` +
          ` · links: ${noAr.join(", ")}` + (erros.length ? " · PROBLEMAS: " + erros.join("; ") : " · ok"));
      continue;
    }
    if (!item.aprovado || !vencido) continue;
    if ((item.erro?.tentativas || 0) >= MAX_TENTATIVAS) continue;
    if (erros.length) { item.erro = { em: new Date().toISOString(), msg: erros.join("; "), tentativas: MAX_TENTATIVAS }; mudou = falhou = true; log("[" + item.id + "] bloqueado:", item.erro.msg); continue; }
    const fora = [];
    for (const f of item.midia) if (!(await linkNoAr(f))) fora.push(f);
    if (fora.length) { log("[" + item.id + "] mídia ainda não está no ar, tenta na próxima rodada:", fora.join(", ")); continue; }
    try {
      log("[" + item.id + "] publicando " + item.tipo + "…");
      const r = await publicar(item);
      item.publicado = { em: new Date().toISOString(), ...r };
      delete item.erro;
      log("[" + item.id + "] PUBLICADO", r.permalink || r.media_id);
    } catch (e) {
      const t = (item.erro?.tentativas || 0) + 1;
      item.erro = { em: new Date().toISOString(), msg: String(e.message || e), tentativas: t };
      falhou = true;
      log("[" + item.id + "] ERRO (tentativa " + t + "):", item.erro.msg);
    }
    mudou = true;
  }

  if (mudou) fs.writeFileSync(FILA, JSON.stringify(fila, null, 2) + "\n");
  if (falhou) process.exitCode = 1;
})().catch(e => { console.error(e.message || e); process.exit(1); });
