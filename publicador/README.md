# Publicador do Instagram · phoenixbrasil LAB

- `publicador/fila.json`: o que vai ao ar. Só sai item com `"aprovado": true` (depois do "pode postar" do Alexandre) e `quando` vencido.
- `ig/`: mídias públicas (`https://lab.phoenixbrasil.com/ig/...`). Imagem **só em JPG**; vídeo MP4 H.264 com `+faststart`.
- `.github/workflows/instagram.yml`: roda de hora em hora (aos 7 min) e pelo botão "Run workflow" (com `id` e modo `seco`).
- Token: Secret `IG_TOKEN` do repositório (token de usuário do sistema, não expira). Conta: 17841466146509808.
- Rodar local: `IG_TOKEN=... node publicador/publicar.js --seco`.
- Tipos: `STORY` (sem adesivos: enquete e caixinha seguem manuais), `FEED`, `CARROSSEL` (2 a 10), `REELS` (`capa` opcional em JPG).
