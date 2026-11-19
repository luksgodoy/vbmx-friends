# VbMx Friends

Shuffle que mixa sozinho, no navegador, sem instalar nada. Abra o `index.html` publicado
(ou sirva a pasta com qualquer servidor estático).

- **As músicas ficam no seu aparelho**: nada é enviado. No iPad (Safari), use **Adicionar faixas** e escolha pelo app Arquivos.
- **Precisa de internet para a análise**: o BPM e o tom vêm do Essentia (carregado por CDN).
- **Plugin TrackSave (uso pessoal)**: só existe na máquina que abriu a página uma vez com `?tracksave=1` e tem o servidor TrackSave local ligado (`127.0.0.1:8771`); `?tracksave=0` desliga. Nas outras, a página não faz pedido nenhum à máquina. No celular, o link de `./tracksave.sh link` (túnel https do ngrok até o servidor do Mac, com chave) configura um servidor remoto neste navegador; "Esquecer servidor" apaga.
